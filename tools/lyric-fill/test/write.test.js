// 書き出し：変えないトラックはバイト単位で同じ、変えたトラックは書き足した歌詞を除いて元と同じ、
// running status・文字コードを壊さない、2回目は何も増えない
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSmf, isMeta, encodeTrack, writeSmf } from '../src/smf.js';
import { readSong, planLyricFill, applyEdits, verifyOutput, fillLyrics, LyricFillError } from '../src/lyric-fill.js';
import { carapellaMidi, rhythmFixture, runningFixture, meterFixture, largeFixture } from './helpers/fixtures.js';
import { rmid } from './helpers/build.js';

const cases = [
  { name: 'satb_sjis.mid（Firstのみ・Shift_JIS・テンポ変化・3/4）', bytes: carapellaMidi('satb_sjis.mid'), opts: { source: 1, targets: [2, 3, 4] } },
  { name: '別リズム・既存歌詞混在', bytes: rhythmFixture(), opts: { source: 1, targets: [2, 3] } },
  { name: 'running status・いろいろなイベント', bytes: runningFixture(), opts: { source: 1, targets: [2] } },
  { name: '拍子・テンポ変化（3〜4小節だけ）', bytes: meterFixture(), opts: { source: 1, targets: [2], bars: { from: 3, to: 4 } } },
];

// テスト側で独立に照らす：歌詞イベントを「tick と中身」で数える
const key = (ev) => `${ev.tick}|${ev.status}|${[...ev.body.subarray(ev.running ? 0 : 1)].join(',')}`;

for (const c of cases) {
  test(`書き出しの約束：${c.name}`, () => {
    const song = readSong(c.bytes);
    const plan = planLyricFill(song, c.opts);
    assert.ok(plan.edits.length > 0);
    const out = applyEdits(song, plan.edits);

    // 自己確認（画面からの保存前にも使う）
    assert.deepEqual(verifyOutput(song, out, plan.edits), { ok: true, problems: [] });

    const a = readSmf(c.bytes), b = readSmf(out);
    const changed = new Set(plan.edits.map((e) => e.track));
    assert.equal(b.chunks.length, a.chunks.length);
    a.chunks.forEach((ca, i) => {
      const cb = b.chunks[i];
      if (!ca.track || !changed.has(ca.track.index)) {
        // ヘッダ・変えないトラック・未知のチャンクは、バイト単位で同じ
        assert.deepEqual(cb.raw, ca.raw, `chunk ${i}`);
        return;
      }
      const ti = ca.track.index;
      const added = plan.edits.filter((e) => e.track === ti);
      const addedKeys = new Set(added.map((e) => `${e.tick}|${[...e.bytes].join(',')}`));
      // 書き足した歌詞を除くと、元のイベント列（tick・status・中身）と同じ
      const rest = cb.track.events.filter((ev) => !(isMeta(ev, 0x05) && addedKeys.has(`${ev.tick}|${[...ev.data].join(',')}`)));
      assert.equal(rest.length, ca.track.events.length, `track ${ti}`);
      assert.deepEqual(rest.map(key), ca.track.events.map(key), `track ${ti}`);
      // 歌詞の数＝元＋書き足した数、同じ位置の重複なし
      const lyr = cb.track.events.filter((ev) => isMeta(ev, 0x05));
      assert.equal(lyr.length, ca.track.events.filter((ev) => isMeta(ev, 0x05)).length + added.length);
      assert.equal(new Set(lyr.map((ev) => ev.tick)).size, lyr.length);
      // 元からある歌詞は、そのまま
      for (const ev of ca.track.events.filter((x) => isMeta(x, 0x05))) assert.ok(lyr.some((x) => x.tick === ev.tick && Buffer.compare(Buffer.from(x.data), Buffer.from(ev.data)) === 0));
      // 書き足した歌詞の直後は、そのパートの音の始まり
      cb.track.events.forEach((ev, k) => {
        if (isMeta(ev, 0x05) && addedKeys.has(`${ev.tick}|${[...ev.data].join(',')}`)) {
          const next = cb.track.events[k + 1];
          assert.ok(next.tick === ev.tick && (next.status & 0xF0) === 0x90 && next.d2 > 0, `track ${ti} tick ${ev.tick}`);
        }
      });
      // running status：書き足した位置の直後のイベント以外は、元と同じ使い方
      const afterInsert = new Set();
      cb.track.events.forEach((ev, k) => { if (isMeta(ev, 0x05) && addedKeys.has(`${ev.tick}|${[...ev.data].join(',')}`)) afterInsert.add(cb.track.events[k + 1]); });
      rest.forEach((ev, k) => assert.equal(ev.running, afterInsert.has(ev) ? false : ca.track.events[k].running, `track ${ti} event ${k}`));
      assert.deepEqual(cb.track.tail, ca.track.tail);
    });
    assert.deepEqual(b.trailing, a.trailing);

    // 2回目：同じ指定でもう一度やっても、何も増えない（冪等）
    const song2 = readSong(out);
    const plan2 = planLyricFill(song2, c.opts);
    assert.equal(plan2.edits.length, 0);
    assert.deepEqual(applyEdits(song2, plan2.edits), out);
  });
}

