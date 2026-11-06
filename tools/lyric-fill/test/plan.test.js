// 候補づくり：tick がちょうど同じ所だけ。書けない所は小節番号と理由を区別して報告
import test from 'node:test';
import assert from 'node:assert/strict';
import { readSong, planLyricFill, lyricsAfter, LyricFillError } from '../src/lyric-fill.js';
import { formatPlan, formatTracks, describeError } from '../src/report.js';
import { carapellaMidi, rhythmFixture, meterFixture, rejectedFixtures } from './helpers/fixtures.js';
import { TPQ } from './helpers/build.js';

const brief = (xs) => xs.map((x) => [x.bar, x.beat, x.reason, ...(x.deltaTicks != null ? [x.deltaTicks] : [])]);

test('トラック一覧：対象にできるのは「1トラック1チャンネル」のパートだけ', () => {
  const song = readSong(rhythmFixture());
  assert.deepEqual(song.tracks.map((t) => [t.index, t.name, t.eligible, t.reason]), [
    [0, 'リズム違い', false, 'no_notes'],
    [1, 'First', true, null],
    [2, 'Second', true, null],
    [3, 'Third', true, null],
    [4, 'Mixed', false, 'multi_channel'],
    [5, 'Drums', false, 'drums_only'],
  ]);
  assert.equal(song.lastBar, 4);
  assert.match(formatTracks(song), /\[4\] Mixed … 対象外：1トラックに複数のチャンネル/);
});

test('別リズム：一致した所だけ書き、休み・伸ばし・開始tick不一致・元パートの歌詞なしを区別する', () => {
  const song = readSong(rhythmFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  const r = plan.report[0];
  assert.equal(r.added, 7);
  assert.deepEqual(plan.edits.map((e) => [e.bar, e.beat, e.text]), [
    [1, 1, 'あ'], [1, 2, 'い'], [1, 3, 'う'], [1, 4, 'え'], [2, 1, 'お'], [2, 4, 'き'], [3, 1, 'く'],
  ]);
  // 置けなかった元の歌詞
  assert.deepEqual(brief(r.unplacedLyrics), [
    [2, 3, 'target_sustain'], // 「か」：Second は付点2分で伸ばしている
    [3, 3, 'onset_mismatch', 60], // 「け」：Second は 60 tick 遅れて始まる
    [4, 1, 'target_rest'], // 「こ」：Second は休み
  ]);
  assert.deepEqual(r.unplacedLyrics.map((x) => x.text), ['か', 'け', 'こ']);
  // 歌詞が入らない Second の音
  assert.deepEqual(brief(r.unfilledNotes), [
    [3, 2, 'source_no_lyric'], // First はメリスマ（歌詞なしの音）
    [3, 3, 'onset_mismatch', -60],
    [3, 4, 'source_rest'], // First は休み
  ]);
  assert.deepEqual(r.protectedBars, []);
});

test('既存歌詞の保護：元から歌詞がある小節は丸ごと触らず、理由を「既存歌詞のある小節」として報告', () => {
  const song = readSong(rhythmFixture());
  const plan = planLyricFill(song, { source: 1, targets: [3] });
  const r = plan.report[0];
  assert.deepEqual(r.protectedBars, [1]);
  assert.deepEqual(plan.edits.map((e) => e.text), ['お', 'か', 'き', 'く', 'け', 'こ']);
  assert.deepEqual(brief(r.unplacedLyrics), [[1, 1, 'protected'], [1, 2, 'protected'], [1, 3, 'protected'], [1, 4, 'protected']]);
  assert.deepEqual(brief(r.unfilledNotes), [[3, 2, 'source_no_lyric']]);
  // 1小節目の歌詞のない音（メリスマかもしれない）には入れない
  assert.ok(plan.edits.every((e) => e.bar !== 1));
});

test('小節の範囲：選んだ小節の中だけ', () => {
  const song = readSong(rhythmFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2, 3], bars: { from: 2, to: 3 } });
  assert.ok(plan.edits.every((e) => e.bar >= 2 && e.bar <= 3));
  assert.deepEqual(plan.report.map((r) => r.added), [3, 5]);
  assert.deepEqual(plan.report[0].unplacedLyrics.map((x) => x.bar), [2, 3]); // 4小節目の「こ」は範囲外
  assert.deepEqual(plan.options.bars, { from: 2, to: 3 });
});

