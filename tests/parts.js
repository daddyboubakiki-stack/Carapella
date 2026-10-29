// パートごとの音量（最大200%）・バーの色（パート順の初期色・変更・記憶）・音色のテスト
// 使い方：node tests/parts.js
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, "Object.assign(window, { S, A }); })();</script></body>");
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); }).listen(0);
const URL = 'http://localhost:' + server.address().port + '/';
// マイクの代わりにガイド音を流し込む仕掛け（e2e2.js と同じもの）
const e2e = fs.readFileSync(path.join(__dirname, 'e2e2.js'), 'utf8');
const HARNESS = eval('(' + e2e.match(/const HARNESS = (\(\) => \{[\s\S]*?\n\});/)[1] + ')');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  check('音量の初期値は100%、最大は200%', vol[0] === '100' && vol[1] === '200' && vol[2] === '100%', vol.join(' / '));
  await p.click('#playBtn'); await p.waitForTimeout(300);
  await p.evaluate(() => { const v = document.querySelector('#parts .part .vol input'); v.value = '200'; v.dispatchEvent(new Event('input', { bubbles: true })); });
  await p.waitForTimeout(300);
  st = await p.evaluate(() => [A.partGains[0].gain.value, A.partGains[1].gain.value]);
  check('200%で音の大きさが100%の2倍', Math.abs(st[0] / st[1] - 2) < 0.01, st.map((x) => x.toFixed(3)).join(' / '));
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
  // 音色：変えると記憶され、試し聴きの音が鳴る
  await p.setInputFiles('#fileIn', path.join(__dirname, 'midi', 'long_5parts.mid'));
  await p.waitForTimeout(300);
  await p.evaluate(() => { const t = document.querySelectorAll('#parts .part select')[4]; t.value = 'voice'; t.dispatchEvent(new Event('change', { bubbles: true })); });
  await p.reload();
  await p.setInputFiles('#fileIn', path.join(__dirname, 'midi', 'long_5parts.mid'));
  await p.waitForTimeout(300);
  st = await p.evaluate(() => [S.pstate.map((x) => x.tone), S.pstate[2].color]);
  check('音色を変えると、再読み込みしても残る（色も残る）', st[0][4] === 'voice' && st[0][0] === 'soft' && st[1] === '#00aa88', JSON.stringify(st));
  check('ページのエラーなし', !errs.length, errs.join(' / '));

  // 音色ごとに、音程の判定が変わらないか（ガイドの音をそのまま「歌った声」としてマイクに入れる）
  console.log('  音色ごとの判定（ぴったり→高い一致、半音高い→ほぼ0%）');
  const ctx2 = await b.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx2.addInitScript(HARNESS);
  const q = await ctx2.newPage();
  q.on('pageerror', (e) => errs.push(e.message));
  await q.route(/fonts\.g/, (r) => r.abort());
  await q.goto(URL);
  await q.click('#demoBtn'); await sleep(300);
  await q.click('#micBtn'); await sleep(400);
  await q.evaluate(() => {
    const c = document.getElementById('countIn'); if (c.checked) c.click();
    document.getElementById('partMix').open = true;
    // 自分のパート（1番手）だけを鳴らす
    document.querySelectorAll('#parts .part').forEach((el, i) => { const m = el.querySelector('.iconbtn'); if ((m.getAttribute('aria-pressed') === 'true') !== (i !== 0)) m.click(); });
  });
  const sing = async (detune) => {
    await q.evaluate((d) => { window.__detune = d; const e = document.getElementById('seek'); e.value = '0'; e.dispatchEvent(new Event('change')); }, detune);
    await q.click('#playBtn'); await sleep(6000);
    const t = await q.textContent('#scoreLbl');
    await q.click('#playBtn');
    const m = /(\d+)%/.exec(t); return m ? Number(m[1]) : null;
  };
  for (const tone of ['soft', 'clear', 'voice', 'organ']) {
    await q.evaluate((t) => { const s = document.querySelector('#parts .part select'); s.value = t; s.dispatchEvent(new Event('change', { bubbles: true })); }, tone);
    const ok = await sing(0), semi = await sing(100);
    check(`${tone}：ぴったり ${ok}%・半音高い ${semi}%`, ok != null && ok >= 95 && semi != null && semi <= 5);
  }
  console.log(`結果：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