test('running status：歌詞を入れた直後の音だけ status を書き、ほかは省いたまま', () => {
  const song = readSong(runningFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  assert.equal(plan.edits.length, 8);
  const before = readSmf(runningFixture()).tracks[2].events;
  const after = readSmf(applyEdits(song, plan.edits)).tracks[2].events;
  const count = (evs) => evs.filter((e) => e.running).length;
  // 歌詞を入れた8か所のうち、元が running status だった音の数だけ減る
  const lostRunning = plan.edits.filter((e) => before.find((ev) => ev.tick === e.tick && (ev.status & 0xF0) === 0x90 && ev.d2 > 0).running).length;
  assert.ok(lostRunning >= 4, `元で running status だった音 ${lostRunning}`);
  assert.equal(count(after), count(before) - lostRunning);
  // 冗長な delta（0x80 0x00）も、そのまま
  assert.ok(after.some((e) => e.delta.length === 2 && e.delta[0] === 0x80));
});

test('文字コード：写した歌詞は元のバイト列と同じ（Shift_JIS・UTF-8）', () => {
  for (const [bytes, src, tgt] of [[carapellaMidi('satb_sjis.mid'), 1, 2], [rhythmFixture(), 1, 2], [runningFixture(), 1, 2]]) {
    const { output, plan } = fillLyrics(bytes, { source: src, targets: [tgt] });
    const srcLyr = readSmf(bytes).tracks[src].events.filter((e) => isMeta(e, 0x05));
    const outLyr = readSmf(output).tracks[tgt].events.filter((e) => isMeta(e, 0x05));
    for (const e of plan.edits) {
      const s = srcLyr.find((x) => x.tick === e.tick);
      const o = outLyr.find((x) => x.tick === e.tick);
      assert.deepEqual([...o.data], [...s.data]);
    }
  }
});

test('RIFF(RMID) の format 1 は、普通の .mid として書き出す（中身は包まないものと同じ）', () => {
  const plain = carapellaMidi('satb_sjis.mid');
  const opts = { source: 1, targets: [2] };
  assert.deepEqual(fillLyrics(rmid(plain), opts).output, fillLyrics(plain, opts).output);
});

test('書き出し側の安全装置：重複・音のない位置・未対応の編集は書かない', () => {
  const song = readSong(rhythmFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  const e0 = plan.edits[0];
  const code = (edits) => { try { applyEdits(song, edits); return 'ok'; } catch (e) { assert.ok(e instanceof LyricFillError); return e.code; } };
  assert.equal(code([e0, e0]), 'duplicate_edit');
  assert.equal(code([{ ...e0, tick: e0.tick + 1 }]), 'no_note_at_tick');
  assert.equal(code([{ ...e0, track: 3, tick: 0 }]), 'lyric_exists'); // Third の「ドゥ」の位置
  assert.equal(code([{ ...e0, op: 'replace' }]), 'unsupported_edit');
  assert.equal(code([{ ...e0, track: 4 }]), 'track_not_eligible');
  assert.equal(code([{ ...e0, bytes: 'あ' }]), 'bad_edit');
  assert.equal(code([]), 'ok');
});

test('自己確認は、壊れた書き出しを見逃さない', () => {
  const song = readSong(runningFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  const good = applyEdits(song, plan.edits);
  const out = readSmf(good); // good の中を指す（subarray）ので、byteOffset がそのまま good の中の位置
  const offsetOf = (view) => view.byteOffset - good.byteOffset;
  const mutate = (f) => { const b = good.slice(); f(b); return verifyOutput(song, b, plan.edits); };
  // 変えないトラック（Lead）の最初の音の velocity を変える
  const leadOn = out.tracks[1].events.find((e) => (e.status & 0xF0) === 0x90 && e.d2 > 0);
  let r = mutate((b) => { b[offsetOf(leadOn.body) + 2] ^= 1; });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /トラック1（変えないトラック）/);
  // 変えたトラック（Harmony）の音の高さを変える
  const harmonyOn = out.tracks[2].events.filter((e) => (e.status & 0xF0) === 0x90 && e.d2 > 0)[3];
  r = mutate((b) => { b[offsetOf(harmonyOn.body) + (harmonyOn.running ? 0 : 1)] ^= 1; });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /トラック2: .*変わった/);
  // 編集の一覧と書き出しが合わない（1つ書き足していないことにする）
  r = verifyOutput(song, good, plan.edits.slice(1));
  assert.equal(r.ok, false);
  // 書き足すはずの歌詞がない
  r = verifyOutput(song, applyEdits(song, plan.edits.slice(1)), plan.edits);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /書き足すはずの歌詞がない|変わった/);
  // 未知のチャンク（XFIH）の中身を書き換える
  const xfih = out.chunks.find((c) => c.id === 'XFIH');
  r = mutate((b) => { b[offsetOf(xfih.raw) + 8] ^= 0xFF; });
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /XFIHチャンク/);
  // 読めないバイト列
  assert.equal(verifyOutput(song, good.subarray(0, 30), plan.edits).ok, false);
});