test('拍子とテンポが途中で変わっても、小節番号は拍子どおり（tick で数える）', () => {
  const song = readSong(meterFixture());
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  assert.equal(plan.edits.length, 20);
  // 4/4 が2小節（8拍）→ 3/4 が2小節（6拍）→ 6/8（1小節＝四分音符3つ分）
  const expectBar = (beat) => (beat < 8 ? Math.floor(beat / 4) + 1 : beat < 14 ? 3 + Math.floor((beat - 8) / 3) : 5 + Math.floor((beat - 14) / 3));
  assert.deepEqual(plan.edits.map((e) => e.bar), plan.edits.map((e) => expectBar(e.tick / TPQ)));
  const p34 = planLyricFill(song, { source: 1, targets: [2], bars: { from: 3, to: 4 } });
  assert.deepEqual(p34.edits.map((e) => e.tick / TPQ), [8, 9, 10, 11, 12, 13]);
});

test('Shift_JIS の歌詞は、文字に直さずバイト列のまま写す候補になる', () => {
  const song = readSong(carapellaMidi('satb_sjis.mid'));
  const plan = planLyricFill(song, { source: 1, targets: [2, 3, 4] });
  assert.deepEqual(plan.report.map((r) => r.added), [12, 12, 12]);
  const src = song.tracks[1].lyrics;
  for (const t of [2, 3, 4]) {
    const es = plan.edits.filter((e) => e.track === t);
    assert.deepEqual(es.map((e) => [...e.bytes]), src.map((l) => [...l.bytes]));
    assert.deepEqual(es.map((e) => e.from.lyricId), src.map((l) => l.id));
  }
  assert.equal(plan.edits[0].text, 'あ');
  assert.deepEqual([...plan.edits[0].bytes], [0x82, 0xA0]); // 「あ」の Shift_JIS
});

test('原本と編集は分かれている：原本は変更できず、候補を作っても変わらない', () => {
  const input = rhythmFixture();
  const song = readSong(input);
  const before = JSON.stringify(song, (k, v) => (ArrayBuffer.isView(v) ? [...v] : v));
  const plan = planLyricFill(song, { source: 1, targets: [2, 3] });
  assert.equal(JSON.stringify(song, (k, v) => (ArrayBuffer.isView(v) ? [...v] : v)), before);
  assert.ok(Object.isFrozen(song) && Object.isFrozen(song.tracks[1].lyrics) && Object.isFrozen(song.tracks[1].lyrics[0]));
  assert.throws(() => { song.tracks[1].lyrics.push({}); });
  // 編集の歌詞は原本のコピー（同じメモリではない）
  plan.edits[0].bytes[0] = 0x21;
  assert.notEqual(song.tracks[1].lyrics[0].bytes[0], 0x21);
  // 入力の配列を後で書き換えても、原本は変わらない
  input.fill(0);
  assert.equal(song.tracks[1].lyrics[0].text, 'あ');
  // 原本＋編集の見え方（プレビュー用）
  const view = lyricsAfter(song, plan.edits, 3);
  assert.deepEqual(view.map((x) => [x.text, x.origin]).slice(0, 3), [['ドゥ', 'original'], ['お', 'copy'], ['か', 'copy']]);
});

