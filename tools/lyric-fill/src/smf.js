// 標準MIDIファイル（SMF）の低レベルな読み書き。
//
// 方針：元のバイト列を捨てない。
// - 読むときは、各イベントの「ファイル上のバイト列」（delta と本体）をそのまま覚えておく
// - 書くときは、変えたトラックだけを組み直し、ほかのチャンクはバイト列をそのままコピーする
// - 変えたトラックでも、挿入した位置の直後のイベント以外は、元のバイト列をそのまま並べる
//
// ブラウザ（<script type="module">）と Node のどちらでも、ビルドなしで動く。外部ライブラリなし。

export class SmfError extends Error {
  constructor(code, detail) {
    super(detail ? `${code} (${detail})` : code);
    this.name = 'SmfError';
    this.code = code;
  }
}

const tag = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
const u32 = (u8, p) => ((u8[p] << 24) | (u8[p + 1] << 16) | (u8[p + 2] << 8) | u8[p + 3]) >>> 0;
const u32le = (u8, p) => (u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16) | (u8[p + 3] << 24)) >>> 0;
const u16 = (u8, p) => (u8[p] << 8) | u8[p + 1];

/** 可変長数値（VLQ）のバイト列 */
export function vlqBytes(v) {
  if (!(Number.isInteger(v) && v >= 0 && v <= 0x0FFFFFFF)) throw new SmfError('bad_vlq', String(v));
  const a = [v & 0x7F];
  while ((v >>>= 7)) a.unshift((v & 0x7F) | 0x80);
  return Uint8Array.from(a);
}

/** メタイベント本体（FF type len data） */
export function metaEventBytes(type, data) {
  return concat([Uint8Array.of(0xFF, type), vlqBytes(data.length), data]);
}

export function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** RIFF(RMID) の包みを外し、MThd から始まる SMF の部分を返す */
function locateSmf(u8) {
  if (u8.length >= 12 && tag(u8, 0) === 'RIFF' && tag(u8, 8) === 'RMID') {
    for (let p = 12; p + 8 <= u8.length;) {
      const len = u32le(u8, p + 4);
      if (tag(u8, p) === 'data') {
        if (p + 8 + len > u8.length) throw new SmfError('truncated', 'RIFF data');
        return locateSmf(u8.subarray(p + 8, p + 8 + len));
      }
      p += 8 + len + (len & 1);
    }
    throw new SmfError('not_midi');
  }
  // カラモニの読み込みと同じく、先頭 4096 バイトまでに MThd を探す
  for (let i = 0; i + 14 <= Math.min(u8.length, 4096); i++) {
    if (u8[i] === 0x4D && tag(u8, i) === 'MThd') return u8.subarray(i);
  }
  throw new SmfError('not_midi');
}

/**
 * SMF を読む。壊れたファイルは直さずにエラーにする（書き出しの元にしないため）。
 * 戻り値の chunks[i].raw は元のバイト列そのもの（subarray）。
 */
export function readSmf(input) {
  const u8 = locateSmf(input instanceof Uint8Array ? input : new Uint8Array(input));
  const hlen = u32(u8, 4);
  if (hlen < 6 || 8 + hlen > u8.length) throw new SmfError('truncated', 'MThd');
  const header = { format: u16(u8, 8), ntrks: u16(u8, 10), division: u16(u8, 12) };
  const chunks = [];
  const tracks = [];
  let p = 0;
  while (p + 8 <= u8.length) {
    const id = tag(u8, p);
    const len = u32(u8, p + 4);
    if (p + 8 + len > u8.length) throw new SmfError('truncated', `${id} @${p}`);
    const chunk = { id, raw: u8.subarray(p, p + 8 + len) };
    if (id === 'MTrk') {
      chunk.track = readTrack(u8.subarray(p + 8, p + 8 + len), tracks.length);
      tracks.push(chunk.track);
    }
    chunks.push(chunk);
    p += 8 + len;
  }
  // ヘッダのトラック数より少ない＝後ろが切れている（書き出しの元にはしない）
  if (tracks.length < header.ntrks) throw new SmfError('truncated', `MTrk ${tracks.length}/${header.ntrks}`);
  return { bytes: u8, header, chunks, tracks, trailing: u8.subarray(p) };
}

/**
 * トラックをイベントに分ける。各イベント：
 *   tick    曲の頭からの位置
 *   delta   ファイル上の delta time のバイト列
 *   body    ファイル上の本体のバイト列（running status を使っていれば status を含まない）
 *   status  実際の status（running status を使っていても補った値）
 *   running status を省いていたか
 *   ch, d1, d2（チャンネルメッセージ） / metaType, data（メタ） / data（SysEx）
 */
