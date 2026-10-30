// 曲共有API（worker/）を、Cloudflare の実行環境で確かめる
//   node tests/share_workerd.js                 手元で wrangler dev（workerd ＋ 手元のD1）を起こして確かめる
//   node tests/share_workerd.js --remote <URL>  公開したWorkerを、合成MIDIで確かめる（作った曲は最後にやめる）
// どちらも npx で wrangler を使う（初回は取得に時間がかかる）。tests/share_api_test.js（SQLiteでの代用）の補い
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const ORIGIN = 'https://daddyboubakiki-stack.github.io';
const remote = process.argv[2] === '--remote' ? String(process.argv[3] || '').replace(/\/+$/, '') : null;
const midi = (f) => new Uint8Array(fs.readFileSync(path.join(__dirname, 'midi', f)));
const b64 = (n) => crypto.randomBytes(n).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (process.argv[2] === '--remote' && !/^https:\/\//.test(remote)) throw new Error('使い方：node tests/share_workerd.js --remote https://…workers.dev');
  let base = remote, dev = null, sql = null;
  if (!remote) {
    // 手元用の設定（本物のD1のIDは使わない）
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carapella-share-'));
    fs.writeFileSync(path.join(dir, 'wrangler.toml'), [
      'name = "carapella-share"',
      `main = ${JSON.stringify(path.join(REPO, 'worker/src/index.js'))}`,
      'compatibility_date = "2026-10-01"',
      '[vars]', `ALLOWED_ORIGINS = "${ORIGIN}"`,
      '[[d1_databases]]', 'binding = "DB"', 'database_name = "carapella-share"', 'database_id = "00000000-0000-0000-0000-000000000000"',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, '.dev.vars'), 'IP_SALT=local-check\n');
    const wr = (args) => execFileSync('npx', ['--yes', 'wrangler@4', ...args], { cwd: dir, env: { ...process.env, CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    wr(['d1', 'execute', 'carapella-share', '--local', '--file', path.join(REPO, 'worker/schema.sql')]);
    sql = (q) => JSON.parse(wr(['d1', 'execute', 'carapella-share', '--local', '--json', '--command', q]))[0].results;
    const port = 8700 + Math.floor(Math.random() * 200);
    base = 'http://127.0.0.1:' + port;
    dev = spawn('npx', ['--yes', 'wrangler@4', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port)], { cwd: dir, env: { ...process.env, CI: '1' }, stdio: 'ignore', detached: true });
    process.on('exit', () => { try { process.kill(-dev.pid); } catch (e) { /* もう止まっている */ } });
    for (let i = 0; ; i++) {
      try { if ((await fetch(base + '/songs/x')).status === 404) break; } catch (e) { /* 起動待ち */ }
      if (i > 120) throw new Error('wrangler dev が起動しません');
      await sleep(1000);
    }
  }
  console.log(remote ? '公開したWorker：' + remote : '手元の workerd ＋ D1（wrangler dev）');

  const call = (method, p, headers = {}, body, ip = '198.51.100.7') =>
    fetch(base + p, { method, body, headers: { Origin: ORIGIN, ...(remote ? {} : { 'CF-Connecting-IP': ip }), ...headers } });
  const newSong = () => ({ id: b64(12), read: b64(16), admin: b64(16) });
  const put = (s, bytes, ip, name = 'テスト用の合成MIDI') => call('PUT', '/songs/' + s.id, { 'X-Song-Name': encodeURIComponent(name), 'X-Read-Hash': sha(s.read), 'X-Admin-Hash': sha(s.admin) }, bytes, ip);
  const get = (s, key = s.read) => call('GET', '/songs/' + s.id, { 'X-Song-Key': key });
  const stop = (s, key = s.admin) => call('POST', '/songs/' + s.id + '/stop', { 'X-Admin-Key': key });

  // 1) 登録 → 取り出したバイト列が元と同じ（D1 の BLOB の受け渡し）
  const file = midi('satb_sjis.mid');
  const a = newSong();
  let r = await put(a, file, undefined, 'かえるの合唱（合成）');
  assert.equal(r.status, 201, await r.text());
  r = await get(a);
  assert.equal(r.status, 200);
  assert.equal(Buffer.compare(Buffer.from(await r.arrayBuffer()), Buffer.from(file)), 0, '取り出したMIDIが元と同じ');
  assert.equal(decodeURIComponent(r.headers.get('X-Song-Name')), 'かえるの合唱（合成）');
  assert.equal(r.headers.get('X-Song-Sha256'), sha(file));
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  console.log('PASS: 登録 → すぐ取り出せる（バイト列・曲名・ハッシュが一致）');

  // 2) 再送は同じ曲、IDの衝突は409
  assert.equal((await put(a, file, undefined, 'かえるの合唱（合成）')).status, 200);
  r = await call('PUT', '/songs/' + a.id, { 'X-Song-Name': 'x', 'X-Read-Hash': sha(b64(16)), 'X-Admin-Hash': sha(b64(16)) }, file);
  assert.equal(r.status, 409);
  if (sql) assert.equal(sql('SELECT COUNT(*) AS n FROM songs')[0].n, 1);
  console.log('PASS: 同じ依頼の再送は200（2つ作らない）、IDの衝突は409');

  // 3) キー違い → 404、やめる → すぐ410
  assert.equal((await get(a, b64(16))).status, 404);
  assert.equal((await stop(a, a.read)).status, 404);
  assert.equal((await stop(a)).status, 200);
  assert.equal((await get(a)).status, 410);
  assert.equal((await stop(a)).status, 200);
  if (sql) assert.equal(sql(`SELECT length(midi) AS l FROM songs WHERE id = '${a.id}'`)[0].l, 0);
  console.log('PASS: キー違いは404、やめるとすぐ410（本体は空になる）');

  // 4) MIDIでない・途中で切れた・大きすぎる（登録されないので数に入らない）
  assert.equal((await put(newSong(), midi('not_midi.mid'))).status, 415);
  assert.equal((await put(newSong(), midi('truncated.mid'))).status, 415);
  const big = new Uint8Array(256 * 1024 + 1); big.set(file);
  assert.equal((await put(newSong(), big)).status, 413);
  console.log('PASS: MIDIでないもの・途中で切れたもの（415）、256KB超（413）は断る');

  // 5) CORS
  r = await fetch(base + '/songs/' + a.id, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT' } });
  assert.equal(r.status, 204);
  r = await fetch(base + '/songs/' + a.id, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(r.status, 403);
  console.log('PASS: 公開ページからの事前確認は204、ほかのサイトは403');

  if (!remote) {
    // 6) 同じ送り元から同時に30件 → ちょうど20件（上限の文が同時実行でも破れない）。本番の枠を使うので手元だけ
    const rs = await Promise.all(Array.from({ length: 30 }, () => put(newSong(), file, '198.51.100.99')));
    const codes = rs.map((x) => x.status);
    assert.equal(codes.filter((c) => c === 201).length, 20, codes.join(','));
    assert.equal(codes.filter((c) => c === 429).length, 10);
    assert.equal((await put(newSong(), file, '198.51.100.100')).status, 201, '別の送り元は登録できる');
    console.log('PASS: 同じ送り元から同時に30件 → 201が20件・429が10件');

    // 7) IPそのものは保存しない
    const rows = sql('SELECT id, name, src, sha256 FROM songs');
    assert(rows.every((x) => /^[0-9a-f]{32}$/.test(x.src)));
    assert(!/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(JSON.stringify(rows)));
    console.log('PASS: 送り元はハッシュだけ（IPの形の文字は残らない）');
  }
  console.log('結果：すべてPASS');
})().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => process.exit());
