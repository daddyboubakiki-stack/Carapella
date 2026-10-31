// しおりの操作（長押し・タップ・表示の移動との区別）と、「ずれ」欄の高さが変わらないこと（画面の揺れ）のテスト
// 使い方：node tests/marks.js [幅] [高さ]（既定 1280x800）
const fs = require('fs'), http = require('http'), path = require('path');
const { chromium } = require('playwright');
const T = path.join(__dirname, '..'); const W = +(process.argv[2] || 1280), H = +(process.argv[3] || 800);
fs.mkdirSync(path.join(T, 'tests', 'out'), { recursive: true });
const src = fs.readFileSync(path.join(T, 'tests/e2e2.js'), 'utf8');
const HARNESS = eval('(' + src.match(/const HARNESS = (\(\) => \{[\s\S]*?\n\});/)[1] + ')');
// アプリの中の状態をテストから読めるよう、配信する時だけ window に出す
const EXPOSE = "Object.assign(window, { S, T, view, loopRange, seekTo, viewTime, displayTime, pixelsPerSecond, viewRange, curTr, fitRange, chordAt, playChord, noteAt, panToTime, GUT });"
  + " Object.defineProperty(window, 'pick', { get: () => pick }); Object.defineProperty(window, 'press', { get: () => press });";
const server = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(fs.readFileSync(path.join(T, 'index.html'), 'utf8').replace(/\}\)\(\);\s*<\/script>\s*<\/body>/, EXPOSE + ' })();</script></body>')); }).listen(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const check = (l, ok, d = '') => { if (!ok) fails++; console.log((ok ? 'OK ' : 'NG ') + l + (d ? '：' + d : '')); };

// 画面に見えている、自分のパートの音符（長さ minLen 秒以上）の真ん中の画面座標
const findNote = (p, minLen = 0.3, part = null) => p.evaluate(([minLen, part]) => {
  const cv = document.getElementById('roll'), r = cv.getBoundingClientRect();
  const top = 24, bot = view.h - 6, [lo, hi] = viewRange(), rowH = (bot - top) / (hi - lo + 1);
  const playX = GUT + (view.w - GUT) * 0.3, tv = displayTime(), px = pixelsPerSecond(), tr = curTr();
  const pi = part == null ? S.sel : part;
  for (const n of S.song.parts[pi].notes) {
    if (n.e - n.s < minLen) continue;
    const xm = playX + ((n.s + n.e) / 2 - tv) * px, y = top + (hi + 0.5 - (n.m + tr)) * rowH;
    if (xm > GUT + 20 && xm < view.w - 20 && y > top + 6 && y < bot - 6) return { x: r.left + xm, y: r.top + y, s: n.s, e: n.e, m: n.m, t: (n.s + n.e) / 2 };
  }
  return null;
}, [minLen, part]);
// 指定した開始時刻の音符（自分のパート）の画面座標
const noteXY = (p, start) => p.evaluate((start) => {
  const cv = document.getElementById('roll'), r = cv.getBoundingClientRect();
  const top = 24, bot = view.h - 6, [lo, hi] = viewRange(), rowH = (bot - top) / (hi - lo + 1);
  const playX = GUT + (view.w - GUT) * 0.3, tv = displayTime(), px = pixelsPerSecond(), tr = curTr();
  const n = S.song.parts[S.sel].notes.find((x) => Math.abs(x.s - start) < 1e-6);
  panToTime((n.s + n.e) / 2); // 音符が見える所まで表示を動かす
  const tv2 = displayTime();
  return { x: r.left + playX + ((n.s + n.e) / 2 - tv2) * px, y: r.top + top + (hi + 0.5 - (n.m + tr)) * rowH, s: n.s, e: n.e };
}, start);
// 音符もシートもない、音程バーの上の点
const emptyXY = (p) => p.evaluate(() => {
  const r = document.getElementById('roll').getBoundingClientRect();
  for (let fy = 0.05; fy < 0.97; fy += 0.04) for (let fx = 0.97; fx > 0.2; fx -= 0.04) {
    const x = r.left + r.width * fx, y = r.top + r.height * fy;
    const el = document.elementFromPoint(x, y);
    if (el && el.id === 'roll' && !noteAt(x - r.left, y - r.top)) return { x, y };
  }
  return null;
});
const pointer = (p, type, x, y, primary = true, id = 99) => p.evaluate(([type, x, y, primary, id]) => {
  document.getElementById('roll').dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, isPrimary: primary, pointerId: id, button: 0 }));
}, [type, x, y, primary, id]);

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
  await p.evaluate(() => { seekTo(6); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); });
  await sleep(150);
  const box = await p.locator('#roll').boundingBox();
  const y0 = box.y + box.height * 0.45;
  const marks = () => p.evaluate(() => S.marks.map((m) => [m.a, m.b]));

  // 1) 以前の不具合の再現手順：表示を動かすつもりでなぞる → しおりはできない
  const t0 = await p.evaluate(() => displayTime());
  await p.mouse.move(box.x + box.width * 0.85, y0); await p.mouse.down();
  await p.mouse.move(box.x + box.width * 0.35, y0, { steps: 8 }); await p.mouse.up(); await sleep(100);
  let st = await p.evaluate(() => ({ t: displayTime(), n: S.marks.length, sheet: !document.getElementById('pickSheet').hidden }));
  check('なぞると表示が動き、しおりはできない', st.n === 0 && Math.abs(st.t - t0) > 0.3 && !st.sheet, JSON.stringify({ before: t0, ...st }));
  await p.evaluate(() => seekTo(6)); await sleep(100);

  // 2) 長押しして離す → 触った音符の長さでしおり。区間リピートになり、取り消せる
  let n = await findNote(p);
  const hBefore = await p.evaluate(() => document.getElementById('rollWrap').getBoundingClientRect().height);
  await p.mouse.move(n.x, n.y); await p.mouse.down(); await sleep(600);
  st = await p.evaluate(() => ({ long: !!(press && press.long), n: S.marks.length }));
  check('長押しが成立すると光り、離すまではしおりを作らない', st.long && st.n === 0, JSON.stringify(st));
  await p.mouse.up(); await sleep(100);
  st = await p.evaluate(() => ({ marks: S.marks.map((m) => [m.a, m.b]), loop: loopRange(), mark: S.loop.mark, sheet: !document.getElementById('pickSheet').hidden, msg: document.getElementById('pickMsgText').textContent, h: document.getElementById('rollWrap').getBoundingClientRect().height }));
  check('離すと、その音符の長さでしおりができる', st.marks.length === 1 && Math.abs(st.marks[0][0] - n.s) < 0.002 && Math.abs(st.marks[0][1] - n.e) < 0.002, JSON.stringify(st.marks) + ' 音符 ' + n.s + '〜' + n.e);
  check('しおりの区間がそのまま区間リピートになる', st.mark && Math.abs(st.loop[0] - n.s) < 0.002 && Math.abs(st.loop[1] - n.e) < 0.002);
  check('シートと「作りました」のお知らせが出る', st.sheet && st.msg.includes('作りました'), st.msg);
  console.log('   （参考）しおりを作る前のグラフの高さ ' + hBefore + ' → 区間リピートが始まった後 ' + st.h);
  const sb = await p.locator('#pickSheet').boundingBox();
  check('シートが画面の中に収まる', sb.x >= 0 && sb.x + sb.width <= W + 0.5 && sb.y + sb.height <= box.y + box.height + 0.5, JSON.stringify(sb));
  await p.click('#undoMarkBtn'); await sleep(100);
  st = await p.evaluate(() => ({ n: S.marks.length, on: S.loop.on }));
  check('「取り消す」で、作ったしおりが消え、区間リピートも元に戻る', st.n === 0 && !st.on, JSON.stringify(st));
  st = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e && e.id; }, [n.x, n.y]);
  check('シートが選んだ音符を隠さない', st === 'roll', st);
  const hOpen = await p.evaluate(() => document.getElementById('rollWrap').getBoundingClientRect().height);
  await p.keyboard.press('Escape'); await sleep(150);
  const hClosed = await p.evaluate(() => document.getElementById('rollWrap').getBoundingClientRect().height);
  check('シートの開け閉めでグラフの高さは変わらない', Math.abs(hOpen - hClosed) < 0.5, hOpen + ' / 閉じた時 ' + hClosed);
  await p.keyboard.press('Escape');

  // 3) 長押し中の小さな指ぶれ（8px未満）は長押しのまま
  await p.mouse.move(n.x, n.y); await p.mouse.down();
  await p.mouse.move(n.x + 4, n.y + 3, { steps: 3 }); await sleep(600); await p.mouse.up(); await sleep(100);
  check('8px未満の指ぶれでは長押しが続く', (await marks()).length === 1, JSON.stringify(await marks()));
  await p.click('#undoMarkBtn'); await sleep(50);
  await p.keyboard.press('Escape');

  // 4) 一度動かした指は、止まっても長押しにならない
  await p.mouse.move(n.x, n.y); await p.mouse.down();
  await p.mouse.move(n.x + 20, n.y, { steps: 4 }); await sleep(700); await p.mouse.up(); await sleep(100);
  check('動かしてから止まって待っても、しおりはできない', (await marks()).length === 0);
  await p.evaluate(() => seekTo(6)); await sleep(100);
  n = await findNote(p);

  // 5) 長押しの後に pointercancel／2本目の指 → 作らない
  await pointer(p, 'pointerdown', n.x, n.y); await sleep(600);
  await pointer(p, 'pointercancel', n.x, n.y); await pointer(p, 'pointerup', n.x, n.y); await sleep(100);
  check('長押しの後に操作が中断されたら作らない', (await marks()).length === 0);
  await pointer(p, 'pointerdown', n.x, n.y); await sleep(200);
  await pointer(p, 'pointerdown', n.x + 60, n.y, false, 100); await sleep(500);
  await pointer(p, 'pointerup', n.x, n.y); await sleep(100);
  check('2本目の指が触れたら作らない', (await marks()).length === 0);

  // 6) 短いタップ → 選ぶだけ（しおりは作らない）。「和音を鳴らす」で押した時刻の和音が鳴る
  await p.mouse.click(n.x, n.y); await sleep(100);
  st = await p.evaluate(() => ({ n: S.marks.length, sheet: !document.getElementById('pickSheet').hidden, pick: pick && pick.t }));
  check('短いタップでシートが出て、しおりは作らない', st.n === 0 && st.sheet && st.pick != null, JSON.stringify(st));
  const before = await p.evaluate(() => window.__starts.length);
  await p.click('#chordBtn'); await sleep(150);
  st = await p.evaluate((b) => {
    const xs = window.__starts.slice(b).slice().sort((x, y) => x.when - y.when);
    return {
      started: xs.map((x) => Math.round(x.f)),
      gaps: xs.slice(1).map((x, i) => +(x.when - xs[i].when).toFixed(3)),
      chord: chordAt(pick.t).map((c) => Math.round(440 * Math.pow(2, (c.m + curTr() - 69) / 12))),
    };
  }, before);
  check('「和音を鳴らす」で、押した時刻に鳴っている全パートの音が鳴る', st.chord.length >= 1 && JSON.stringify([...st.started].sort()) === JSON.stringify([...st.chord].sort()), JSON.stringify(st));
  await p.keyboard.press('Escape');
  // 音がいちばん多く重なる時刻で、重ね方を確かめる（1秒ずつ低い音から重ね、押してから10秒で一緒に鳴り終わる）
  const before2 = await p.evaluate(() => window.__starts.length);
  st = await p.evaluate((b) => {
    let best = null;
    for (const pt of S.song.parts) for (const n of pt.notes) { const c = chordAt(n.s + 0.01); if (!best || c.length > best.n) best = { t: n.s + 0.01, n: c.length }; }
    const os = OscillatorNode.prototype.stop, stops = [];
    OscillatorNode.prototype.stop = function (w) { stops.push(w); return os.call(this, w); };
    playChord(best.t);
    const first = stops.splice(0);
    playChord(best.t); // 押し直す
    OscillatorNode.prototype.stop = os;
    const xs = window.__starts.slice(b).slice(0, best.n).sort((x, y) => x.when - y.when);
    const t0 = xs[0].when, again = window.__starts.slice(b + best.n);
    return {
      n: best.n, started: xs.map((x) => Math.round(x.f)), gaps: xs.slice(1).map((x, i) => +(x.when - xs[i].when).toFixed(3)),
      ends: first.slice(-best.n).map((w) => +(w - 0.2 - t0).toFixed(3)), // 先に、前から鳴っていた音を止めた分が入る
      oldStopped: stops.filter((w) => w - t0 < 0.5).length, again: again.length,
    };
  }, before2);
  check('和音は低い音から1音ずつ重ねて鳴る（1秒ずつ）', st.n >= 3 && st.started.length === st.n && st.started.every((f, i) => i === 0 || st.started[i - 1] <= f) && st.gaps.every((g) => Math.abs(g - 1) < 0.01), JSON.stringify(st));
  check('全部の音が、押してから10秒で一緒に鳴り終わる', st.ends.length === st.n && st.ends.every((e) => Math.abs(e - 10) < 0.01), JSON.stringify(st.ends));
  check('押し直すと、鳴っている和音を止めて鳴らし直す', st.oldStopped >= st.n && st.again === st.n, JSON.stringify(st));

  // 7) 何もない所のタップでシートを閉じる（しおりは消さない）
  await p.mouse.move(n.x, n.y); await p.mouse.down(); await sleep(600); await p.mouse.up(); await sleep(100);
  const ep = await emptyXY(p);
  await p.mouse.click(ep.x, ep.y); await sleep(100);
  st = await p.evaluate(() => ({ n: S.marks.length, sheet: !document.getElementById('pickSheet').hidden }));
  check('何もない所のタップでシートが閉じ、しおりは残る', st.n === 1 && !st.sheet, JSON.stringify(st));

  // 8) 「ここまで」「ここから」：選んでいるしおりの端を、選んだ音符に合わせる
  const later = await p.evaluate(([s0]) => {
    const ns = S.song.parts[S.sel].notes.filter((x) => x.s > s0 + 0.5);
    return ns[1] ? ns[1].s : null;
  }, [n.s]);
  const nl = await noteXY(p, later);
  await p.mouse.click(nl.x, nl.y); await sleep(80);
  await p.click('#markToBtn'); await sleep(100);
  st = await p.evaluate(() => ({ m: S.marks.map((m) => [m.a, m.b]), loop: loopRange() }));
  check('「ここまで」で、しおりの終わりが選んだ音符の終わりになる', st.m.length === 1 && Math.abs(st.m[0][0] - n.s) < 0.002 && Math.abs(st.m[0][1] - nl.e) < 0.002 && Math.abs(st.loop[1] - nl.e) < 0.002, JSON.stringify(st) + ' 期待 ' + n.s + '〜' + nl.e);
  const nf = await noteXY(p, (await p.evaluate(([s0]) => S.song.parts[S.sel].notes.find((x) => x.s > s0 + 0.2 && x.s < s0 + 3).s, [n.s])));
  await p.keyboard.press('Escape'); await sleep(50);
  await p.mouse.click(nf.x, nf.y); await sleep(80);
  await p.click('#markFromBtn'); await sleep(100);
  st = await p.evaluate(() => S.marks.map((m) => [m.a, m.b]));
  check('「ここから」で、しおりの始まりが選んだ音符の始まりになる（終わりはそのまま）', st.length === 1 && Math.abs(st[0][0] - nf.s) < 0.002 && Math.abs(st[0][1] - nl.e) < 0.002, JSON.stringify(st) + ' 期待 ' + nf.s + '〜' + nl.e);
  await p.keyboard.press('Escape');

  // 9) 曲の終わりの短い音符：曲の外へ出さず、0.2秒を確保する
  st = await p.evaluate(() => { const D = S.song.duration; return [fitRange(D - 0.05, D), D]; });
  check('曲の終わりでは、始まりを前にずらして0.2秒にする', Math.abs(st[0][1] - st[1]) < 0.002 && Math.abs(st[0][1] - st[0][0] - 0.2) < 0.002, JSON.stringify(st));
  st = await p.evaluate(() => fitRange(1, 1.05));
  check('短い範囲は後ろへ延ばして0.2秒にする', st[0] === 1 && Math.abs(st[1] - 1.2) < 0.002, JSON.stringify(st));

  // 10) 再生中の長押しはしおりを作らない（表示の移動だけ）
  const cnt = (await marks()).length;
  await p.evaluate(() => { const c = document.getElementById('countIn'); if (c && c.checked) c.click(); });
  await p.click('#playBtn'); await sleep(300);
  n = await findNote(p, 0.05);
  if (n) { await p.mouse.move(n.x, n.y); await p.mouse.down(); await sleep(600); await p.mouse.up(); await sleep(100); }
  check('再生中の長押しでは、しおりを作らない', (await marks()).length === cnt);
  await p.click('#playBtn'); await sleep(100);

  // 11) しおりの区間を繰り返し再生する・チップで選び直す・再読み込み後も残る・×で消せる
  await p.evaluate(() => { const c = document.getElementById('countIn'); if (c.checked) c.click(); seekTo(0); });
  await p.locator('#marks .chip').first().click(); await sleep(100);
  const lr = await p.evaluate(() => (S.loop.mark ? loopRange() : null));
  if (!lr) await p.locator('#marks .chip').first().click();
  const [a, bb] = await p.evaluate(() => loopRange());
  await p.click('#playBtn');
  let minT = 1e9, maxT = -1, wrapped = false, prev = -1;
  const dur = (bb - a) * 2.6 * 1000 + 1500;
  for (let t1 = Date.now(); Date.now() - t1 < dur;) { const v = await p.evaluate(() => viewTime()); if (v < prev - 0.2) wrapped = true; prev = v; minT = Math.min(minT, v); maxT = Math.max(maxT, v); await sleep(50); }
  await p.click('#playBtn');
  check('しおりの区間を繰り返し再生する', wrapped && minT >= a - 0.05 && maxT <= bb + 0.6, `区間 ${a.toFixed(2)}〜${bb.toFixed(2)}、再生 ${minT.toFixed(2)}〜${maxT.toFixed(2)}、戻った=${wrapped}`);
  await p.reload(); await p.click('#demoBtn'); await sleep(300);
  check('再読み込みしても、同じ曲のしおりが残る', (await p.evaluate(() => S.marks.length)) === 1);
  await p.click('#loopBtn');
  await p.locator('#marks .iconbtn').first().click(); await sleep(80);
  st = await p.evaluate(() => [S.marks.length, localStorage.getItem('acapella-renshucho:marks:v1')]);
  check('×で消せる（記憶からも消える）', st[0] === 0 && !String(st[1]).includes('しおり'), String(st[1]));
  await p.screenshot({ path: path.join(T, 'tests/out/marks_' + W + '.png') });

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
  // 指（タッチ）での操作：なぞる＝表示の移動、長押しして離す＝しおり
  if (W < 700) {
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    await p.evaluate(() => { seekTo(6); document.getElementById('rollWrap').scrollIntoView({ block: 'center' }); }); await sleep(150);
    const bx = await p.locator('#roll').boundingBox();
    const yy = bx.y + bx.height * 0.5, c0 = await p.evaluate(() => S.marks.length);
    await touch('touchStart', bx.x + bx.width * 0.85, yy);
    for (let i = 1; i <= 8; i++) await touch('touchMove', bx.x + bx.width * (0.85 - i * 0.06), yy);
    await touch('touchEnd'); await sleep(100);
    check('指でなぞると、しおりはできない', (await p.evaluate(() => S.marks.length)) === c0);
    await p.evaluate(() => seekTo(6)); await sleep(100);
    const tn = await findNote(p);
    await touch('touchStart', tn.x, tn.y); await sleep(650); await touch('touchEnd'); await sleep(100);
    check('指で長押しして離すと、しおりができる', (await p.evaluate(() => S.marks.length)) === c0 + 1);
  }
  check('ページのエラーなし', !errs.length, errs.join(' / '));
  console.log(`結果（${W}x${H}）：NG ${fails}件`);
  await b.close(); server.close();
  process.exitCode = fails ? 1 : 0;
})();