test('人が選ぶ前提：元・先・範囲の指定が正しくなければ止まる', () => {
  const song = readSong(rhythmFixture());
  const code = (opts) => { try { planLyricFill(song, opts); return 'ok'; } catch (e) { assert.ok(e instanceof LyricFillError); return e.code; } };
  assert.equal(code({ source: 1, targets: [] }), 'no_targets');
  assert.equal(code({ source: 1, targets: [1] }), 'target_is_source');
  assert.equal(code({ source: 1, targets: [2, 2] }), 'duplicate_target');
  assert.equal(code({ source: 1, targets: [4] }), 'track_not_eligible');
  assert.equal(code({ source: 5, targets: [2] }), 'track_not_eligible');
  assert.equal(code({ source: 1, targets: [9] }), 'no_such_track');
  assert.equal(code({ source: 1, targets: [2], bars: { from: 3, to: 2 } }), 'bad_bars');
  assert.equal(code({ source: 1, targets: [2], bars: { from: 0, to: 2 } }), 'bad_bars');
});

test('対象外のファイルは、理由をつけて止まる', () => {
  for (const [expected, bytes] of Object.entries(rejectedFixtures())) {
    const want = expected === 'truncated_chunk' ? 'truncated' : expected;
    assert.throws(() => readSong(bytes), (e) => e.code === want, expected);
  }
  for (const [f, want] of [['format0_4ch.mid', 'format0'], ['wrapped.rmi', 'format0'], ['karaoke.kar', 'kar'], ['not_midi.mid', 'not_midi'], ['truncated.mid', 'truncated']]) {
    assert.throws(() => readSong(carapellaMidi(f)), (e) => e.code === want, f);
  }
  try { readSong(carapellaMidi('format0_4ch.mid')); } catch (e) { assert.match(describeError(e), /format 0/); }
});

test('報告の文：小節・拍・歌詞・理由が読める', () => {
  const song = readSong(rhythmFixture());
  const text = formatPlan(song, planLyricFill(song, { source: 1, targets: [2, 3] }));
  assert.match(text, /■ \[2\] Second：書き足す歌詞 7/);
  assert.match(text, /2小節3拍「か」　先パートは前の音を伸ばしている/);
  assert.match(text, /3小節3拍「け」　開始tickが違う.*（\+60 tick）/);
  assert.match(text, /4小節1拍「こ」　先パートは休み/);
  assert.match(text, /3小節2拍　元パートの音に歌詞がない/);
  assert.match(text, /既存の歌詞がある小節（触らない）：1/);
});

test('珍しい形：元パートの同じ位置に歌詞が2つ → 書かずに理由を報告／先パートの和音 → 始まりに1つだけ', async () => {
  const { smf, conductor, track, part, E, utf8 } = await import('./helpers/build.js');
  const { applyEdits, verifyOutput } = await import('../src/lyric-fill.js');
  const src = track([
    { tick: 0, bytes: E.name(utf8('Src')) },
    { tick: 0, bytes: E.lyric(utf8('ア')) }, { tick: 0, bytes: E.lyric(utf8('イ')) }, { tick: 0, bytes: E.on(0, 60) },
    { tick: TPQ, bytes: E.off(0, 60) }, { tick: TPQ, bytes: E.lyric(utf8('ウ')) }, { tick: TPQ, bytes: E.on(0, 62) },
    { tick: 2 * TPQ, bytes: E.off(0, 62) },
  ]);
  const chord = part('Chord', 1, [[0, 1, 55], [1, 1, 57], [1, 1, 52]]); // 2拍目は2音の和音
  const song = readSong(smf([conductor(), src, chord]));
  const plan = planLyricFill(song, { source: 1, targets: [2] });
  assert.deepEqual(plan.edits.map((e) => [e.tick, e.text]), [[TPQ, 'ウ']]);
  assert.deepEqual(brief(plan.report[0].unplacedLyrics), [[1, 1, 'source_multi']]);
  assert.equal(plan.report[0].unplacedLyrics[0].text, 'ア / イ');
  assert.deepEqual(brief(plan.report[0].unfilledNotes), [[1, 1, 'source_multi']]);
  const out = applyEdits(song, plan.edits);
  assert.equal(verifyOutput(song, out, plan.edits).ok, true);
  assert.equal(readSong(out).tracks[2].lyrics.length, 1);
});
