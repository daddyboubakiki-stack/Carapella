// アカペラ練習帳：曲専用リンクのためのAPI（Cloudflare Workers ＋ D1）
//
// PUT  /songs/:id        曲を登録する（本体＝MIDIのバイト列、見出し：X-Song-Name・X-Read-Hash・X-Admin-Hash）
// GET  /songs/:id        曲を取り出す（見出し：X-Song-Key＝読み取りキー）
// POST /songs/:id/stop   共有をやめる（見出し：X-Admin-Key＝管理キー）
//
// ログインも合言葉もない。リンク（ID＋読み取りキー）を知っている人は誰でも開ける。
// 悪用を抑えるのは、MIDIだけを受け付けることと、登録の回数の上限（同じ送り元・全体）。
// 失敗したのに成功と返さない：登録は1回の書き込み、共有の停止は変更が1行あった時だけ成功を返す。

export const LIMITS = {
  maxMidi: 256 * 1024, // MIDIの大きさの上限（バイト）
  maxName: 80, // 曲名の上限（文字）
  perSrcPerHour: 20, // 同じ送り元（同じネットワーク）からの登録：1時間あたり
  allPerDay: 300, // 全体の登録：24時間あたり（無料枠より十分小さくし、停止の書き込みの余裕を残す）
};
const ID_RE = /^[A-Za-z0-9_-]{16}$/;
const KEY_RE = /^[A-Za-z0-9_-]{22,64}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const HOUR = 3600 * 1000, DAY = 24 * HOUR;

export default {
  fetch: (request, env) => handle(request, env),
};

export async function handle(request, env, now = Date.now()) {
  const cors = corsHeaders(request, env);
  if (request.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
  const url = new URL(request.url);
  const m = /^\/songs\/([^/]+)(\/stop)?$/.exec(url.pathname);
  try {
    if (!m || !ID_RE.test(m[1])) return reply(404, { error: 'not_found' }, cors);
    const id = m[1];
    if (!m[2] && request.method === 'PUT') return await createSong(request, env, id, now, cors);
    if (!m[2] && request.method === 'GET') return await readSong(request, env, id, cors);
    if (m[2] && request.method === 'POST') return await stopSong(request, env, id, now, cors);
    return reply(405, { error: 'method' }, cors);
  } catch (e) {
    // データベースの失敗・無料枠の超過など。成功とも「見つからない」とも言わない
    return reply(503, { error: 'unavailable' }, cors);
  }
}

async function createSong(request, env, id, now, cors) {
  const name = decodeName(request.headers.get('X-Song-Name'));
  const readHash = request.headers.get('X-Read-Hash') || '';
  const adminHash = request.headers.get('X-Admin-Hash') || '';
  if (name == null || !HASH_RE.test(readHash) || !HASH_RE.test(adminHash) || readHash === adminHash) return reply(400, { error: 'bad_request' }, cors);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > LIMITS.maxMidi) return reply(413, { error: 'too_large' }, cors);
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > LIMITS.maxMidi) return reply(413, { error: 'too_large' }, cors);
  if (!isMidi(bytes)) return reply(415, { error: 'not_midi' }, cors);
  const sha = await sha256Hex(bytes);
  const src = await sourceMark(request, env, now);
  // 「数えて、上限の内なら挿入」を1つの文で行う。同じIDがすでにあれば何もしない（再送に備える）
  const r = await env.DB.prepare(
    `INSERT INTO songs (id, read_hash, admin_hash, name, midi, size, sha256, src, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
     WHERE (SELECT COUNT(*) FROM songs WHERE created_at > ?9 - ?10) < ?11
       AND (SELECT COUNT(*) FROM songs WHERE src = ?8 AND created_at > ?9 - ?12) < ?13
     ON CONFLICT(id) DO NOTHING`
  ).bind(id, readHash, adminHash, name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), bytes.length, sha, src, now,
    DAY, LIMITS.allPerDay, HOUR, LIMITS.perSrcPerHour).run();
  if (r.meta && r.meta.changes === 1) return reply(201, { id, sha256: sha }, cors);
  // 挿入されなかった：同じ依頼の再送か、IDの衝突か、回数の上限か
  const row = await env.DB.prepare('SELECT read_hash, admin_hash, sha256 FROM songs WHERE id = ?1').bind(id).first();
  if (row && row.read_hash === readHash && row.admin_hash === adminHash && row.sha256 === sha) return reply(200, { id, sha256: sha }, cors);
  if (row) return reply(409, { error: 'conflict' }, cors);
  return reply(429, { error: 'busy' }, cors, { 'Retry-After': '3600' });
}

