
const app = document.getElementById('app'), status = document.getElementById('status');
let passed = 0, failed = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 150));
const check = (name, ok, detail) => {
  if (ok) passed++; else failed++;
  document.getElementById('result').textContent += `${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' ' + JSON.stringify(detail) : ''}\n`;
};
async function load(width, height) {
  app.style.width = width + 'px'; app.style.height = height + 'px';
  const html = await (await fetch('../index.html')).text();
  const expose = 'window.pickTest = { S, view, setPick, markFromPick, undoMark, seekTo, viewRange, curTr, displayTime, pixelsPerSecond, panToTime };';
  const end = html.lastIndexOf('\n})();');
  if (end < 0) throw Error('app closure not found');
  app.srcdoc = html.slice(0, end) + '\n' + expose + html.slice(end);
  await new Promise(resolve => app.onload = resolve);
  const w = app.contentWindow, d = app.contentDocument;
  d.getElementById('demoBtn').click();
  app.scrollIntoView({ block: 'start' });
  await d.fonts.ready;
  await pause(); await pause();
  w.pickTest.seekTo(6);
  d.getElementById('rollWrap').scrollIntoView({ block: 'center' });
  await pause();
  return { w, d, api: w.pickTest };
}
function measure(d, api, note) {
  const cv = d.getElementById('roll').getBoundingClientRect();
  const sheet = d.getElementById('pickSheet'), r = sheet.getBoundingClientRect();
  const [lo, hi] = api.viewRange(), row = (api.view.h - 30) / (hi - lo + 1);
  const y = cv.top + 24 + (hi + 0.5 - note.m - api.curTr()) * row;
  const half = Math.max(3, Math.min(row * 0.72, 26)) / 2;
  return { top: r.top, bottom: r.bottom, left: r.left, right: r.right,
    noteTop: y - half, noteBottom: y + half, rollTop: cv.top, rollBottom: cv.bottom,
    fits: r.left >= 0 && r.right <= api.view.w + cv.left + 1 && r.top >= cv.top && r.bottom <= cv.bottom,
    clear: r.bottom <= y - half || r.top >= y + half,
    scrolls: sheet.scrollHeight > sheet.clientHeight,
    horizontalOverflow: sheet.scrollWidth > sheet.clientWidth + 1 };
}
document.getElementById('run').onclick = async () => {
  document.getElementById('run').disabled = true;
  document.getElementById('result').textContent = ''; passed = failed = 0;
  status.textContent = '検証中';
  try {
    for (const [width, height] of [[390,664],[360,640],[320,548],[560,360],[844,390],[1280,800]]) {
      const { w, d, api } = await load(width, height);
      check(`${width}×${height} メニューの指スクロールを祖先で禁止しない`, w.getComputedStyle(d.getElementById('rollWrap')).touchAction !== 'none' && w.getComputedStyle(d.getElementById('pickSheet')).touchAction === 'pan-y');
      check(`${width}×${height} グラフの独自ピンチ・パンを保つ`, w.getComputedStyle(d.getElementById('roll')).touchAction === 'none');
      for (const m of [60, 64, 67]) {
        const note = api.S.song.parts[0].notes.find(n => n.m === m);
        const picked = { part: 0, note, t: note.s };
        api.panToTime(note.s);
        api.setPick(null);
        await pause();
        const before = d.getElementById('rollWrap').getBoundingClientRect().height;
        api.setPick(picked, 'しおりを作りました');
        await pause();
        const data = measure(d, api, note), label = `${width}×${height} MIDI${m}`;
        check(label + ' メニューがグラフ内に収まる', data.fits, data);
        check(label + ' 選んだ音符全体が見える', data.clear);
        check(label + ' 横にはみ出さない', !data.horizontalOverflow);
        api.setPick(picked);
        await pause();
        check(label + ' お知らせを消しても音符が見える', measure(d, api, note).clear);
        const open = d.getElementById('rollWrap').getBoundingClientRect().height;
        api.setPick(null);
        await pause();
        const closed = d.getElementById('rollWrap').getBoundingClientRect().height;
        check(label + ' 開閉でグラフ高を変えない', Math.abs(before - open) < 0.5 && Math.abs(open - closed) < 0.5, [before, open, closed]);
      }
      const note = api.S.song.parts[0].notes[0];
      api.markFromPick({ part: 0, note, t: note.s });
      await pause();
      check(`${width}×${height} しおり作成後の高さ変更にも追従する`, measure(d, api, note).fits && measure(d, api, note).clear);
      api.undoMark();
      await pause();
      check(`${width}×${height} 取り消し後も音符が見える`, measure(d, api, note).clear);
      const close = d.getElementById('pickClose');
      close.scrollIntoView({ block: 'nearest' });
      await pause();
      check(`${width}×${height} スクロール後の閉じる操作に到達できる`, close.getBoundingClientRect().top >= d.getElementById('pickSheet').getBoundingClientRect().top);
      close.click();
      check(`${width}×${height} 閉じる操作が動く`, d.getElementById('pickSheet').hidden);
      w.localStorage.clear();
    }
    const { d, api } = await load(390, 780);
    const note = api.S.song.parts[0].notes[0];
    api.setPick({ part:0, note, t:note.s });
    app.style.width = '360px'; app.style.height = '548px';
    await pause(); await pause();
    check('メニューを開いたまま画面サイズを変えても収まる', measure(d, api, note).fits && measure(d, api, note).clear);
  } catch (e) { check('例外なし', false, String(e)); }
  status.textContent = `${passed} PASS / ${failed} FAIL`;
  document.getElementById('run').disabled = false;
};
document.getElementById('run').disabled = false;
status.textContent = '準備できました';
document.getElementById('show').onclick = async () => {
  document.getElementById('logs').open = false;
  await load(390, 664);
};
