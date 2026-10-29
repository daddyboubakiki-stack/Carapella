// パートごとの音量（最大150%）・バーの色（パート順の初期色・変更・記憶）のテスト
// 使い方：node tests/parts.js
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, "Object.assign(window, { S, A }); })();</script></body>");
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(0);
const URL = 'http://localhost:' + server.address().port + '/';
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log('  ' + (ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.g/, (r) => r.abort());
  await p.goto(URL);
  await p.setInputFiles('#fileIn', path.join(__dirname, 'midi', 'long_5parts.mid'));
  await p.waitForTimeout(400);
  let st = await p.evaluate(() => S.pstate.map((x) => x.color));
  check('5パートの初期色：赤・橙・青・緑・紫', JSON.stringify(st) === JSON.stringify(['#E5484D', '#F08C2E', '#3B82F6', '#2FA56A', '#8E5BD9']), JSON.stringify(st));
  const vol = await p.evaluate(() => { const v = document.querySelector('#parts .part .vol input'); return [v.value, v.max, document.querySelector('#parts .part .vol output').textContent]; });
  check('音量の初期値は100%、最大は150%', vol[0] === '100' && vol[1] === '150' && vol[2] === '100%', vol.join(' / '));
  await p.click('#playBtn'); await p.waitForTimeout(300);
  await p.evaluate(() => { const v = document.querySelector('#parts .part .vol input'); v.value = '150'; v.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(300);
  st = await p.evaluate(() => [A.partGains[0].gain.value, A.partGains[1].gain.value]);
  check('150%で音の大きさが100%の1.5倍', Math.abs(st[0] / st[1] - 1.5) < 0.01, st.map((x) => x.toFixed(3)).join(' / '));
  await p.click('#playBtn');
  // 色を変える → 再読み込み後も残る
  await p.evaluate(() => { const c = document.querySelectorAll('#parts .pcolor')[2]; c.value = '#00aa88'; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true })); });
  st = await p.evaluate(() => [S.pstate[2].color, getComputedStyle(document.querySelectorAll('#chips .chip')[2]).getPropertyValue('--pc').trim()]);
  check('色を変えると、パートのチップにも反映', st[0] === '#00aa88' && st[1] === '#00aa88', st.join(' / '));
  await p.reload();
  await p.setInputFiles('#fileIn', path.join(__dirname, 'midi', 'long_5parts.mid'));
  await p.waitForTimeout(400);
  st = await p.evaluate(() => S.pstate.map((x) => x.color));
  check('再読み込みしても、同じ曲の色が残る', st[2] === '#00aa88' && st[0] === '#E5484D', JSON.stringify(st));
  // 6パート以上・3パートの曲
  await p.click('#demoBtn'); await p.waitForTimeout(300);
  st = await p.evaluate(() => S.pstate.map((x) => x.color));
  check('3パートの曲は 赤・橙・青', JSON.stringify(st) === JSON.stringify(['#E5484D', '#F08C2E', '#3B82F6']), JSON.stringify(st));
  // パートを切り替えても、選んでいるしおりの表示が消えない
  await p.click('#loopBtn'); await p.click('#markBtn');
  const box = await p.locator('.roll canvas').boundingBox();
  await p.mouse.move(box.x + box.width * 0.35, box.y + 80); await p.mouse.down(); await p.mouse.move(box.x + box.width * 0.6, box.y + 80, { steps: 6 }); await p.mouse.up();
  await p.locator('#chips .chip').nth(1).click();
  st = await p.evaluate(() => document.querySelector('#marks .chip').getAttribute('aria-checked'));
  check('パートを切り替えても、選んでいるしおりは選ばれたまま', st === 'true', st);
  st = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--mine').trim());
  check('自分のパートの色が凡例などに伝わる', st === '#F08C2E', st);
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