function readTrack(body, index) {
  const end = body.length;
  const events = [];
  let q = 0, tick = 0, running = 0, hasEndOfTrack = false;
  const need = (n) => { if (q + n > end) throw new SmfError('truncated', `track ${index} tick ${tick}`); };
  const vlq = () => {
    let v = 0;
    for (let n = 0; n < 4; n++) {
      need(1);
      const b = body[q++];
      v = v * 128 + (b & 0x7F);
      if (!(b & 0x80)) return v;
    }
    throw new SmfError('bad_vlq', `track ${index} tick ${tick}`);
  };
  while (q < end) {
    const d0 = q;
    tick += vlq();
    const s0 = q;
    need(1);
    let status = body[q];
    let usesRunning = false;
    if (status & 0x80) q++;
    else {
      // SMF の決まり：メタイベントと SysEx の後は running status が切れる
      if (!running) throw new SmfError('bad_running_status', `track ${index} tick ${tick}`);
      status = running;
      usesRunning = true;
    }
    const ev = { tick, delta: body.subarray(d0, s0), body: null, status, running: usesRunning };
    if (status === 0xFF) {
      running = 0;
      need(1);
      ev.metaType = body[q++];
      const len = vlq();
      need(len);
      ev.data = body.subarray(q, q + len);
      q += len;
    } else if (status === 0xF0 || status === 0xF7) {
      running = 0;
      const len = vlq();
      need(len);
      ev.data = body.subarray(q, q + len);
      q += len;
    } else if (status >= 0xF0) {
      throw new SmfError('unsupported_event', `0x${status.toString(16)} track ${index} tick ${tick}`);
    } else {
      running = status;
      const n = (status & 0xE0) === 0xC0 ? 1 : 2; // 0xC0（音色）と 0xD0 はデータ1バイト
      need(n);
      for (let i = 0; i < n; i++) if (body[q + i] & 0x80) throw new SmfError('bad_data', `track ${index} tick ${tick}`);
      ev.ch = status & 0x0F;
      ev.d1 = body[q];
      ev.d2 = n === 2 ? body[q + 1] : 0;
      q += n;
    }
    ev.body = body.subarray(s0, q);
    events.push(ev);
    if (status === 0xFF && ev.metaType === 0x2F) { hasEndOfTrack = true; break; }
  }
  // End of Track の後ろに何か残っていれば、それもそのまま持っておく
  return { index, events, tail: body.subarray(q), hasEndOfTrack, endTick: tick };
}

export const isNoteOn = (ev) => ev.status < 0xF0 && (ev.status & 0xF0) === 0x90 && ev.d2 > 0;
export const isNoteOff = (ev) => ev.status < 0xF0 && ((ev.status & 0xF0) === 0x80 || ((ev.status & 0xF0) === 0x90 && ev.d2 === 0));
export const isMeta = (ev, type) => ev.status === 0xFF && ev.metaType === type;

const ZERO = Uint8Array.of(0);

/**
 * トラックを組み直して MTrk チャンクのバイト列を返す。
 * inserts: Map<イベント番号, Uint8Array[]> … そのイベントの「直前・同じ tick」に入れるイベント本体（delta を除く）
 *
 * 入れた位置では：
 * - 入れるイベントが、元のイベントの delta のバイト列を引き継ぐ（時刻は変わらない）
 * - 元のイベントの delta は 0 になる
 * - 元のイベントが running status を使っていたら status を補う（メタイベントで running status が切れるため）
 * それ以外のイベントは、元のバイト列をそのまま並べる。
 */
export function encodeTrack(track, inserts) {
  const parts = [];
  track.events.forEach((ev, i) => {
    const add = inserts.get(i);
    if (add && add.length) {
      parts.push(ev.delta);
      add.forEach((b, k) => { if (k) parts.push(ZERO); parts.push(b); });
      parts.push(ZERO);
      if (ev.running) parts.push(Uint8Array.of(ev.status));
      parts.push(ev.body);
    } else {
      parts.push(ev.delta, ev.body);
    }
  });
  parts.push(track.tail);
  const body = concat(parts);
  const head = Uint8Array.of(0x4D, 0x54, 0x72, 0x6B, body.length >>> 24, (body.length >>> 16) & 0xFF, (body.length >>> 8) & 0xFF, body.length & 0xFF);
  return concat([head, body]);
}

/**
 * ファイル全体を書く。replaced: Map<トラック番号, MTrk チャンクのバイト列>
 * 置き換えないチャンク（ヘッダ・ほかのトラック・未知のチャンク）は元のバイト列をそのまま使う。
 * RIFF(RMID) の包みは外し、MThd から始まる普通の .mid として書く。
 */
export function writeSmf(smf, replaced) {
  const parts = smf.chunks.map((c) => (c.track && replaced.has(c.track.index) ? replaced.get(c.track.index) : c.raw));
  parts.push(smf.trailing);
  return concat(parts);
}
