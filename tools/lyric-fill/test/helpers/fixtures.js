// テストで使うMIDI。実際の曲は使わない（repoに入れない）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TPQ, E, utf8, sjis, track, part, conductor, smf, chunk } from './build.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CARAPELLA_MIDI_DIR = path.resolve(here, '../../../../tests/midi');
export const carapellaMidi = (name) => new Uint8Array(fs.readFileSync(path.join(CARAPELLA_MIDI_DIR, name)));

/**
 * 別リズム・メリスマ・休み・開始tickのずれ・既存歌詞のあるパート（4/4、四分音符 = 480 tick）
 *   [1] First  … 歌詞あり（UTF-8）。3小節目の2拍目は歌詞なし（メリスマ）、4拍目は休み
 *   [2] Second … 2小節目は付点2分で伸ばす、3小節目の3拍目は 60 tick 遅れて始まる、4拍目は First が休み、4小節目は休み
 *   [3] Third  … 1小節目の1拍目にだけ元から歌詞「ドゥ」（その小節は触らない）。2小節目からは First と同じリズム
 *   [4] Mixed  … 1トラックに ch4 と ch5（対象外）
 *   [5] Drums  … ch10 だけ（対象外）
 */
export function rhythmFixture() {
  const first = [
    [0, 1, 60, 'あ'], [1, 1, 62, 'い'], [2, 1, 64, 'う'], [3, 1, 65, 'え'],
    [4, 2, 67, 'お'], [6, 1, 65, 'か'], [7, 1, 64, 'き'],
    [8, 1, 62, 'く'], [9, 1, 64, null], [10, 1, 62, 'け'],
    [12, 4, 60, 'こ'],
  ];
  const second = [
    [0, 1, 55], [1, 1, 57], [2, 1, 59], [3, 1, 60],
    [4, 3, 62], [7, 1, 60],
    [8, 1, 59], [9, 1, 60], [10.125, 0.875, 59], [11, 1, 57],
  ];
  const third = [
    [0, 1, 48, 'ドゥ'], [1, 1, 50], [2, 1, 52], [3, 1, 53],
    [4, 2, 55], [6, 1, 53], [7, 1, 52],
    [8, 1, 50], [9, 1, 52], [10, 1, 50],
    [12, 4, 48],
  ];
  const mixed = track([
    { tick: 0, bytes: E.name(utf8('Mixed')) },
    { tick: 0, bytes: E.on(3, 40) }, { tick: 0, bytes: E.on(4, 43) },
    { tick: 4 * TPQ, bytes: E.off(3, 40) }, { tick: 4 * TPQ, bytes: E.off(4, 43) },
  ]);
  const drums = part('Drums', 9, [[0, 0.5, 36], [1, 0.5, 38], [2, 0.5, 36], [3, 0.5, 38]]);
  return smf([conductor({ title: 'リズム違い' }), part('First', 0, first), part('Second', 1, second), part('Third', 2, third), mixed, drums]);
}

/**
 * running status と、歌詞以外のいろいろなイベント・チャンク
 *   [1] Lead    … 歌詞あり（Shift_JIS）
 *   [2] Harmony … running status を使う（note off も note on velocity 0 で書く）。SysEx・音色・CC・ピッチベンド・
 *                 マーカー・テキスト・未知のメタ（FF 7F）・冗長な delta（0x80 0x00）・End of Track の後ろの1バイトを含む
 *   トラックの間に未知のチャンク「XFIH」
 *   mido 用に { forMido: true } で、未知のチャンクと End of Track の後ろの1バイトを外す（mido はどちらも読めない）
 */
