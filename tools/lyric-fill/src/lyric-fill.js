// 歌詞の補完（画面なしの処理部分）
//
// データの分け方：
//   原本  … readSong() が返す song。元ファイルのコピーから読み取った、変更しないデータ（song.tracks[].lyrics が原本の歌詞）
//   編集  … planLyricFill() が返す edits。原本に対する「操作」の一覧（今は op:'add' だけ）。どこから写したか（from）も持つ
//   書き出し … applyEdits(song, edits) が、原本のバイト列＋編集から新しい .mid を作る
//   確認  … verifyOutput() が、書き出したバイト列を読み直して、約束（README の「書き出しの約束」）を守っているかを調べる
//
// 歌詞は文字に直さず、元の歌詞イベントのバイト列をそのまま写す（Shift_JIS でも UTF-8 でも、そのまま残る）。
// tick が一致しても、音楽的に正しい歌詞とは限らない。写す元・先のパートと小節の範囲は人が選ぶ前提。

import { readSmf, encodeTrack, writeSmf, metaEventBytes, isNoteOn, isNoteOff, isMeta, SmfError } from './smf.js';

export class LyricFillError extends Error {
  constructor(code, detail) {
    super(detail ? `${code} (${detail})` : code);
    this.name = 'LyricFillError';
    this.code = code;
  }
}

/** カラモニ（index.html）の decodeText と同じ：UTF-8 として読めなければ Shift_JIS */
export function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (e) { /* not UTF-8 */ }
  try { return new TextDecoder('shift_jis').decode(bytes); } catch (e) { /* no SJIS decoder */ }
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

const META_TEXT = 0x01, META_NAME = 0x03, META_INST = 0x04, META_LYRIC = 0x05, META_TIMESIG = 0x58;
const DRUM_CH = 9;

function deepFreeze(o) {
  if (o && typeof o === 'object' && !ArrayBuffer.isView(o) && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** 小節番号：カラモニの小節線と同じ数え方（拍子イベントから。拍子が変わった所で新しい小節が始まる） */
function makeBarMap(timeSigs, tpq) {
  const sl = [];
  if (!timeSigs.length || timeSigs[0].tick > 0) sl.push({ tick: 0, num: 4, den: 4 });
  for (const s of timeSigs) {
    if (sl.length && sl[sl.length - 1].tick === s.tick) sl[sl.length - 1] = s; else sl.push(s);
  }
  const segs = [];
  let barsBefore = 0;
  sl.forEach((s, i) => {
    const mt = s.num * tpq * 4 / s.den;
    if (!(mt > 0)) throw new LyricFillError('bad_time_signature', `${s.num}/${s.den} @${s.tick}`);
    segs.push({ tick: s.tick, mt, beatLen: tpq * 4 / s.den, barsBefore });
    if (i + 1 < sl.length) barsBefore += Math.ceil((sl[i + 1].tick - s.tick) / mt);
  });
  return (tick) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].tick > tick) i--;
    const g = segs[i];
    const k = Math.floor((tick - g.tick) / g.mt);
    return { bar: g.barsBefore + k + 1, beat: Math.floor((tick - g.tick - k * g.mt) / g.beatLen) + 1 };
  };
}

/** 音符：カラモニと同じ組み方（同じ ch・音高の note on を古い順に閉じる。長さ0は捨てる。閉じない音はトラックの終わりまで） */
function pairNotes(track) {
  const open = new Map();
  const notes = [];
  for (const ev of track.events) {
    if (isNoteOn(ev)) {
      const k = ev.ch * 128 + ev.d1;
      if (!open.has(k)) open.set(k, []);
      open.get(k).push(ev.tick);
    } else if (isNoteOff(ev)) {
      const arr = open.get(ev.ch * 128 + ev.d1);
      if (arr && arr.length) {
        const on = arr.shift();
        if (ev.tick > on) notes.push({ ch: ev.ch, pitch: ev.d1, tick: on, end: ev.tick });
      }
    }
  }
  for (const [k, arr] of open) for (const on of arr) if (track.endTick > on) notes.push({ ch: k >> 7, pitch: k & 127, tick: on, end: track.endTick });
  return notes.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
}

/**
 * MIDI を読み、原本（song）を作る。対象外のファイルは LyricFillError / SmfError を投げる。
 * 入力はコピーしてから読むので、呼んだ側が後で配列を書き換えても原本は変わらない。
 */
