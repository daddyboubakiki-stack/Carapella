// バーの長さ（横の拡大）を、2本指のピンチ・Ctrl＋ホイールで変えるテスト
// 使い方：node tests/zoom.js
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const EXPOSE = "Object.assign(window, { S, view, displayTime, pixelsPerSecond, panToTime, timeAtX, seekTo }); Object.defineProperty(window, 'pick', { get: () => pick });";
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, EXPOSE + ' })();</script></body>')); }).listen(0);
const URL = 'http://localhost:' + server.address().port + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log('  ' + (ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };

(async () => {
  const b = await chromium.launch();
  // ---- スマホ：2本指のピンチ ----
  console.log('スマホ（390×664、タッチ）');
  const ctx = await b.newContext({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.g/, (r) => r.abort());
  await p.goto(URL);
  await p.click('#demoBtn'); await sleep(300);
  await p.evaluate(() => { panToTime(6); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); }); await sleep(150);
  const cdp = await ctx.newCDPSession(p);
  const bx = await p.locator('#roll').boundingBox();
  const cx = bx.x + bx.width * 0.6, cy = bx.y + bx.height * 0.5;
  const two = (type, half) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: cx - half, y: cy, id: 1 }, { x: cx + half, y: cy, id: 2 }] });
  const z0 = await p.evaluate(() => pixelsPerSecond());
  const tMid = await p.evaluate((x) => timeAtX(x), cx - bx.x);
  await two('touchStart', 30);
  for (let h = 40; h <= 75; h += 5) await two('touchMove', h);
  await two('touchEnd'); await sleep(100);
  let st = await p.evaluate((x) => ({ z: pixelsPerSecond(), slider: document.getElementById('zoom').value, auto: document.getElementById('autoZoom').checked, tMid: timeAtX(x), marks: S.marks.length, pick: !!pick }), cx - bx.x);
  check('2本指で広げると、バーが長くなる（指の間が2.5倍→約2.5倍）', st.z > z0 * 2 && st.z <= 320, `${z0.toFixed(0)} → ${st.z}`);
  check('設定の「横の拡大」も同じ値になり、自動の幅合わせは外れる', Number(st.slider) === st.z && !st.auto, JSON.stringify(st));
  check('指の間にあった時刻が、指の間に残る', Math.abs(st.tMid - tMid) < 0.15, `${tMid.toFixed(2)} → ${st.tMid.toFixed(2)}`);
  check('ピンチでしおりやシートは出ない', st.marks === 0 && !st.pick);
  const z1 = st.z;
  await two('touchStart', 80);
  for (let h = 70; h >= 40; h -= 10) await two('touchMove', h);
  await two('touchEnd'); await sleep(100);
  st = await p.evaluate(() => pixelsPerSecond());
  check('つまむと、バーが短くなる', st < z1 * 0.7, `${z1} → ${st}`);
  // 1本を離したあと、残った指を動かしても表示は動かない
  const t1 = await p.evaluate(() => displayTime());
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx - 40, y: cy, id: 1 }, { x: cx + 40, y: cy, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [{ x: cx - 40, y: cy, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - 140, y: cy, id: 1 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(100);
  check('ピンチの後に残った指を動かしても、表示は動かない', Math.abs((await p.evaluate(() => displayTime())) - t1) < 0.01);
  // 1本指のなぞる操作は今まで通り
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy, id: 3 }] });
  for (let i = 1; i <= 6; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx - i * 20, y: cy, id: 3 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(100);
  check('1本指でなぞると、今まで通り表示が動く', (await p.evaluate(() => displayTime())) - t1 > 0.3);
  // 記憶
  const zs = await p.evaluate(() => pixelsPerSecond());
  await p.reload(); await p.click('#demoBtn'); await sleep(300);
  check('再読み込みしても、バーの長さが残る', (await p.evaluate(() => pixelsPerSecond())) === zs, String(zs));
  check('ページのエラーなし', !errs.length, errs.join(' / '));

  // ---- パソコン：Ctrl＋ホイール ----
  console.log('パソコン（1280×800）');
  const q = await b.newPage({ viewport: { width: 1280, height: 800 } });
  q.on('pageerror', (e) => errs.push(e.message));
  await q.route(/fonts\.g/, (r) => r.abort());
  await q.goto(URL);
  await q.click('#demoBtn'); await sleep(300);
  await q.evaluate(() => { panToTime(6); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); }); await sleep(150);
  const qb = await q.locator('#roll').boundingBox();
  const mx = qb.x + qb.width * 0.7, my = qb.y + qb.height * 0.5;
  const zq = await q.evaluate(() => pixelsPerSecond());
  const tq = await q.evaluate((x) => timeAtX(x), mx - qb.x);
  await q.mouse.move(mx, my);
  await q.keyboard.down('Control'); await q.mouse.wheel(0, -100); await q.keyboard.up('Control'); await sleep(100);
  st = await q.evaluate((x) => ({ z: pixelsPerSecond(), t: timeAtX(x) }), mx - qb.x);
  check('Ctrl＋ホイール（上1目盛り）で、バーが長くなる（約1.3倍）', st.z > zq * 1.2 && st.z < zq * 1.35, `${zq} → ${st.z}`);
  check('マウスの下の時刻が、マウスの下に残る', Math.abs(st.t - tq) < 0.1, `${tq.toFixed(2)} → ${st.t.toFixed(2)}`);
  const t2 = await q.evaluate(() => displayTime());
  await q.mouse.wheel(0, 100); await sleep(100);
  check('Ctrlなしのホイールは、今まで通り音域の移動（バーの長さは変わらない）', (await q.evaluate(() => pixelsPerSecond())) === st.z && Math.abs((await q.evaluate(() => displayTime())) - t2) < 0.01);
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
