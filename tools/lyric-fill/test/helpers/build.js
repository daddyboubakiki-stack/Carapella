// テスト用のMIDIをバイト単位で組み立てる（running status の有無や delta の書き方まで指定できるように、ライブラリは使わない）

export const TPQ = 480;

export function vlq(v) {
  const a = [v & 0x7F];
  while ((v >>>= 7)) a.unshift((v & 0x7F) | 0x80);
  return a;
}
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

export const utf8 = (s) => [...new TextEncoder().encode(s)];

// Shift_JIS のバイト列（テストデータ用。TextDecoder から逆引き表を作る）
let sjisMap = null;
export function sjis(s) {
  if (!sjisMap) {
    sjisMap = new Map();
    const dec = new TextDecoder('shift_jis');
    for (let a = 0x81; a <= 0xFC; a++) {
      if (a >= 0xA0 && a < 0xE0) continue;
      for (let b = 0x40; b <= 0xFC; b++) {
        if (b === 0x7F) continue;
        const c = dec.decode(Uint8Array.of(a, b));
        if (c.length === 1 && c !== '�' && !sjisMap.has(c)) sjisMap.set(c, [a, b]);
      }
    }
  }
  return [...s].flatMap((c) => {
    if (c.charCodeAt(0) < 0x80) return [c.charCodeAt(0)];
    const b = sjisMap.get(c);
    if (!b) throw new Error(`Shift_JIS にない文字：${c}`);
    return b;
  });
}

export const E = {
  on: (ch, m, v = 90) => [0x90 | ch, m, v],
  off: (ch, m) => [0x80 | ch, m, 64],
  off0: (ch, m) => [0x90 | ch, m, 0], // velocity 0 の note on（note off として扱われる）
  cc: (ch, c, v) => [0xB0 | ch, c, v],
  program: (ch, p) => [0xC0 | ch, p],
  bend: (ch, lsb, msb) => [0xE0 | ch, lsb, msb],
  meta: (type, bytes) => [0xFF, type, ...vlq(bytes.length), ...bytes],
  name: (bytes) => E.meta(0x03, bytes),
  text: (bytes) => E.meta(0x01, bytes),
  lyric: (bytes) => E.meta(0x05, bytes),
  marker: (bytes) => E.meta(0x06, bytes),
  tempo: (bpm) => { const us = Math.round(60e6 / bpm); return E.meta(0x51, [(us >> 16) & 255, (us >> 8) & 255, us & 255]); },
  timesig: (num, den) => E.meta(0x58, [num, Math.log2(den), 24, 8]),
  sysex: (bytes) => [0xF0, ...vlq(bytes.length + 1), ...bytes, 0xF7],
  eot: () => [0xFF, 0x2F, 0x00],
};

export const chunk = (id, body) => [...id].map((c) => c.charCodeAt(0)).concat(u32(body.length), body);

/**
 * トラック（MTrk チャンク）を組み立てる。events は「ファイルに書く順」の [{ tick, bytes, rawDelta? }]。
 * running: true なら、直前と同じ status のチャンネルメッセージは status を省く（メタ・SysEx の後は省かない）
 * tail: End of Track の後ろに付けるバイト列
 */
export function track(events, { running = false, eot = true, tail = [] } = {}) {
  const all = eot ? [...events, { tick: events.length ? events[events.length - 1].tick : 0, bytes: E.eot() }] : events;
  const out = [];
  let last = 0, rs = 0;
  for (const e of all) {
    out.push(...(e.rawDelta || vlq(e.tick - last)));
    last = e.tick;
    const st = e.bytes[0];
    if (st < 0xF0) {
      out.push(...(running && st === rs ? e.bytes.slice(1) : e.bytes));
      rs = st;
    } else {
      out.push(...e.bytes);
      rs = 0;
    }
  }
  return chunk('MTrk', out.concat(tail));
}

/**
 * 1パート分のトラック。notes: [[開始の拍, 長さの拍, 音高, 歌詞?]]（拍は四分音符）
 * 同じ tick では「前の音の note off → 歌詞 → note on」の順（tests/make_midis.py と同じ）
 */
export function part(name, ch, notes, { enc = utf8, running = false, offAsOn0 = running, extra = [], lyricShift = 0 } = {}) {
  const evs = [{ tick: 0, bytes: E.name(enc(name)), o: -1 }, ...extra.map((e) => ({ ...e, o: e.o ?? -1 }))];
  for (const [s, d, m, ly] of notes) {
    const a = Math.round(s * TPQ), b = Math.round((s + d) * TPQ);
    evs.push({ tick: b, bytes: offAsOn0 ? E.off0(ch, m) : E.off(ch, m), o: 0 });
    if (ly != null) evs.push({ tick: a + lyricShift, bytes: E.lyric(typeof ly === 'string' ? enc(ly) : ly), o: 1 });
    evs.push({ tick: a, bytes: E.on(ch, m), o: 2 });
  }
  evs.sort((x, y) => x.tick - y.tick || x.o - y.o);
  return track(evs, { running });
}

/** 曲名・テンポ・拍子のトラック。sigs: [[拍, 分子, 分母]]、tempos: [[拍, bpm]] */
export function conductor({ title = 'test', enc = utf8, sigs = [[0, 4, 4]], tempos = [[0, 120]] } = {}) {
  const evs = [{ tick: 0, bytes: E.name(enc(title)) }];
  for (const [b, n, d] of sigs) evs.push({ tick: Math.round(b * TPQ), bytes: E.timesig(n, d) });
  for (const [b, bpm] of tempos) evs.push({ tick: Math.round(b * TPQ), bytes: E.tempo(bpm) });
  evs.sort((x, y) => x.tick - y.tick);
  return track(evs);
}

/** ファイル全体。chunks はトラック（または任意のチャンク）のバイト配列 */
export function smf(chunks, { format = 1, division = TPQ, ntrks } = {}) {
  const n = ntrks ?? chunks.filter((c) => c[0] === 0x4D && c[1] === 0x54 && c[2] === 0x72 && c[3] === 0x6B).length;
  const head = chunk('MThd', [0, format, (n >> 8) & 255, n & 255, (division >> 8) & 255, division & 255]);
  return Uint8Array.from(head.concat(...chunks));
}

/** RIFF(RMID) で包む */
export function rmid(bytes) {
  const le = (n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
  const data = [...'data'].map((c) => c.charCodeAt(0)).concat(le(bytes.length), [...bytes]);
  return Uint8Array.from([...'RIFF'].map((c) => c.charCodeAt(0)).concat(le(4 + data.length), [...'RMID'].map((c) => c.charCodeAt(0)), data));
}