export function readSong(input) {
  const copy = new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
  const smf = readSmf(copy);
  const { format, division } = smf.header;
  if (division & 0x8000) throw new LyricFillError('smpte');
  if (format === 0) throw new LyricFillError('format0');
  if (format !== 1) throw new LyricFillError('format_other', String(format));
  const tpq = division;
  if (!tpq) throw new LyricFillError('bad_division');

  // カラオケ形式（.kar）：カラモニは「@K」で始まるテキストがあると、テキストイベントも歌詞として読む → 二重表示になるので扱わない
  const isKar = smf.tracks.some((t) => t.events.some((ev) => isMeta(ev, META_TEXT) && ev.data[0] === 0x40 && ev.data[1] === 0x4B));
  if (isKar) throw new LyricFillError('kar');

  const timeSigs = [];
  for (const t of smf.tracks) for (const ev of t.events) if (isMeta(ev, META_TIMESIG) && ev.data.length >= 2) timeSigs.push({ tick: ev.tick, num: ev.data[0], den: 2 ** ev.data[1] });
  timeSigs.sort((a, b) => a.tick - b.tick);
  const barOf = makeBarMap(timeSigs, tpq);

  let partCount = 0;
  let lastTick = 0;
  const tracks = smf.tracks.map((t) => {
    const nameEv = t.events.find((ev) => isMeta(ev, META_NAME));
    const instEv = t.events.find((ev) => isMeta(ev, META_INST));
    const clean = (ev) => (ev ? decodeText(ev.data).replace(/\0/g, '').trim() : '');
    const allNotes = pairNotes(t);
    const chans = [...new Set(allNotes.map((n) => n.ch))].filter((c) => c !== DRUM_CH).sort((a, b) => a - b);
    const baseName = clean(nameEv) || clean(instEv);
    const info = { index: t.index, name: baseName, channel: null, eligible: false, reason: null, notes: [], onsets: [], lyrics: [] };
    if (!chans.length) {
      info.reason = allNotes.length ? 'drums_only' : 'no_notes';
      info.name = baseName || `トラック ${t.index}`;
    } else {
      // カラモニのパート名と同じ付け方
      info.name = baseName || `パート ${partCount + 1}`;
      partCount += chans.length;
      if (chans.length > 1) info.reason = 'multi_channel';
      else {
        info.eligible = true;
        info.channel = chans[0];
        info.notes = allNotes.filter((n) => n.ch === chans[0]).map(({ pitch, tick, end }) => ({ pitch, tick, end }));
        info.onsets = [...new Set(info.notes.map((n) => n.tick))];
      }
    }
    for (const n of allNotes) if (n.end > lastTick) lastTick = n.end;
    t.events.forEach((ev, k) => {
      if (!isMeta(ev, META_LYRIC)) return;
      const { bar, beat } = barOf(ev.tick);
      info.lyrics.push({ id: `t${t.index}#${k}`, track: t.index, tick: ev.tick, bar, beat, bytes: ev.data.slice(), text: decodeText(ev.data) });
    });
    return info;
  });
  const song = { format, tpq, lastBar: barOf(lastTick > 0 ? lastTick - 1 : 0).bar, tracks };
  // 書き出し用の低レベルデータと小節の関数は、列挙されない形で持つ（原本を JSON で見る時に邪魔にならないように）
  Object.defineProperty(song, 'smf', { value: smf });
  Object.defineProperty(song, 'barOf', { value: barOf });
  return deepFreeze(song);
}

// ---- 二分探索などの小道具 ----
function lowerBound(arr, x) { // arr[i] >= x となる最初の i
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}
function nearest(sortedTicks, tick, within) {
  const i = lowerBound(sortedTicks, tick);
  let best = null;
  for (const j of [i - 1, i, i + 1]) {
    if (j < 0 || j >= sortedTicks.length || sortedTicks[j] === tick) continue;
    const d = sortedTicks[j] - tick;
    if (Math.abs(d) <= within && (best === null || Math.abs(d) < Math.abs(best))) best = d;
  }
  return best;
}
/** その tick に音が鳴っているか。strict=true なら「その tick で始まる音」は数えない */
function makeSounding(notes) {
  const starts = notes.map((n) => n.tick);
  const maxEnd = [];
  notes.forEach((n, i) => { maxEnd[i] = Math.max(i ? maxEnd[i - 1] : 0, n.end); });
  return (tick, strict) => {
    const i = lowerBound(starts, strict ? tick : tick + 1) - 1; // tick より前（strict でなければ tick ちょうども含む）に始まった最後の音
    return i >= 0 && maxEnd[i] > tick;
  };
}

