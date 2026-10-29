// 画面写真と配置の確認（スマホ相当の表示領域：Safariのツールバー分を引いた高さも試す）
require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
const { chromium } = require('playwright');
const path = require('path'); const fs = require('fs'); const http = require('http');
const ROOT = path.join(__dirname, '..');
const server = http.createServer((q, r) => { r.writeHead(200, {'content-type':'text/html; charset=utf-8'}); r.end(fs.readFileSync(ROOT + '/index.html')); }).listen(0);
const sizes = process.argv.slice(2).length ? process.argv.slice(2) : ['390x664', '375x548', '412x780', '1200x900'];
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const sz of sizes) {
    const [w, h] = sz.split('x').map(Number);
    for (const scheme of ['light', 'dark']) {
      if (scheme === 'dark' && w > 700) continue;
      const mobile = w <= 700;
      const c = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: mobile, hasTouch: mobile, colorScheme: scheme });
      const p = await c.newPage();
      const errs = [];
      p.on('pageerror', (e) => errs.push(e.message));
      await p.route(/fonts\.g/, (r) => r.abort());
      await p.goto('http://localhost:' + server.address().port + '/');
      await p.screenshot({ path: ROOT + `/tests/out/v2_${sz}_${scheme}_0start.png` });
      await p.setInputFiles('#fileIn', path.join(ROOT, 'tests', 'midi', 'long_5parts.mid'));
      await p.waitForTimeout(300);
      await p.click('#loopBtn');
      await p.click('#playBtn');
      await p.waitForTimeout(1300);
      const pos = await p.evaluate(() => {
        const r = (id) => { const e = document.getElementById(id).getBoundingClientRect(); return [Math.round(e.top), Math.round(e.bottom)]; };
        return { vh: innerHeight, sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, roll: r('rollWrap'), bar: r('transport'), chips: r('partBar'), play: r('playBtn') };
      });
      const rollVisible = pos.roll[0] >= 0 && pos.roll[1] <= pos.bar[0] + 1;
      const playVisible = pos.play[0] >= 0 && pos.play[1] <= pos.vh;
      console.log(`${sz} ${scheme}: 音程バー ${pos.roll} 操作バー ${pos.bar} 画面高 ${pos.vh} → バー全体が見える:${rollVisible} 再生ボタンが見える:${playVisible} 横はみ出し:${pos.sw > pos.cw}`, errs.length ? 'エラー:' + errs.join(';') : '');
      await p.screenshot({ path: ROOT + `/tests/out/v2_${sz}_${scheme}_1count.png` });
      await p.waitForTimeout(2600);
      await p.screenshot({ path: ROOT + `/tests/out/v2_${sz}_${scheme}_2play.png` });
      await c.close();
    }
  }
  await b.close(); server.close();
})();