async function readSong(request, env, id, cors) {
  const key = request.headers.get('X-Song-Key') || '';
  if (!KEY_RE.test(key)) return reply(404, { error: 'not_found' }, cors);
  const row = await env.DB.prepare('SELECT read_hash, name, midi, sha256, stopped_at FROM songs WHERE id = ?1').bind(id).first();
  // 曲がない時と、読み取りキーが違う時は同じ答え（曲があるかどうかを漏らさない）
  if (!row || row.read_hash !== (await sha256Hex(new TextEncoder().encode(key)))) return reply(404, { error: 'not_found' }, cors);
  if (row.stopped_at != null) return reply(410, { error: 'stopped' }, cors);
  return new Response(toBytes(row.midi), {
    status: 200,
    headers: {
      ...(cors || {}),
      'Content-Type': 'audio/midi',
      'Cache-Control': 'no-store',
      'X-Song-Name': encodeURIComponent(row.name),
      'X-Song-Sha256': row.sha256,
    },
  });
}

async function stopSong(request, env, id, now, cors) {
  const key = request.headers.get('X-Admin-Key') || '';
  if (!KEY_RE.test(key)) return reply(404, { error: 'not_found' }, cors);
  const adminHash = await sha256Hex(new TextEncoder().encode(key));
  // 本体を空にして容量を空ける。止めた時刻は最初の1回だけ記録する（何度押しても成功）
  const r = await env.DB.prepare(
    "UPDATE songs SET stopped_at = COALESCE(stopped_at, ?1), midi = x'', size = 0 WHERE id = ?2 AND admin_hash = ?3"
  ).bind(now, id, adminHash).run();
  if (r.meta && r.meta.changes === 1) return reply(200, { stopped: true }, cors);
  return reply(404, { error: 'not_found' }, cors);
}

// ===== 確認と変換 =====
// MIDI（SMF）か：MThd（長さ6・形式0〜2・トラック数1以上）から、チャンクを最後まで正しくたどれ、見出しの数だけ完全なトラックがある。
// RIFF（.rmi）に包まれたものは中身を確かめる。拡張子やブラウザの申告は見ない
export function isMidi(b) {
  const tag = (p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
  const u32 = (p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
  const u32le = (p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  let start = 0, end = b.length;
  if (b.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'RMID') {
    let p = 12, found = false;
    while (p + 8 <= b.length) {
      const len = u32le(p + 4);
      if (tag(p) === 'data') { start = p + 8; end = Math.min(b.length, start + len); found = true; break; }
      p += 8 + len + (len & 1);
    }
    if (!found) return false;
  }
  if (end - start < 14 || tag(start) !== 'MThd' || u32(start + 4) !== 6) return false;
  const format = (b[start + 8] << 8) | b[start + 9], ntrks = (b[start + 10] << 8) | b[start + 11];
  if (format > 2 || ntrks < 1) return false;
  let p = start + 14, tracks = 0;
  while (p + 8 <= end) {
    const len = u32(p + 4);
    if (p + 8 + len > end) return false; // 途中で切れたチャンク
    if (tag(p) === 'MTrk') tracks++;
    p += 8 + len;
  }
  return tracks >= ntrks && end - p < 8; // 見出しのトラック数より少なければ、途中で切れたもの
}
function decodeName(v) {
  if (v == null) return null;
  let s;
  try { s = decodeURIComponent(v); } catch (e) { return null; }
  s = s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s || [...s].length > LIMITS.maxName) return null;
  return s;
}
async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// 送り元の目印：IPアドレスと日付を、秘密値つきのハッシュにしたもの（元のIPには戻せず、日をまたぐとつながらない）
async function sourceMark(request, env, now) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const day = new Date(now).toISOString().slice(0, 10);
  // 秘密値がない時は登録を受け付けない（誰でも分かる値でハッシュにしない）。上の catch で 503 になる
  if (!env.IP_SALT) throw new Error('IP_SALT is not set');
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IP_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(ip + '|' + day)));
  return [...sig.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
// D1 は BLOB を配列・ArrayBuffer などで返すことがあるので、どれでもバイト列にする
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return new Uint8Array(v || []);
}
// 公開ページ（と開発用の localhost）だけに、ブラウザからの読み書きを許す
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Song-Name, X-Read-Hash, X-Admin-Hash, X-Song-Key, X-Admin-Key',
    'Access-Control-Expose-Headers': 'X-Song-Name, X-Song-Sha256',
    'Access-Control-Max-Age': '600',
  };
}
function reply(status, body, cors, extra) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...(cors || {}), 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extra || {}) },
  });
}