/**
 * 写す候補を作る（原本は変えない）。
 * options:
 *   source   元パートのトラック番号
 *   targets  先パートのトラック番号の配列
 *   bars     { from, to }（両端を含む小節番号。省略すると曲全体）
 *   nearTicks 「開始tick不一致」とみなす近さ（既定：16分音符＝tpq/4）
 * 規則：
 *   - 元パートの歌詞の tick と、先パートの音の始まりの tick が「ちょうど同じ」ときだけ候補にする
 *   - 先パートに元から歌詞がある小節は、丸ごと触らない
 */
export function planLyricFill(song, options) {
  const { source, targets } = options;
  const from = options.bars?.from ?? 1;
  const to = options.bars?.to ?? song.lastBar;
  const nearTicks = options.nearTicks ?? Math.round(song.tpq / 4);
  const src = song.tracks[source];
  if (!src) throw new LyricFillError('no_such_track', String(source));
  if (!src.eligible) throw new LyricFillError('track_not_eligible', `${source}: ${src.reason}`);
  if (!Array.isArray(targets) || !targets.length) throw new LyricFillError('no_targets');
  if (new Set(targets).size !== targets.length) throw new LyricFillError('duplicate_target');
  for (const t of targets) {
    if (t === source) throw new LyricFillError('target_is_source', String(t));
    if (!song.tracks[t]) throw new LyricFillError('no_such_track', String(t));
    if (!song.tracks[t].eligible) throw new LyricFillError('track_not_eligible', `${t}: ${song.tracks[t].reason}`);
  }
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 1 && from <= to)) throw new LyricFillError('bad_bars', `${from}-${to}`);

  const inRange = (bar) => bar >= from && bar <= to;
  const srcByTick = new Map();
  for (const ly of src.lyrics) {
    if (!inRange(ly.bar)) continue;
    if (!srcByTick.has(ly.tick)) srcByTick.set(ly.tick, []);
    srcByTick.get(ly.tick).push(ly);
  }
  const srcTicks = [...srcByTick.keys()].sort((a, b) => a - b);
  const srcSounding = makeSounding(src.notes);

  const edits = [];
  const reports = [];
  for (const ti of targets) {
    const tgt = song.tracks[ti];
    const protectedBars = [...new Set(tgt.lyrics.filter((l) => inRange(l.bar)).map((l) => l.bar))].sort((a, b) => a - b);
    const isProtected = new Set(protectedBars);
    const onsetSet = new Set(tgt.onsets);
    const tgtSounding = makeSounding(tgt.notes);
    const unplaced = [];
    const unfilled = [];

    // 1) ちょうど同じ tick で写せるものを決める
    const filled = new Set();
    for (const tick of srcTicks) {
      if (srcByTick.get(tick).length === 1 && onsetSet.has(tick) && !isProtected.has(song.barOf(tick).bar)) filled.add(tick);
    }
    // 「開始tick不一致」の相手は、歌詞が付かなかった音・置けなかった歌詞だけにする
    const openOnsets = tgt.onsets.filter((t) => !filled.has(t));
    const openSrcTicks = srcTicks.filter((t) => !filled.has(t));

    // 2) 元パートの歌詞の側から：書き足す／置けなかった理由
    for (const tick of srcTicks) {
      const group = srcByTick.get(tick);
      const { bar, beat } = song.barOf(tick);
      if (filled.has(tick)) {
        const ly = group[0];
        edits.push({ op: 'add', id: `add:t${ti}@${tick}`, track: ti, tick, bar, beat, bytes: ly.bytes.slice(), text: ly.text, from: { track: source, tick, lyricId: ly.id } });
        continue;
      }
      const base = { tick, bar, beat, text: group.map((l) => l.text).join(' / ') };
      if (isProtected.has(bar)) unplaced.push({ ...base, reason: 'protected' });
      else if (group.length > 1) unplaced.push({ ...base, reason: 'source_multi' });
      else {
        const d = nearest(openOnsets, tick, nearTicks);
        if (d !== null) unplaced.push({ ...base, reason: 'onset_mismatch', deltaTicks: d });
        else unplaced.push({ ...base, reason: tgtSounding(tick, true) ? 'target_sustain' : 'target_rest' });
      }
    }

    // 3) 先パートの音の側から：歌詞が入らない音と理由（既存歌詞のある小節は protectedBars にまとめて示す）
    for (const tick of openOnsets) {
      const { bar, beat } = song.barOf(tick);
      if (!inRange(bar) || isProtected.has(bar)) continue;
      const base = { tick, bar, beat };
      if (srcByTick.has(tick)) unfilled.push({ ...base, reason: 'source_multi' });
      else {
        const d = nearest(openSrcTicks, tick, nearTicks);
        if (d !== null) unfilled.push({ ...base, reason: 'onset_mismatch', deltaTicks: d });
        else unfilled.push({ ...base, reason: srcSounding(tick, false) ? 'source_no_lyric' : 'source_rest' });
      }
    }
    reports.push({ track: ti, name: tgt.name, added: filled.size, protectedBars, unplacedLyrics: unplaced, unfilledNotes: unfilled });
  }
  return deepFreeze({
    options: { source, targets: [...targets], bars: { from, to }, nearTicks },
    sourceName: src.name,
    edits,
    report: reports,
  });
}

