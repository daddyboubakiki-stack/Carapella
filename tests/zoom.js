// バーの長さ（横の拡大）と音の間隔（縦の拡大）を、2本指のピンチ・Ctrl（＋Shift）＋ホイールで変えるテスト
// 使い方：node tests/zoom.js
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const EXPOSE = "Object.assign(window, { S, view, displayTime, pixelsPerSecond, panToTime, timeAtX, seekTo, viewRange, kick, setVZoom }); Object.defineProperty(window, 'pick', { get: () => pick });";
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, EXPOSE + ' })();</script></body>')); }).listen(0);
const URL = 'http://localhost:' + server.address().port + '/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log('  ' + (ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };

(async () => {
  const b = await chromium.launch();
  // ---- スマホ：2本指のピンチ ----
  console.log('スマホ（390×664、タッチ）');
  const ctx = await b.newContext({ viewport: { width: 390, height: 664 }, hasTouch: true, isMobile: true });
  // 左の音名欄に描いた文字（文字・大きさ・位置）を記録する
  await ctx.addInitScript(() => {
    window.__labels = [];
    const ft = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
      if (this.textAlign === 'right' && x < 60) window.__labels.push({ text, y, px: Number((/(\d+)px/.exec(this.font) || [])[1]) });
      return ft.call(this, text, x, y, ...rest);
    };
  });
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

  // ---- 縦：2本指を縦に広げる・つまむと、音の間隔が変わる ----
  await p.evaluate(() => { panToTime(6); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); }); await sleep(150);
  const vb = await p.locator('#roll').boundingBox();
  const vx = vb.x + vb.width * 0.6, vy = vb.y + vb.height * 0.5;
  const twoV = (type, half) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: vx + 3, y: vy - half, id: 1 }, { x: vx - 3, y: vy + half, id: 2 }] });
  const hz = await p.evaluate(() => pixelsPerSecond());
  const r0 = await p.evaluate(() => viewRange());
  await twoV('touchStart', 15);
  for (let h = 20; h <= 30; h += 5) await twoV('touchMove', h);
  await twoV('touchEnd'); await sleep(100);
  st = await p.evaluate(() => ({ v: view.verticalZoom, r: viewRange(), z: pixelsPerSecond(), slider: document.getElementById('verticalZoom').value, reset: document.getElementById('pitchViewReset').disabled }));
  const mid = (r) => (r[0] + r[1]) / 2;
  check('縦に広げると、音の間隔が広がる（指の間が約2倍→約200%、表示する段が減る）', st.v >= 1.9 && st.v <= 2 && st.r[1] - st.r[0] < r0[1] - r0[0], JSON.stringify({ r0, ...st }));
  check('縦のピンチでは、バーの長さは変わらない', st.z === hz, hz + ' → ' + st.z);
  check('拡大の中心は、見えていた範囲の真ん中のまま（今の音に合わせて動かない）', Math.abs(mid(st.r) - mid(r0)) <= 0.5, JSON.stringify([r0, st.r]));
  check('設定の「縦の拡大」も同じ値になり、「音域を戻す」が押せる', st.slider === String(Math.round(st.v * 100)) && !st.reset, JSON.stringify(st));
  await twoV('touchStart', 60);
  for (let h = 45; h >= 15; h -= 15) await twoV('touchMove', h);
  await twoV('touchEnd'); await sleep(100);
  st = await p.evaluate(() => ({ v: view.verticalZoom, r: viewRange() }));
  check('縦につまむと、音の間隔が狭まる（表示する段が増える）', st.v < 0.6 && st.r[1] - st.r[0] > r0[1] - r0[0], JSON.stringify(st));
  // 横のピンチでは、縦の拡大は変わらない
  await two('touchStart', 30); await two('touchMove', 50); await two('touchEnd'); await sleep(100);
  check('横のピンチでは、音の間隔は変わらない', (await p.evaluate(() => view.verticalZoom)) === 0.5);
  // 斜めの指で始めても、指を離すまで方向は変わらない（横寄り→横だけ）
  const vz1 = await p.evaluate(() => view.verticalZoom), hz1 = await p.evaluate(() => pixelsPerSecond());
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: vx - 30, y: vy - 20, id: 1 }, { x: vx + 30, y: vy + 20, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: vx - 30, y: vy - 60, id: 1 }, { x: vx + 30, y: vy + 60, id: 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(100);
  st = await p.evaluate(() => ({ v: view.verticalZoom, z: pixelsPerSecond() }));
  check('横寄りの指で始めたピンチは、途中で縦に広げても横だけが変わる', st.v === vz1 && st.z !== hz1, JSON.stringify({ vz1, hz1, ...st }));

  // 25%：文字が9px以上で、重ならない。目標の音の名前は出る。範囲は MIDI −12〜139 の中
  const labelsAt = async (v, offset) => {
    await p.evaluate(([v, o]) => { setVZoom(v); if (o != null) { view.pitchOffset = o; } window.__labels = []; kick(); }, [v, offset]);
    await sleep(150);
    return p.evaluate(() => ({ labels: window.__labels.slice(), r: viewRange() }));
  };
  for (const [v, o, name] of [[0.25, 0, '25%'], [0.25, 200, '25%・上の端まで動かす'], [0.25, -200, '25%・下の端まで動かす'], [2.5, 0, '250%']]) {
    st = await labelsAt(v, o);
    if (o) { await p.evaluate(() => { setVZoom(view.verticalZoom); window.__labels = []; kick(); }); await sleep(150); st = await p.evaluate(() => ({ labels: window.__labels.slice(), r: viewRange() })); }
    const ys = st.labels.map((l) => l.y).sort((a, b) => a - b);
    const minGap = ys.slice(1).reduce((m, y, i) => Math.min(m, y - ys[i]), Infinity);
    const minPx = Math.min(...st.labels.map((l) => l.px));
    check(`縦${name}：音名の文字は9px以上で重ならない、範囲は −12〜139 の中`, st.labels.length > 0 && minPx >= 9 && minGap >= minPx && st.r[0] >= -12 && st.r[1] <= 139,
      `${st.labels.length}個、最小 ${minPx}px、最小間隔 ${minGap.toFixed(1)}px、範囲 ${JSON.stringify(st.r)}`);
  }
  // 目標の音の名前（マイクの判定対象）は、縦に縮めても出る：目標を直接与えて確かめる
  await p.evaluate(() => { setVZoom(0.25); view.pitchOffset = 0; S.live = { midi: null, target: 64, cents: null, ok: null }; window.__labels = []; kick(); }); await sleep(150);
  st = await p.evaluate(() => window.__labels.map((l) => l.text));
  check('縦25%でも、目標の音（E4）の名前は出る', st.includes('E4'), JSON.stringify(st));
  await p.evaluate(() => { S.live = null; });
  st = await p.evaluate(() => { setVZoom(0.05); const lo = view.verticalZoom; setVZoom(9); return [lo, view.verticalZoom]; });
  check('縦の拡大は25%〜250%で止まる', st[0] === 0.25 && st[1] === 2.5, JSON.stringify(st));
  // 250%でも、音符のタップで選べる（当たり判定が表示と合っている）
  await p.evaluate(() => { setVZoom(2.5); view.pitchOffset = 0; panToTime(6); }); await sleep(150);
  const tn = await p.evaluate(() => {
    const cv = document.getElementById('roll'), r = cv.getBoundingClientRect();
    const top = 24, bot = view.h - 6, [lo, hi] = viewRange(), rowH = (bot - top) / (hi - lo + 1);
    const playX = 56 + (view.w - 56) * 0.3, tv = displayTime(), px = pixelsPerSecond();
    for (const n of S.song.parts[S.sel].notes) {
      const xm = playX + ((n.s + n.e) / 2 - tv) * px, y = top + (hi + 0.5 - n.m) * rowH;
      if (xm > 80 && xm < view.w - 20 && y > top + 4 && y < bot - 4) return { x: r.left + xm, y: r.top + y, m: n.m };
    }
  });
  if (tn) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tn.x, y: tn.y, id: 9 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(150);
  }
  st = await p.evaluate(() => pick && pick.note.m);
  check('縦250%でも、音符をタップすると、その音符が選ばれる', tn && st === tn.m, JSON.stringify({ tn, picked: st }));
  await p.keyboard.press('Escape');
  await p.screenshot({ path: path.join(ROOT, 'tests/out/vzoom_250.png') });
  await p.evaluate(() => { setVZoom(0.25); window.scrollTo(0, 0); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); }); await sleep(150);
  await p.screenshot({ path: path.join(ROOT, 'tests/out/vzoom_25.png') });
  // 「音域を戻す」で100%と元の位置に戻る・記憶
  await p.evaluate(() => { setVZoom(1.5); }); await p.evaluate(() => document.getElementById('verticalZoom').dispatchEvent(new Event('change')));
  await p.reload(); await p.click('#demoBtn'); await sleep(300);
  check('再読み込みしても、音の間隔が残る', (await p.evaluate(() => view.verticalZoom)) === 1.5);
  await p.click('#pitchViewReset'); await sleep(100);
  st = await p.evaluate(() => ({ v: view.verticalZoom, off: view.pitchOffset, slider: document.getElementById('verticalZoomValue').textContent, dis: document.getElementById('pitchViewReset').disabled }));
  check('「音域を戻す」で、音の間隔も100%に戻る', st.v === 1 && st.off === 0 && st.slider === '100%' && st.dis, JSON.stringify(st));
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
  const vq = await q.evaluate(() => view.verticalZoom);
  await q.keyboard.down('Control'); await q.keyboard.down('Shift'); await q.mouse.wheel(0, -100); await q.keyboard.up('Shift'); await q.keyboard.up('Control'); await sleep(100);
  const vq2 = await q.evaluate(() => ({ v: view.verticalZoom, z: pixelsPerSecond() }));
  check('Ctrl＋Shift＋ホイール（上）で、音の間隔が広がる（バーの長さは変わらない）', vq2.v > vq * 1.2 && vq2.z === st.z, JSON.stringify({ vq, ...vq2 }));
  check('Ctrlなしのホイールは、今まで通り音域の移動（バーの長さは変わらない）', (await q.evaluate(() => pixelsPerSecond())) === st.z && Math.abs((await q.evaluate(() => displayTime())) - t2) < 0.01);
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