export function runningFixture({ forMido = false } = {}) {
  const syl = ['ら', 'り', 'る', 'れ', 'ろ', 'わ', 'を', 'ん'];
  const lead = part('リード', 0, syl.map((s, i) => [i, 1, 67 + (i % 3), s]), { enc: sjis });
  const ch = 1, q = TPQ;
  const pitch = (i) => 60 + (i % 3);
  const evs = [
    { tick: 0, bytes: E.name(sjis('ハモリ')) },
    { tick: 0, bytes: E.sysex([0x7E, 0x7F, 0x09, 0x01]) },
    { tick: 0, bytes: E.program(ch, 52) },
    { tick: 0, bytes: E.cc(ch, 7, 100) },
    { tick: 0, bytes: E.marker(utf8('A')) },
  ];
  for (let i = 0; i < 8; i++) {
    const t = i * q;
    if (i) evs.push({ tick: t, bytes: E.off0(ch, pitch(i - 1)) });
    if (i === 2) evs.push({ tick: t, bytes: E.bend(ch, 0, 72) });
    if (i === 4) evs.push({ tick: t, bytes: E.cc(ch, 11, 90), rawDelta: [0x80, 0x00] }); // 0 を2バイトで書いた delta
    if (i === 6) evs.push({ tick: t, bytes: E.meta(0x7F, [0x00, 0x01, 0x02]) }, { tick: t, bytes: E.text(utf8('memo')) });
    evs.push({ tick: t, bytes: E.on(ch, pitch(i), 80) });
  }
  evs.push({ tick: 8 * q, bytes: E.off0(ch, pitch(7)) });
  const harmony = track(evs, { running: true, tail: forMido ? [] : [0x00] });
  const unknown = chunk('XFIH', [0x01, 0x02, 0x03, 0x04]);
  return smf([conductor({ title: 'ランニング', tempos: [[0, 96]] }), ...(forMido ? [] : [unknown]), lead, harmony]);
}

/**
 * 拍子とテンポが途中で変わる：4/4（1–2小節）→ 3/4（3–4小節）→ 6/8（5–6小節）、3小節目の2拍目で ♩=100 → 140
 * [1] Melody（歌詞あり） [2] Harmony（同じリズム・歌詞なし）
 */
export function meterFixture() {
  const kana = 'あいうえおかきくけこさしすせそたちつてと';
  const mel = [...kana].map((s, i) => [i, 1, 60 + (i % 5), s]);
  const har = mel.map(([b, d, m]) => [b, d, m - 5]);
  return smf([
    conductor({ title: 'meter', sigs: [[0, 4, 4], [8, 3, 4], [14, 6, 8]], tempos: [[0, 100], [9, 140]] }),
    part('Melody', 0, mel), part('Harmony', 1, har),
  ]);
}

/** 長い曲：600小節・4パート（同じリズム）・First の全部の音に歌詞 */
export function largeFixture() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF) / 0x7FFFFFFF);
  const notes = [];
  for (let b = 0; b < 600 * 4;) {
    const d = [0.5, 0.5, 1, 1, 2][Math.floor(rnd() * 5)];
    if (rnd() > 0.15) notes.push([b, d * 0.9, 60 + Math.floor(rnd() * 7)]);
    b += d;
  }
  const kana = 'らりるれろ';
  return smf([
    conductor({ title: 'large' }),
    part('First', 0, notes.map((n, i) => [...n, kana[i % 5]])),
    ...[1, 2, 3].map((ch) => part(`Part${ch + 1}`, ch, notes.map(([b, d, m]) => [b, d, m - 3 * ch]))),
  ]);
}

/** 対象外として止まるべきファイル */
export function rejectedFixtures() {
  const ok = [conductor(), part('A', 0, [[0, 1, 60, 'a']]), part('B', 1, [[0, 1, 55]])];
  return {
    format0: smf([part('all', 0, [[0, 1, 60, 'a']])], { format: 0 }),
    format_other: smf(ok, { format: 2 }),
    smpte: smf(ok, { division: 0xE728 }),
    kar: smf([track([{ tick: 0, bytes: E.text(utf8('@KMIDI KARAOKE FILE')) }]), ...ok.slice(1)]),
    bad_time_signature: smf([track([{ tick: 0, bytes: E.timesig(0, 4) }]), ...ok.slice(1)]),
    bad_running_status: smf([conductor(), chunk('MTrk', [0x00, 0x3C, 0x40, 0x00, 0xFF, 0x2F, 0x00])]),
    unsupported_event: smf([conductor(), chunk('MTrk', [0x00, 0xF1, 0x00, 0x00, 0xFF, 0x2F, 0x00])]),
    truncated_chunk: smf(ok).subarray(0, 60),
  };
}