/** 原本の歌詞と編集を合わせた、あるトラックの歌詞（プレビュー用。原本は変えない） */
export function lyricsAfter(song, edits, track) {
  const orig = song.tracks[track].lyrics.map((l) => ({ tick: l.tick, bar: l.bar, beat: l.beat, text: l.text, origin: 'original' }));
  const added = edits.filter((e) => e.track === track && e.op === 'add').map((e) => ({ tick: e.tick, bar: e.bar, beat: e.beat, text: e.text, origin: 'copy', from: e.from }));
  return [...orig, ...added].sort((a, b) => a.tick - b.tick);
}

/** 編集を検査し、トラックごとの「挿入位置 → 入れるイベント」に直す */
function insertionsFor(song, edits) {
  const byTrack = new Map();
  const seen = new Set();
  for (const e of edits) {
    if (e.op !== 'add') throw new LyricFillError('unsupported_edit', String(e.op));
    const info = song.tracks[e.track];
    if (!info || !info.eligible) throw new LyricFillError('track_not_eligible', String(e.track));
    if (!(e.bytes instanceof Uint8Array)) throw new LyricFillError('bad_edit', 'bytes');
    const key = `${e.track}@${e.tick}`;
    if (seen.has(key)) throw new LyricFillError('duplicate_edit', key);
    seen.add(key);
    // 元からある歌詞と同じ位置には入れない（重複させない）
    if (info.lyrics.some((l) => l.tick === e.tick)) throw new LyricFillError('lyric_exists', key);
    const track = song.smf.tracks[e.track];
    // そのパートの ch で、その tick に始まる最初の note on の直前に入れる
    const at = track.events.findIndex((ev) => ev.tick === e.tick && isNoteOn(ev) && ev.ch === info.channel);
    if (at < 0) throw new LyricFillError('no_note_at_tick', key);
    if (!byTrack.has(e.track)) byTrack.set(e.track, new Map());
    const m = byTrack.get(e.track);
    if (!m.has(at)) m.set(at, []);
    m.get(at).push(metaEventBytes(META_LYRIC, e.bytes));
  }
  return byTrack;
}

/** 原本＋編集から、新しい .mid のバイト列を作る（原本は変えない） */
export function applyEdits(song, edits) {
  const byTrack = insertionsFor(song, edits);
  const replaced = new Map();
  for (const [ti, inserts] of byTrack) replaced.set(ti, encodeTrack(song.smf.tracks[ti], inserts));
  return writeSmf(song.smf, replaced);
}

const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameEvent = (a, b) => a.tick === b.tick && a.status === b.status && sameBytes(a.body.subarray(a.running ? 0 : 1), b.body.subarray(b.running ? 0 : 1));

/**
 * 書き出したバイト列を読み直して、約束を守っているか調べる。
 * 画面から書き出す時も、保存の前にこれを通す想定（守れていなければ保存させない）。
 * 戻り値：{ ok, problems: string[] }
 */
