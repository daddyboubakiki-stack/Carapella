// しおり（ピアノロールで指定する区間）と、「ずれ」欄の高さが変わらないこと（画面の揺れ）のテスト
// 使い方：node tests/marks.js [幅] [高さ]（既定 1280x800）
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const T = path.join(__dirname, '..'); const W = +(process.argv[2] || 1280), H = +(process.argv[3] || 800);
fs.mkdirSync(path.join(T, 'tests', 'out'), { recursive: true });
const src = fs.readFileSync(path.join(T, 'tests/e2e2.js'), 'utf8');
const HARNESS = eval('(' + src.match(/const HARNESS = (\(\) => \{[\s\S]*?\n\});/)[1] + ')');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(T, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, "Object.assign(window, { S, T, loopRange, seekTo, viewTime }); Object.defineProperty(window, 'marking', { get: () => marking }); })();</script></body>")); }).listen(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log((ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H }, hasTouch: W < 700 });
  await ctx.addInitScript(HARNESS);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.g/, (r) => r.abort());
  const url = 'http://localhost:' + server.address().port + '/';
  await p.goto(url);
  await p.click('#demoBtn'); await sleep(300);
  await p.click('#loopBtn'); await sleep(100);
  await p.click('#markBtn'); await sleep(100);
  check('しおり作り中', await p.evaluate(() => !!marking));
  const box = await p.locator('#roll canvas, .roll canvas').first().boundingBox();
  const y = box.y + Math.min(box.height / 2, 80);
  // ドラッグで作る
  await p.mouse.move(box.x + box.width * 0.35, y); await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.5, y, { steps: 5 }); await p.mouse.move(box.x + box.width * 0.6, y, { steps: 5 });
  await p.mouse.up(); await sleep(150);
  let st = await p.evaluate(() => ({ marks: S.marks, loop: S.loop, range: loopRange(), pos: T.pos, chips: document.querySelectorAll('#marks .chip').length, seek: document.querySelectorAll('#seekMarks span').length, marking }));
  check('なぞるとしおりが1つでき、区間になる', st.marks.length === 1 && st.loop.mark === st.marks[0].id && st.chips === 1 && st.seek === 1, JSON.stringify(st.marks));
  check('区間はしおりの時刻どおり・表示は始まりへ', Math.abs(st.range[0] - st.marks[0].a) < 1e-6 && Math.abs(st.range[1] - st.marks[0].b) < 1e-6 && Math.abs(st.pos - st.marks[0].a) < 1e-6, JSON.stringify(st.range));
  check('作り終わると、しおり作りは終わる', st.marking === null);
  // タップ2回で作る（先へ動かしてから）
  await p.evaluate(() => seekTo(8));
  await p.click('#markBtn');
  await p.mouse.click(box.x + box.width * 0.4, y); await sleep(80);
  check('1回目のタップで始まりが決まる', await p.evaluate(() => marking && marking.a != null));
  await p.mouse.click(box.x + box.width * 0.7, y); await sleep(150);
  st = await p.evaluate(() => ({ marks: S.marks.map((m) => [m.name, m.a, m.b]), mark: S.loop.mark, ids: S.marks.map((m) => m.id) }));
  check('タップ2回で2つ目ができ、選ばれる', st.marks.length === 2 && st.mark === st.ids[1], JSON.stringify(st.marks));
  // 選び直し
  await p.locator('#marks .chip').first().click(); await sleep(100);
  st = await p.evaluate(() => ({ mark: S.loop.mark, id0: S.marks[0].id, on: [...document.querySelectorAll('#seekMarks span')].map((e) => e.className) }));
  check('チップで別のしおりを選べる・再生バーの帯も切り替わる', st.mark === st.id0 && st.on[0] === 'on' && st.on[1] === '', JSON.stringify(st.on));
  // 区間リピートで再生 → 区間の中だけを繰り返す
  await p.evaluate(() => { const c = document.getElementById('countIn'); if (c.checked) c.click(); });
  const [a, bb] = await p.evaluate(() => loopRange());
  await p.click('#playBtn');
  let minT = 1e9, maxT = -1, wrapped = false, prev = -1;
  const dur = (bb - a) * 2.6 * 1000 + 1500;
  for (let t0 = Date.now(); Date.now() - t0 < dur;) { const v = await p.evaluate(() => viewTime()); if (v < prev - 0.3) wrapped = true; prev = v; minT = Math.min(minT, v); maxT = Math.max(maxT, v); await sleep(60); }
  await p.click('#playBtn');
  check('しおりの区間を繰り返し再生する', wrapped && minT >= a - 0.05 && maxT <= bb + 0.6, `区間 ${a.toFixed(2)}〜${bb.toFixed(2)}、再生 ${minT.toFixed(2)}〜${maxT.toFixed(2)}、戻った=${wrapped}`);
  // 小節で動かすと、しおりから外れる
  await p.click('#loopB\\+'); await sleep(80);
  st = await p.evaluate(() => ({ mark: S.loop.mark, t: S.loop.t }));
  check('小節の＋−で動かすと、小節の区間に戻る', st.mark === null && st.t === null);
  // 再読み込みしても残る
  await p.reload(); await p.click('#demoBtn'); await sleep(300);
  st = await p.evaluate(() => S.marks.length);
  check('再読み込みしても、同じ曲のしおりが残る', st === 2);
  await p.click('#loopBtn');
  await p.locator('#marks .iconbtn').first().click(); await sleep(80);
  st = await p.evaluate(() => [S.marks.length, JSON.parse(localStorage.getItem('acapella-renshucho:marks:v1'))]);
  check('×で消せる（記憶からも消える）', st[0] === 1 && Object.values(st[1])[0].length === 1);
  await p.screenshot({ path: path.join(T, 'tests/out/marks_' + W + '.png') });
  // Escでやめる
  await p.click('#markBtn'); await p.keyboard.press('Escape'); await sleep(50);
  check('Escでしおり作りをやめる', await p.evaluate(() => marking === null));
  // 「ずれ」欄：いちばん長い表示でも高さが変わらず、欠けない（変わると下の音程バーごと揺れる）
  const hs = await p.evaluate(() => {
    const sv = '<svg viewBox="0 0 14 14"><circle cx="7" cy="7" r="6" fill="currentColor"/></svg>';
    const out = [];
    for (const [d, v] of [['', ''], ['−99<span class="u">セント</span>', '低め・上げて'], ['1<span class="u">オクターブ下</span>', '合っています'], ['−11<span class="u">半音</span>', '高め・下げて']]) {
      document.getElementById('hDiff').innerHTML = d || '—';
      document.getElementById('hVerdict').innerHTML = v ? sv + '<span>' + v + '</span>' : '';
      const cut = [...document.querySelectorAll('#hDiffBox .v, #hVerdict span')].some((e) => e.scrollWidth > e.clientWidth + 1);
      out.push([document.getElementById('hDiffBox').offsetHeight, cut]);
    }
    return out;
  });
  check('「ずれ」欄の高さが表示によって変わらない', hs.every((h) => h[0] === hs[0][0]), JSON.stringify(hs.map((h) => h[0])));
  check('「ずれ」欄の文字が欠けない（幅360以上）', W < 360 || hs.every((h) => !h[1]));
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果（${W}x${H}）：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
