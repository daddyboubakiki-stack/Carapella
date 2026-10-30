// 曲共有API（worker/src/index.js）のテスト。D1 は node:sqlite でまねる（本物の Cloudflare は使わない）
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { makeD1 } = require('./helpers/d1-sqlite');
const midi = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'midi', f)));
const ORIGIN = 'https://daddyboubakiki-stack.github.io';
const b64 = (n) => Buffer.from(require('crypto').randomBytes(n)).toString('base64url');
const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

(async () => {
  const { handle, isMidi, LIMITS } = await import('../worker/src/index.js');
  const db = makeD1();
  const env = { DB: db, IP_SALT: 'test-salt', ALLOWED_ORIGINS: ORIGIN + ',http://localhost:8787' };
  let now = Date.UTC(2026, 9, 30, 12, 0, 0);
  const call = (method, p, { headers = {}, body, ip = '203.0.113.5', at = now } = {}) =>
    handle(new Request('https://api.example' + p, { method, body, headers: { Origin: ORIGIN, 'CF-Connecting-IP': ip, ...headers } }), env, at);
  const newSong = () => ({ id: b64(12), read: b64(16), admin: b64(16) });
  const put = (s, bytes, opt = {}) => call('PUT', '/songs/' + s.id, {
    ...opt, body: bytes, headers: { 'X-Song-Name': encodeURIComponent(opt.name || 'テスト曲'), 'X-Read-Hash': sha(s.read), 'X-Admin-Hash': sha(s.admin), ...(opt.headers || {}) },
  });
  const get = (s, key = s.read) => call('GET', '/songs/' + s.id, { headers: { 'X-Song-Key': key } });
  const stop = (s, key = s.admin) => call('POST', '/songs/' + s.id + '/stop', { headers: { 'X-Admin-Key': key } });

  // MIDIの確認
  assert.equal(isMidi(midi('satb_sjis.mid')), true);
  assert.equal(isMidi(midi('long_5parts.mid')), true);
  assert.equal(isMidi(midi('wrapped.rmi')), true, 'RIFFに包まれたMIDIも受け付ける');
  assert.equal(isMidi(midi('not_midi.mid')), false);
  assert.equal(isMidi(midi('truncated.mid')), false, '途中で切れたMIDIは受け付けない');
  console.log('PASS: MIDIだけを受け付ける（RIFF包みは可、途中で切れたもの・MIDIでないものは不可）');

  // 登録 → すぐ取得
  const a = newSong();
  let r = await put(a, midi('satb_sjis.mid'), { name: 'かえるの合唱' });
  assert.equal(r.status, 201);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  r = await get(a);
  assert.equal(r.status, 200);
  assert.equal(decodeURIComponent(r.headers.get('X-Song-Name')), 'かえるの合唱');
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), midi('satb_sjis.mid'));
  console.log('PASS: 登録した曲を、すぐに同じ中身で取り出せる（曲名・no-store・CORS）');

  // 同じ依頼の再送 → 同じ曲（重複しない）／IDの衝突 → 409
  r = await put(a, midi('satb_sjis.mid'), { name: 'かえるの合唱' });
  assert.equal(r.status, 200);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM songs').get().n, 1);
  const clash = { ...newSong(), id: a.id };
  r = await put(clash, midi('satb_sjis.mid'));
  assert.equal(r.status, 409);
  console.log('PASS: 同じ依頼の再送は同じ曲を返し、2つにならない。別の依頼のID衝突は409');

  // 取り出し：キー違い・存在しない曲は同じ404
  const wrong = await get(a, b64(16));
  const missing = await get(newSong());
  assert.equal(wrong.status, 404); assert.equal(missing.status, 404);
  assert.equal(await wrong.text(), await missing.text(), '曲があるかどうかを漏らさない');
  console.log('PASS: 読み取りキー違いと、ない曲は同じ答え（404）');

  // 共有をやめる：管理キー違いは404、正しいキーで200、すぐ410、何度押しても200、本体は空に
  r = await stop(a, b64(16)); assert.equal(r.status, 404);
  r = await stop(a, a.read); assert.equal(r.status, 404, '読み取りキーでは止められない');
  r = await stop(a); assert.equal(r.status, 200);
  r = await get(a); assert.equal(r.status, 410);
  r = await stop(a); assert.equal(r.status, 200);
  assert.equal(db.raw.prepare('SELECT size, length(midi) AS l FROM songs WHERE id = ?').get(a.id).l, 0);
  console.log('PASS: 共有をやめる：管理キーだけで止められ、止めた直後から410、何度押しても成功、本体は消える');

  // 受け付けないもの
  r = await put(newSong(), midi('not_midi.mid')); assert.equal(r.status, 415);
  r = await put(newSong(), midi('truncated.mid')); assert.equal(r.status, 415);
  const big = new Uint8Array(LIMITS.maxMidi + 1); big.set(midi('satb_sjis.mid'));
  r = await put(newSong(), big); assert.equal(r.status, 413);
  r = await put(newSong(), midi('satb_sjis.mid'), { name: 'あ'.repeat(81) }); assert.equal(r.status, 400);
  r = await put(newSong(), midi('satb_sjis.mid'), { headers: { 'X-Read-Hash': 'abc' } }); assert.equal(r.status, 400);
  r = await call('PUT', '/songs/short', { body: midi('satb_sjis.mid') }); assert.equal(r.status, 404);
  console.log('PASS: MIDIでない・途中で切れた・256KB超・曲名81文字・不正なハッシュ・不正なIDは受け付けない');

  // 回数の上限：同じ送り元は1時間に20件まで、別の送り元は登録できる、1時間たてば再び登録できる
  db.raw.exec('DELETE FROM songs');
  const ipA = '198.51.100.7';
  for (let i = 0; i < 20; i++) assert.equal((await put(newSong(), midi('satb_sjis.mid'), { ip: ipA })).status, 201);
  r = await put(newSong(), midi('satb_sjis.mid'), { ip: ipA });
  assert.equal(r.status, 429); assert.equal(r.headers.get('Retry-After'), '3600');
  assert.equal((await put(newSong(), midi('satb_sjis.mid'), { ip: '198.51.100.8' })).status, 201);
  assert.equal((await put(newSong(), midi('satb_sjis.mid'), { ip: ipA, at: now + 3600 * 1000 + 1 })).status, 201);
  console.log('PASS: 同じ送り元は1時間に20件まで（21件目は429）。別の送り元・1時間後は登録できる');

  // 全体の上限：24時間で300件まで
  db.raw.exec('DELETE FROM songs');
  for (let i = 0; i < 300; i++) assert.equal((await put(newSong(), midi('satb_sjis.mid'), { ip: '192.0.2.' + (i % 250) + '.' + Math.floor(i / 250) })).status, 201);
  r = await put(newSong(), midi('satb_sjis.mid'), { ip: '203.0.113.99' });
  assert.equal(r.status, 429);
  // 上限の後でも、共有をやめる操作はできる（書き込みの余裕が残る）
  const last = newSong();
  db.raw.exec('DELETE FROM songs WHERE rowid = (SELECT MAX(rowid) FROM songs)');
  assert.equal((await put(last, midi('satb_sjis.mid'), { ip: '203.0.113.100' })).status, 201);
  assert.equal((await stop(last)).status, 200);
  console.log('PASS: 全体は24時間で300件まで（301件目は429）。上限に達しても共有をやめる操作はできる');

  // 上限に達した時の再送は、上限ではなく「同じ曲」として扱う
  r = await put(last, midi('satb_sjis.mid'), { ip: '203.0.113.100' });
  assert.equal(r.status, 200);
  console.log('PASS: 上限に達していても、すでに保存できた依頼の再送は同じ曲を返す（「保存できなかった」と誤表示しない）');

  // データベースの失敗 → 503（成功とも「見つからない」とも言わない）
  db.state.fail = true;
  for (const res of [await put(newSong(), midi('satb_sjis.mid')), await get(a), await stop(last)]) {
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  }
  db.state.fail = false;
  console.log('PASS: データベースが失敗した時は、登録・取り出し・停止のどれも503');

  // 秘密値（IP_SALT）を登録し忘れた時：誰でも分かる値でハッシュにせず、登録を断る（取り出しはできる）
  const kept = newSong();
  assert.equal((await put(kept, midi('satb_sjis.mid'), { ip: '203.0.113.201', at: now + 2 * 24 * 3600 * 1000 })).status, 201);
  const salt = env.IP_SALT;
  delete env.IP_SALT;
  const countBefore = db.raw.prepare('SELECT COUNT(*) AS n FROM songs').get().n;
  r = await put(newSong(), midi('satb_sjis.mid'), { ip: '203.0.113.200' });
  assert.equal(r.status, 503);
  assert.equal(db.raw.prepare('SELECT COUNT(*) AS n FROM songs').get().n, countBefore);
  assert.equal((await get(kept)).status, 200);
  env.IP_SALT = salt;
  console.log('PASS: 秘密値がない時は登録を断る（503、行は増えない）。取り出しはできる');

  // CORS：許可していない送り元には許可の見出しを出さない／事前確認（OPTIONS）
  r = await handle(new Request('https://api.example/songs/' + a.id, { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env, now);
  assert.equal(r.status, 204);
  assert.match(r.headers.get('Access-Control-Allow-Headers'), /X-Song-Key/);
  r = await handle(new Request('https://api.example/songs/' + a.id, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env, now);
  assert.equal(r.status, 403);
  r = await handle(new Request('https://api.example/songs/' + a.id, { headers: { Origin: 'https://evil.example', 'X-Song-Key': a.read } }), env, now);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  console.log('PASS: 公開ページ以外のサイトからは、ブラウザで読み書きできない（CORS）');

  // 送り元の目印にIPそのものは残らない
  const rows = db.raw.prepare('SELECT * FROM songs').all();
  assert(rows.length > 0 && rows.every((row) => /^[0-9a-f]{32}$/.test(row.src)));
  assert(!JSON.stringify(rows.map(({ midi, ...rest }) => rest)).match(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/), 'IPアドレスの形の文字が保存されていない');
  console.log('PASS: 送り元はハッシュだけを保存し、IPアドレスそのものは保存しない');
})().catch((e) => { console.error(e); process.exitCode = 1; });