export function verifyOutput(song, output, edits) {
  const problems = [];
  let out;
  try { out = readSmf(output); } catch (e) { return { ok: false, problems: [`読み直せない: ${e.message}`] }; }
  const orig = song.smf;
  if (out.chunks.length !== orig.chunks.length) problems.push('チャンクの数が違う');
  const editsByTrack = new Map();
  for (const e of edits) {
    if (!editsByTrack.has(e.track)) editsByTrack.set(e.track, []);
    editsByTrack.get(e.track).push(e);
  }
  orig.chunks.forEach((c, i) => {
    const o = out.chunks[i];
    if (!o || o.id !== c.id) { problems.push(`チャンク${i}の種類が違う`); return; }
    const ti = c.track ? c.track.index : -1;
    if (!editsByTrack.has(ti)) {
      if (!sameBytes(o.raw, c.raw)) problems.push(c.track ? `トラック${ti}（変えないトラック）のバイト列が違う` : `${c.id}チャンクのバイト列が違う`);
      return;
    }
    // 変えたトラック：元のイベントを順に照らし、間に入っているのが「今回の歌詞」だけかを見る。
    // （元の歌詞と同じ tick には書き足さないので、want の tick にある歌詞イベントは今回入れたものに限られる）
    const want = new Map(editsByTrack.get(ti).map((e) => [e.tick, e]));
    const channel = song.tracks[ti].channel;
    const oe = o.track.events, ce = c.track.events;
    let j = 0;
    const inserted = new Set();
    for (let k = 0; k < ce.length; k++) {
      const a = ce[k];
      let insertedHere = false;
      while (j < oe.length && isMeta(oe[j], META_LYRIC) && want.has(oe[j].tick) && !inserted.has(oe[j].tick)) {
        if (oe[j].tick !== a.tick || !isNoteOn(a) || a.ch !== channel) problems.push(`トラック${ti} tick${oe[j].tick}: 歌詞が音の始まりの直前にない`);
        if (!sameBytes(oe[j].data, want.get(oe[j].tick).bytes)) problems.push(`トラック${ti} tick${oe[j].tick}: 書き足した歌詞のバイト列が違う`);
        inserted.add(oe[j].tick);
        insertedHere = true;
        j++;
      }
      const b = oe[j];
      if (!b || !sameEvent(a, b)) { problems.push(`トラック${ti}: ${k}番目の元のイベント（tick${a.tick}）が変わった`); return; }
      // running status：元と同じ。ただし歌詞を入れた直後のイベントだけは status を書く（メタイベントで running status が切れるため）
      if (insertedHere ? b.running : a.running !== b.running) problems.push(`トラック${ti}: tick${a.tick}の running status の扱いが違う`);
      if (!insertedHere && !sameBytes(a.delta, b.delta)) problems.push(`トラック${ti}: tick${a.tick}の delta のバイト列が変わった`);
      j++;
    }
    if (j !== oe.length) problems.push(`トラック${ti}: 余分なイベントがある`);
    if (!sameBytes(o.track.tail, c.track.tail)) problems.push(`トラック${ti}: End of Track の後ろのバイト列が違う`);
    for (const t of want.keys()) if (!inserted.has(t)) problems.push(`トラック${ti} tick${t}: 書き足すはずの歌詞がない`);
    const ticks = o.track.events.filter((ev) => isMeta(ev, META_LYRIC)).map((ev) => ev.tick);
    if (new Set(ticks).size !== ticks.length) problems.push(`トラック${ti}: 同じ位置に歌詞が重複している`);
  });
  if (!sameBytes(out.trailing, orig.trailing)) problems.push('ファイル末尾のバイト列が違う');
  return { ok: problems.length === 0, problems };
}

/** よく使う流れ：読む → 候補 → 書く → 確かめる。確認に失敗したら書き出したバイト列は返さない */
export function fillLyrics(input, options) {
  const song = readSong(input);
  const plan = planLyricFill(song, options);
  const output = applyEdits(song, plan.edits);
  const check = verifyOutput(song, output, plan.edits);
  if (!check.ok) throw new LyricFillError('verify_failed', check.problems.join(' / '));
  return { song, plan, output };
}

export { SmfError };
