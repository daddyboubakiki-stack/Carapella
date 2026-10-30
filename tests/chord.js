// 和音練習（一人用）のテスト：和音の区切り・押した時刻の和音・お手本／合わせるで鳴るパート・判定・戻る
// 使い方：node tests/chord.js [幅] [高さ]（既定 1280x800）
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const ROOT = path.join(__dirname, '..'); const W = +(process.argv[2] || 1280), H = +(process.argv[3] || 800);
fs.mkdirSync(path.join(ROOT, 'tests', 'out'), { recursive: true });
// マイクの代わりにガイド音を流し込む仕掛け（e2e2.js と同じもの）
const e2e = fs.readFileSync(path.join(__dirname, 'e2e2.js'), 'utf8');
const HARNESS = eval('(' + e2e.match(/const HARNESS = (\(\) => \{[\s\S]*?\n\});/)[1] + ')');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const EXPOSE = 'Object.assign(window, { S, T, CP, view, seekTo, addMark, chordAt, chordSegments, cpSeg, curTr, displayTime, viewRange, pixelsPerSecond, GUT });'
  + " Object.defineProperty(window, 'pick', { get: () => pick });";
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, EXPOSE + ' })();</script></body>')); }).listen(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log((ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };
const hz = (m) => Math.round(440 * Math.pow(2, (m - 69) / 12));
const sorted = (a) => JSON.stringify([...a].sort((x, y) => x - y));

(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ viewport: { width: W, height: H } });
  await ctx.addInitScript(HARNESS);
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.route(/fonts\.g/, (r) => r.abort());
  await p.goto('http://localhost:' + server.address().port + '/');
  await p.click('#demoBtn'); await sleep(300);

  // 1) 和音の区切り：同じ音の歌い直しは区切らない／休符は区切る
  let st = await p.evaluate(() => {
    const a = chordSegments([{ notes: [{ s: 0, e: 1, m: 60 }, { s: 1, e: 2, m: 60 }] }, { notes: [{ s: 0, e: 2, m: 64 }] }]);
    const c = chordSegments([{ notes: [{ s: 0, e: 2, m: 60 }] }, { notes: [{ s: 0, e: 1, m: 64 }] }]);
    const d = chordSegments([{ notes: [{ s: 0, e: 1, m: 60 }, { s: 1, e: 2, m: 62 }] }, { notes: [{ s: 0, e: 2, m: 64 }] }]);
    return { a: a.map((x) => [x.s, x.e]), c: c.map((x) => [x.s, x.e, x.notes]), d: d.map((x) => [x.s, x.e]) };
  });
  check('同じパートの同じ音の歌い直しは、和音の区切りにしない', JSON.stringify(st.a) === '[[0,2]]', JSON.stringify(st.a));
  check('休符（パートが止まる所）は区切りになる', st.c.length === 2 && st.c[1][2][1] === null, JSON.stringify(st.c));
  check('音が変わる所は区切りになる', JSON.stringify(st.d) === '[[0,1],[1,2]]', JSON.stringify(st.d));

  // 2) 長いしおりの中でも、押した時刻の和音から始める
  await p.evaluate(() => { addMark(0, 12); seekTo(6); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); });
  await sleep(200);
  const n = await p.evaluate(() => {
    const cv = document.getElementById('roll'), r = cv.getBoundingClientRect();
    const top = 24, bot = view.h - 6, [lo, hi] = viewRange(), rowH = (bot - top) / (hi - lo + 1);
    const playX = GUT + (view.w - GUT) * 0.3, tv = displayTime(), px = pixelsPerSecond(), tr = curTr();
    for (const n of S.song.parts[S.sel].notes) {
      if (n.s < 4 || n.e - n.s < 0.3) continue;
      const xm = playX + ((n.s + n.e) / 2 - tv) * px, y = top + (hi + 0.5 - (n.m + tr)) * rowH;
      if (xm > GUT + 20 && xm < view.w - 20) return { x: r.left + xm, y: r.top + y };
    }
  });
  await p.mouse.click(n.x, n.y); await sleep(100);
  check('タップのシートに「和音練習」がある', await p.isVisible('#cpBtn'));
  const tPick = await p.evaluate(() => pick.t);
  await p.click('#cpBtn'); await sleep(150);
  st = await p.evaluate((t) => ({ on: CP.on, seg: [cpSeg().s, cpSeg().e], chord: cpSeg().notes.filter((m) => m != null), at: chordAt(t).map((c) => c.m), mark: S.loop.t, bar: !document.getElementById('cpBar').hidden, sheet: !document.getElementById('pickSheet').hidden }), tPick);
  check('「和音練習」で、押した時刻の和音から始まる（しおりの始まりではない）', st.on && st.seg[0] <= tPick && tPick < st.seg[1] && sorted(st.chord) === sorted(st.at) && st.mark[0] === 0, JSON.stringify({ tPick, ...st }));
  check('和音練習の操作欄が出て、シートは隠れる', st.bar && !st.sheet);
  const saved = await p.evaluate(() => ({ ...CP.saved, mode: S.mode, score: S.score.n, trail: S.trail.length }));

  // 3) お手本＝全パート（ミュートしたパートも鳴る）、合わせる＝自分以外
  await p.evaluate(() => { S.pstate[1].muted = true; });
  let before = await p.evaluate(() => window.__starts.length);
  await p.click('#cpDemo'); await sleep(150);
  st = await p.evaluate((b) => ({ f: window.__starts.slice(b).map((x) => Math.round(x.f)), all: cpSeg().notes.filter((m) => m != null).map((m) => m + curTr()), pressed: document.getElementById('cpDemo').getAttribute('aria-pressed') }), before);
  check('「お手本」で全パートの音が鳴る（ミュートしたパートも）', sorted(st.f) === sorted(st.all.map(hz)) && st.pressed === 'true', JSON.stringify(st));
  await p.click('#cpDemo'); await sleep(100);
  check('もう一度押すと止まる', (await p.evaluate(() => CP.kind)) === null);
  before = await p.evaluate(() => window.__starts.length);
  await p.click('#cpSing'); await sleep(600);
  st = await p.evaluate((b) => ({ f: window.__starts.slice(b).map((x) => Math.round(x.f)), others: cpSeg().notes.map((m, i) => (i === S.sel || m == null ? null : m + curTr())).filter((m) => m != null), mic: !!document.getElementById('micBtn').getAttribute('aria-pressed') }), before);
  check('「合わせる」で自分以外のパートだけが鳴る', sorted(st.f) === sorted(st.others.map(hz)), JSON.stringify(st));
  await p.click('#cpSing'); await sleep(100);
  await p.evaluate(() => { S.pstate[1].muted = false; });

  // 4) 判定：自分の音だけをマイクに入れる（ほかのパートの音量を0にして「お手本」）
  await p.evaluate(() => { S.pstate.forEach((st, i) => { if (i !== S.sel) st.vol = 0; }); window.__detune = 0; CP.trail = []; });
  if ((await p.getAttribute('#micBtn', 'aria-pressed')) !== 'true') await p.click('#micBtn');
  await sleep(300);
  await p.click('#cpDemo'); await sleep(2000);
  st = await p.evaluate(() => ({ ok: CP.trail.filter((x) => x.m != null && x.ok).length, off: CP.trail.filter((x) => x.m != null && x.ok === false).length, diff: document.getElementById('hDiff').textContent }));
  check('ぴったりの声は「合っている」の線になる', st.ok > 20 && st.off < st.ok * 0.1, JSON.stringify(st));
  await p.click('#cpDemo'); await sleep(300);
  await p.evaluate(() => { window.__detune = 100; CP.trail = []; });
  await p.click('#cpDemo'); await sleep(2000);
  st = await p.evaluate(() => ({ ok: CP.trail.filter((x) => x.m != null && x.ok).length, off: CP.trail.filter((x) => x.m != null && x.ok === false).length }));
  check('半音高い声は「ずれ」の線になる', st.off > 20 && st.ok < st.off * 0.1, JSON.stringify(st));
  await p.evaluate(() => { window.__detune = 0; });
  await p.screenshot({ path: path.join(ROOT, 'tests/out/chord_' + W + '.png') });

  // 5) 前後の和音へ移る（鳴らしている時は新しい和音で鳴らし直す）
  const k0 = await p.evaluate(() => ({ i: CP.idx, key: cpSeg().key }));
  before = await p.evaluate(() => window.__starts.length);
  await p.click('#cpNext'); await sleep(150);
  st = await p.evaluate((b) => ({ i: CP.idx, key: cpSeg().key, f: window.__starts.slice(b).length, kind: CP.kind }), before);
  check('「次の和音」で、別の和音へ移り、鳴らし直す', st.i === k0.i + 1 && st.key !== k0.key && st.f > 0 && st.kind === 'demo', JSON.stringify({ k0, st }));
  await p.click('#cpPrev'); await sleep(100);
  check('「前の和音」で戻る', (await p.evaluate(() => CP.idx)) === k0.i);

  // 6) 曲の練習の線と点数には入れない
  st = await p.evaluate(() => ({ score: S.score.n, trail: S.trail.length }));
  check('和音練習の声は、曲の練習の線・音程一致に入らない', st.score === saved.score && st.trail === saved.trail, JSON.stringify({ saved, st }));

  // 7) 操作欄が画面の中に収まる
  const bb = await p.locator('#cpBar').boundingBox(), rb = await p.locator('#rollWrap').boundingBox();
  check('和音練習の操作欄が音程バーの中に収まる', bb.x >= rb.x - 0.5 && bb.x + bb.width <= rb.x + rb.width + 0.5 && bb.y >= rb.y - 0.5 && bb.y + bb.height <= rb.y + rb.height + 0.5, JSON.stringify({ bb, rb }));

  // 8) 戻る：音を止め、表示・位置・練習の段階を元に戻す
  await p.click('#cpBack'); await sleep(150);
  st = await p.evaluate(() => ({ on: CP.on, kind: CP.kind, follow: view.follow, time: view.time, off: view.pitchOffset, pos: T.pos, mode: S.mode, bar: !document.getElementById('cpBar').hidden }));
  check('「戻る」で和音練習を終え、表示と位置・練習の段階が元に戻る', !st.on && st.kind === null && !st.bar && st.follow === saved.follow && st.time === saved.time && st.off === saved.pitchOffset && st.pos === saved.pos && st.mode === saved.mode, JSON.stringify({ saved, st }));

  // 9) 和音練習中に「再生」を押すと、和音練習を終えて曲を再生する
  await p.evaluate(() => { S.pstate.forEach((st) => { st.vol = 0.7; }); });
  await p.mouse.click(n.x, n.y); await sleep(100);
  if (await p.isVisible('#cpBtn')) await p.click('#cpBtn');
  await sleep(100);
  await p.click('#playBtn'); await sleep(300);
  st = await p.evaluate(() => ({ on: CP.on, playing: T.playing }));
  check('和音練習中に「再生」を押すと、曲の再生に戻る', !st.on && st.playing, JSON.stringify(st));
  await p.click('#playBtn');

  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果（${W}x${H}）：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
