const { chromium } = require('playwright');
require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
const path = require('path'); const fs = require('fs'); const http = require('http');
const ROOT = path.join(__dirname, '..');
const server = http.createServer((q, r) => { r.writeHead(200, {'content-type':'text/html; charset=utf-8'}); r.end(fs.readFileSync(ROOT + '/index.html')); }).listen(0);
(async () => {
  const b = await chromium.launch();
  for (const [w, h] of [[390, 844], [375, 667]]) {
    const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await c.newPage();
    await p.route(/fonts\.g/, (r) => r.abort());
    await p.goto('http://localhost:' + server.address().port + '/');
    for (const f of ['demo', 'long_5parts.mid']) {
      if (f === 'demo') await p.click('#demoBtn'); else await p.setInputFiles('#fileIn', path.join(ROOT, 'tests', 'midi', f));
      await p.waitForTimeout(300);
      const pos = await p.evaluate(() => {
        const r = (id) => { const e = document.getElementById(id).getBoundingClientRect(); return Math.round(e.top) + '〜' + Math.round(e.bottom); };
        return { 画面の高さ: innerHeight, パート欄: r('parts'), 音程バー: r('rollWrap'), 再生ボタン: r('playBtn'), 録音ボタン: r('recBtn') };
      });
      console.log(`${w}x${h} ${f}:`, JSON.stringify(pos));
      if (f !== 'demo') await p.screenshot({ path: ROOT + `/tests/out/09_mobile_5parts_${w}.png` });
    }
    await c.close();
  }
  await b.close(); server.close();
})();
