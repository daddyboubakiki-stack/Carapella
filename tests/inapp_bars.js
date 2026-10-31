// LINEなどアプリの中のブラウザ：上下のバーが出入りして画面の高さが少し変わっても、音程バーの高さを伸び縮みさせない。
// 実機のLINEの代わりに、Chromiumの画面の高さを変えてまねる（実機・LINE内ブラウザでの確認は別）。
// 使い方：node tests/inapp_bars.js
const { chromium } = require('playwright');
const fs = require('fs'), http = require('http'), path = require('path');
const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log('  ' + (ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(fs.readFileSync(ROOT + '/index.html')); }).listen(0);
(async () => {
  const b = await chromium.launch();
  const c = await b.newContext({ viewport: { width: 390, height: 700 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await c.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.g/, (r) => r.abort());
  await p.goto('http://localhost:' + server.address().port + '/');
  await p.setInputFiles('#fileIn', path.join(ROOT, 'tests', 'midi', 'long_5parts.mid')); await sleep(400);
  const roll = async (h) => { await p.setViewportSize({ width: 390, height: h }); await sleep(250); return p.evaluate(() => Math.round(document.getElementById('rollWrap').getBoundingClientRect().height)); };
  const h700 = await roll(700);
  const h640 = await roll(640); // バーが出る
  const back = await roll(700); // バーが隠れる
  const again = await roll(640); // もう一度出る
  check('バーの出入り（高さ60px）で、音程バーの高さが変わらない', back === h640 && again === h640, JSON.stringify({ h700, h640, back, again }));
  const tall = await roll(900); // 画面そのものが大きくなった（分割画面の変更など）
  check('画面が大きく変わった時は、音程バーも合わせて変わる', tall > h640, JSON.stringify({ h640, tall }));
  await p.setViewportSize({ width: 700, height: 390 }); await sleep(250);
  await p.setViewportSize({ width: 390, height: 700 }); await sleep(250);
  const rot = await p.evaluate(() => Math.round(document.getElementById('rollWrap').getBoundingClientRect().height));
  check('縦横を回して戻すと、その時の画面の高さで測り直す', rot === h700, JSON.stringify({ h700, rot }));
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; server.close(); });