test('自己確認は、running status をやめた書き出し（意味は同じ）も「約束違反」として見つける', () => {
  const song = readSong(runningFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  const good = readSmf(applyEdits(song, plan.edits));
  // Harmony のすべてのチャンネルメッセージに status を書いた版を作る
  const h = good.tracks[2];
  const evs = h.events.map((e) => (e.running ? { ...e, running: false, body: Uint8Array.of(e.status, ...e.body) } : e));
  const chunkBytes = encodeTrack({ ...h, events: evs }, new Map());
  const explicit = writeSmf(good, new Map([[2, chunkBytes]]));
  assert.notEqual(explicit.length, good.bytes.length);
  // カラモニの読み込みでは同じ音になる（意味は同じ）が、約束（running status を壊さない）には反する
  const r = verifyOutput(song, explicit, plan.edits);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(), /running status/);
});

test('長い曲（600小節・4パート）でも、すぐ終わる', () => {
  const bytes = largeFixture();
  const t0 = performance.now();
  const { plan, output } = fillLyrics(bytes, { source: 1, targets: [2, 3, 4] });
  const ms = performance.now() - t0;
  const n = readSong(bytes).tracks[1].lyrics.length;
  assert.ok(n > 1500, `歌詞 ${n}`);
  assert.deepEqual(plan.report.map((r) => r.added), [n, n, n]);
  assert.ok(output.length > bytes.length);
  assert.ok(ms < 3000, `${ms.toFixed(0)} ms`);
  console.log(`  長い曲：歌詞 ${n} × 3パート、読む〜確かめるまで ${ms.toFixed(0)} ms（この環境のNode）`);
});
