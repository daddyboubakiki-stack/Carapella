// 曲専用リンク（共有）のテスト：アプリ（index.html）と、worker/ のAPIをローカルで動かしてつなぐ。
// D1 は node:sqlite でまねる。本物の Cloudflare・実機・LINE内ブラウザは使わない。
// 使い方：node tests/share_app.js
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const { makeD1 } = require('./helpers/d1-sqlite');
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log('  ' + (ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };
const listen = (srv) => new Promise((r) => srv.listen(0, () => r(srv.address().port)));

let cleanup = async () => {};
(async () => {
  const { handle } = await import('../worker/src/index.js');
  const db = makeD1();
  // ---- 偽のAPI（中身は worker/src/index.js そのもの）。テストのために、通信を切る・HTMLを返すことができる ----
  const api = { dropNextPut: false, htmlNextGet: false, puts: 0 };
  let appOrigin = '';
  const apiServer = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (req.method === 'PUT') {
      api.puts++;
      if (api.dropNextPut) { api.dropNextPut = false; req.socket.destroy(); return; } // 届いたが返事が来ない、を作る：保存はせずに切る
    }
    if (req.method === 'GET' && api.htmlNextGet) {
      api.htmlNextGet = false;
      res.writeHead(429, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': appOrigin });
      res.end('<html>error code: 1027</html>'); return;
    }
    const body = ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handle(new Request('http://api.local' + req.url, { method: req.method, headers: { ...req.headers, 'CF-Connecting-IP': '127.0.0.1' }, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  const apiPort = await listen(apiServer);
  const API = 'http://localhost:' + apiPort;
  // ---- アプリ。SHARE_API を偽のAPIに向けた版と、空にした（設定していない）版。本番のURLには向けない ----
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const API_LINE = /const SHARE_API = '[^']*';/;
  if (!API_LINE.test(html)) throw new Error('SHARE_API の行が見つかりません');
  const expose = "Object.assign(window, { S, T }); })();</script></body>";
  const withApi = html.replace(API_LINE, `const SHARE_API = '${API}';`).replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, expose);
  const noApi = html.replace(API_LINE, "const SHARE_API = '';").replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, expose);
  const appServer = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url.startsWith('/off') ? noApi : withApi); });
  const appPort = await listen(appServer);
  appOrigin = 'http://localhost:' + appPort;
  const env = { DB: db, IP_SALT: 'test', ALLOWED_ORIGINS: appOrigin };
  const APP = appOrigin + '/';

  const b = await chromium.launch();
  process.on('exit', () => { try { b.close(); } catch (e) { /* ignore */ } });
  cleanup = async () => { await b.close().catch(() => {}); apiServer.close(); appServer.close(); };
  const errs = [];
  const newPage = async (w = 1280, h = 800) => {
    const ctx = await b.newContext({ viewport: { width: w, height: h } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: appOrigin });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errs.push(e.message));
    await p.route(/fonts\.g/, (r) => r.abort());
    return p;
  };
  const msg = (p) => p.textContent('#msg');
  const shareMsg = (p) => p.textContent('#shareMsg');
  const rows = () => db.raw.prepare('SELECT id, name, stopped_at FROM songs').all();
  const midiFile = path.join(__dirname, 'midi', 'satb_sjis.mid');

  // 1) 今の公開版と同じ（SHARE_API が空）：共有のボタンは出ない。リンクで開くと「まだ使えません」
  console.log('共有APIを設定していない版（今の公開版と同じ）');
  let p = await newPage();
  await p.goto(appOrigin + '/off');
  await p.setInputFiles('#fileIn', midiFile); await sleep(300);
  check('曲を開いても「共有リンク」のボタンは出ない', await p.isHidden('#shareBtn'));
  await p.goto(appOrigin + '/off#song=AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB'); await p.reload(); await sleep(300);
  check('リンクで開くと「まだ使えません」と出る', (await msg(p)).includes('まだ使えません'), await msg(p));
  await p.context().close();

  // 2) 作る
  console.log('共有APIを設定した版');
  p = await newPage();
  await p.goto(APP);
  await p.click('#demoBtn'); await sleep(200);
  check('デモ曲では「共有リンク」のボタンは出ない（元のファイルがない）', await p.isHidden('#shareBtn'));
  await p.setInputFiles('#fileIn', midiFile); await sleep(300);
  check('MIDIファイルを開くと「共有リンク」のボタンが出る', await p.isVisible('#shareBtn'));
  await p.click('#shareBtn'); await sleep(150);
  check('「リンクを作る」と、誰でも開ける注意が出る', await p.isVisible('#shareMake') && (await p.textContent('#sharePanel')).includes('誰でも開けます'));
  // 作る時にデータベースが失敗 → 成功と言わない／もう一度押すと同じIDで作れる
  db.state.fail = true;
  await p.click('#shareMake'); await sleep(300);
  let st = await p.evaluate(() => ({ list: JSON.parse(localStorage.getItem('acapella-renshucho:shares:v1') || '[]').length, link: document.getElementById('shareDone').hidden }));
  check('保存に失敗した時は「確認できませんでした」と出し、リンクを出さない', (await shareMsg(p)).includes('確認できませんでした') && st.list === 0 && st.link, await shareMsg(p));
  db.state.fail = false;
  // 届いたのに返事が来ない（通信が切れた）→ 自動でもう1回 → 成功、曲は1つ
  api.dropNextPut = true;
  const putsBefore = api.puts;
  await p.click('#shareMake'); await sleep(500);
  const link = await p.inputValue('#shareLink');
  check('通信が切れても、同じ依頼で送り直して「リンクができました」', (await shareMsg(p)).includes('できました') && /#song=[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}$/.test(link) && api.puts - putsBefore === 2, link);
  check('データベースの曲は1つだけ（失敗・送り直しで2つにならない）', rows().length === 1, JSON.stringify(rows()));
  check('曲名がそのまま保存される', rows()[0].name === 'テスト合唱曲', rows()[0].name);
  check('LINEで送るリンクに、曲名と共有リンクが入る', decodeURIComponent((await p.getAttribute('#shareLine', 'href')).split('text=')[1]).includes(link));
  await p.click('#shareCopy'); await sleep(100);
  check('コピーできる', (await p.evaluate(() => navigator.clipboard.readText())) === link);
  // 閉じて開き直すと、作ったリンクがそのまま出る（もう1つ作らない）
  await p.click('#shareClose'); await p.click('#shareBtn'); await sleep(200);
  check('開き直すと、同じリンクが出る（2つ目を作らない）', (await p.inputValue('#shareLink')) === link && await p.isHidden('#shareNew') && rows().length === 1);

  // 3) 受け取る（別の端末）
  const q = await newPage(390, 664);
  await q.goto(link); await sleep(600);
  st = await q.evaluate(() => ({ title: document.getElementById('songTitle').textContent, parts: S.song && S.song.parts.length, playing: T.playing, hash: location.hash }));
  check('リンクを開くと、曲が読み込まれた状態になる', st.title === 'テスト合唱曲' && st.parts === 4, JSON.stringify(st));
  check('自動で再生はしない・リンクはそのまま', !st.playing && link.endsWith(st.hash));
  check('受け取った側には「共有リンク」のボタンは出ない', await q.isHidden('#shareBtn'));
  // 共有の曲のしおりは、曲の版ごとに記憶する
  await q.evaluate(() => addMark ? 0 : 0).catch(() => {});
  const key = await q.evaluate(() => S.songVer);
  check('共有の曲は、中身のハッシュ（版）で区別する', /^[0-9a-f]{16}$/.test(key || ''), key);

  // 4) キーを1文字変えたリンク → 見つかりません
  const bad = link.slice(0, -1) + (link.endsWith('A') ? 'B' : 'A');
  await q.goto(bad); await q.reload(); await sleep(400);
  check('キーが違うリンクは「見つかりません」', (await msg(q)).includes('見つかりません'), await msg(q));

  // 5) サービスが混み合っている・エラー → 「見つかりません」とは言わない
  db.state.fail = true;
  await q.goto(link); await q.reload(); await sleep(400);
  check('データベースのエラーでは「今は読み込めません」（「見つかりません」と言わない）', (await msg(q)).includes('今は曲を読み込めません'), await msg(q));
  db.state.fail = false;
  api.htmlNextGet = true;
  await q.reload(); await sleep(400);
  check('無料枠を超えた時のHTMLの返事でも「今は読み込めません」', (await msg(q)).includes('今は曲を読み込めません'), await msg(q));

  // 6) 共有をやめる → すぐ開けなくなる
  await p.click('#shareStop'); await sleep(300);
  st = await p.evaluate(() => JSON.parse(localStorage.getItem('acapella-renshucho:shares:v1') || '[]').length);
  check('「共有をやめる」で「やめました」と出て、この端末の一覧から消える', (await shareMsg(p)).includes('やめました') && st === 0, await shareMsg(p));
  await q.reload(); await sleep(400);
  check('やめた後にリンクを開くと「やめられました」', (await msg(q)).includes('やめられました'), await msg(q));
  // やめる時にエラー → 「やめました」と言わず、一覧に残す
  await p.click('#shareBtn').catch(() => {}); await sleep(100);
  if (await p.isVisible('#shareMake')) await p.click('#shareMake');
  await sleep(300);
  db.state.fail = true;
  await p.click('#shareStop'); await sleep(300);
  st = await p.evaluate(() => JSON.parse(localStorage.getItem('acapella-renshucho:shares:v1') || '[]').length);
  check('やめる時にエラー → 「やめられませんでした」と出し、共有中のまま残す', (await shareMsg(p)).includes('やめられませんでした') && st === 1, await shareMsg(p));
  db.state.fail = false;

  // 7) 登録が混み合っている（429）
  db.raw.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300) INSERT INTO songs (id, read_hash, admin_hash, name, midi, size, sha256, src, created_at) SELECT 'x' || i, 'a', 'b', 'n', x'', 0, 's', 'z', " + Date.now() + " FROM n");
  const r = await newPage();
  await r.goto(APP);
  await r.setInputFiles('#fileIn', path.join(__dirname, 'midi', 'format0_4ch.mid')); await sleep(300);
  await r.click('#shareBtn'); await r.click('#shareMake'); await sleep(300);
  check('登録が上限の時は「混み合っています」', (await shareMsg(r)).includes('混み合っています'), await shareMsg(r));

  // 7b) スマホ：「曲を開く」メニューから共有を開くと、メニューは閉じて共有の欄に重ならない
  const m = await newPage(390, 664);
  await m.goto(APP);
  await m.setInputFiles('#fileIn', midiFile); await sleep(300);
  await m.click('#fileMenu > summary'); await sleep(100);
  await m.click('#shareBtn'); await sleep(200);
  const ov = await m.evaluate(() => ({
    menu: document.getElementById('fileMenu').open,
    panel: !document.getElementById('sharePanel').hidden,
    wide: document.documentElement.scrollWidth > innerWidth,
  }));
  check('スマホ：共有を開くと「曲を開く」メニューは閉じる（重ならない）', !ov.menu && ov.panel && !ov.wide, JSON.stringify(ov));

  // 8) 今までの機能：ファイルを開く・再生は変わらない
  await r.click('#playBtn'); await sleep(300);
  check('ファイルを開いて再生できる（今まで通り）', await r.evaluate(() => T.playing));
  await r.click('#playBtn');
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果：NG ${fails}件`);
  await b.close(); apiServer.close(); appServer.close();
  process.exitCode = fails ? 1 : 0;
})().catch(async (e) => { console.error(e); process.exitCode = 1; await cleanup(); });
