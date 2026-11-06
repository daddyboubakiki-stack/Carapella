// カラモニ（index.html の parseMidi）で読み直す：最終確認はカラモニで行うので、カラモニにどう見えるかを確かめる。
// index.html は変えない。tests/extract.js で parseMidi だけを取り出して使う（このツールとは別に書かれた読み込み）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readSong, planLyricFill, fillLyrics } from '../src/lyric-fill.js';
import { carapellaMidi, rhythmFixture, runningFixture, meterFixture } from './helpers/fixtures.js';

const require = createRequire(import.meta.url);
const { parseMidi } = require('../../../tests/extract.js');

const cases = [
  { name: 'satb_sjis.mid', bytes: carapellaMidi('satb_sjis.mid'), opts: { source: 1, targets: [2, 3, 4] } },
  { name: '別リズム・既存歌詞混在', bytes: rhythmFixture(), opts: { source: 1, targets: [2, 3] } },
  { name: 'running status', bytes: runningFixture(), opts: { source: 1, targets: [2] } },
  { name: '拍子・テンポ変化', bytes: meterFixture(), opts: { source: 1, targets: [2], bars: { from: 3, to: 4 } } },
];

// カラモニの parts は「トラックの順・チャンネルの順」。1トラック1チャンネルのトラックは、そのパートに当たる
function partOfTrack(parsed, ti) {
  const ps = parsed.parts.filter((p) => p.track === ti);
  assert.equal(ps.length, 1, `track ${ti}`);
  return ps[0];
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

for (const c of cases) {
  test(`カラモニで読み直す：${c.name}`, () => {
    const { song, plan, output } = fillLyrics(c.bytes, c.opts);
    const before = parseMidi(c.bytes), after = parseMidi(output);
    // 曲名・テンポ・長さ・小節線・音符は同じ
    assert.equal(after.title, before.title);
    assert.equal(after.bpm, before.bpm);
    assert.equal(after.duration, before.duration);
    assert.deepEqual(after.bars, before.bars);
    assert.deepEqual(after.parts.map((p) => [p.name, p.track, p.ch, p.notes]), before.parts.map((p) => [p.name, p.track, p.ch, p.notes]));
    // 先パート以外の歌詞は同じ
    const targets = new Set(c.opts.targets);
    after.parts.forEach((p, i) => { if (!targets.has(p.track)) assert.deepEqual(p.lyrics, before.parts[i].lyrics, p.name); });
    // 元パートの歌詞：このツールの原本（tick 順）とカラモニの読み（時刻順）は1対1（テスト用MIDIでは空の歌詞がないので）
    const srcCar = partOfTrack(before, c.opts.source).lyrics;
    const srcOwn = song.tracks[c.opts.source].lyrics;
    assert.equal(srcCar.length, srcOwn.length);
    const srcAtTick = new Map(srcOwn.map((l, i) => [l.tick, srcCar[i]]));
    const sorted = (ls) => [...ls].sort((x, y) => x.t - y.t || (x.text < y.text ? -1 : 1));
    for (const ti of targets) {
      const a = partOfTrack(after, ti), b = partOfTrack(before, ti);
      const added = plan.edits.filter((e) => e.track === ti);
      // 先パートの歌詞（カラモニの読み）＝ 元の歌詞 ＋ 元パートの同じ tick の歌詞（同じ時刻・同じ文字）。過不足なし
      const expected = sorted([...b.lyrics, ...added.map((e) => srcAtTick.get(e.tick))]);
      assert.deepEqual(sorted(a.lyrics), expected, `track ${ti}`);
      // カラモニの表示：書き足した歌詞の時刻に、先パートの音が始まっている（音の下に表示される）
      for (const e of added) assert.ok(a.notes.some((n) => near(n.s, srcAtTick.get(e.tick).t)), `音の始まり ${e.text}`);
    }
    // トラック名はカラモニのパート名と同じ（利用者が同じ名前で選べる）
    for (const t of song.tracks.filter((x) => x.eligible)) assert.equal(partOfTrack(before, t.index).name, t.name);
  });
}

test('小節番号はカラモニの小節線と同じ数え方（拍子・テンポが変わる曲）', () => {
  for (const bytes of [meterFixture(), carapellaMidi('satb_sjis.mid'), rhythmFixture()]) {
    const song = readSong(bytes);
    const parsed = parseMidi(bytes);
    for (const t of song.tracks.filter((x) => x.eligible)) {
      const p = partOfTrack(parsed, t.index);
      t.notes.forEach((n, i) => {
        // カラモニで、その音の開始時刻までに始まった小節線の番号
        const bar = parsed.bars.filter((b) => b.t <= p.notes[i].s + 1e-9).pop().n;
        assert.equal(song.barOf(n.tick).bar, bar, `${t.name} ${i}`);
      });
    }
  }
});

test('既存歌詞の保護：カラモニで見ても、Third の「ドゥ」は1つのまま、1小節目は増えない', () => {
  const { output } = fillLyrics(rhythmFixture(), { source: 1, targets: [3] });
  const third = partOfTrack(parseMidi(output), 3);
  assert.deepEqual(third.lyrics.filter((l) => l.t < 2).map((l) => l.text), ['ドゥ']); // ♩=120 で1小節＝2秒
  assert.equal(third.lyrics.length, 7);
});

test('2回目：同じ指定でもう一度やっても、カラモニで見た歌詞は増えない', () => {
  const opts = { source: 1, targets: [2, 3, 4] };
  const once = fillLyrics(carapellaMidi('satb_sjis.mid'), opts).output;
  const song2 = readSong(once);
  assert.equal(planLyricFill(song2, opts).edits.length, 0);
  assert.deepEqual(parseMidi(fillLyrics(once, opts).output), parseMidi(once));
});
