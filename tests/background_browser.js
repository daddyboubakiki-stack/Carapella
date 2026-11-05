// 画面を離れても聴くための再生（バックグラウンド再生）を、実際のChromiumで確かめる。
// - 用意した音声（WAV）の中身：ソロ・練習の段階・音量・キー・テンポ・カウントが、通常の再生と同じ約束で入っているか
// - 画面が隠れた時の引き継ぎ、戻った時の位置合わせ、ループ、ロック画面の操作、曲の終わり、マイク使用中、断られた時
// 画面が隠れたことは document.visibilityState を書き換えて知らせる。実機の画面ロック・別アプリ切り替えの代わりにはならない。
require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'out');
const log = [];
let fails = 0;
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const check = (label, ok, detail = '') => { if (!ok) fails++; note(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? '：' + detail : ''}`); };

// テスト用のコピーだけに内部を見る口を足す（公開する index.html は変えない）
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const end = html.lastIndexOf('\n})();');
if (end < 0) throw new Error('app closure not found');
const testHtml = html.slice(0, end) + '\nwindow.__t = {S,T,A,B,CP,play,pause,seekTo,bgPlan,bgSig,bgSongTime,bgFileTime,viewTime,makePitchDetector,setMode,selectPart,addMark};\n' + html.slice(end);
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(testHtml); }).listen(0);
const URL_ = 'http://localhost:' + server.address().port + '/';

const INIT = () => {
  // ロック画面の操作（Media Session）を呼べるよう、登録された処理を控える
  window.__ms = {};
  if (navigator.mediaSession) {
    const orig = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = (a, fn) => { window.__ms[a] = fn; try { orig(a, fn); } catch (e) { /* ignore */ } };
  }
  window.__setHidden = (hidden) => {
    Object.defineProperty(document, 'visibilityState', { value: hidden ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 780 } });
  await context.addInitScript(INIT);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route(/fonts\.g/, (r) => r.abort());
  await page.goto(URL_);
  page.setDefaultTimeout(60000);
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const ready = () => page.waitForFunction(() => { const { B, bgSig } = window.__t; return B.cur && !B.busy && !B.timer && B.cur.sig === bgSig(); });
  // 用意した音声を読み戻して、指定した時間帯の大きさ（RMS）と音の高さ（MIDI番号）を測る
  const measure = (spans) => ev(async (spans) => {
    const { B, makePitchDetector } = window.__t;
    const ab = await (await fetch(B.cur.url)).arrayBuffer();
    const buf = await new OfflineAudioContext(1, 1, 22050).decodeAudioData(ab);
    const x = buf.getChannelData(0), sr = buf.sampleRate, detect = makePitchDetector();
    return { sec: buf.duration, spans: spans.map(([a, b]) => {
      const seg = x.subarray(Math.round(a * sr), Math.round(b * sr));
      let e = 0; for (const v of seg) e += v * v;
      const r = detect(seg.subarray(0, Math.min(seg.length, 2048)), sr, { minRms: 0.001, minFreq: 50 });
      return { rms: Math.sqrt(e / seg.length), midi: r.f ? 69 + 12 * Math.log2(r.f / 440) : null };
    }) };
  }, spans);
  const setUi = (fn) => ev(fn);

  note('## 1. 用意する音声の中身（デモ曲：1番手0秒〜、2番手4.8秒〜、3番手9.6秒〜）');
  await page.click('#demoBtn');
  await setUi(() => { const c = document.getElementById('countIn'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await ready();
  const st = await ev(() => document.getElementById('bgStatus').textContent);
  check('曲を開くと、画面を離れても聴くための音声を準備する', st.includes('準備できています'), st.split('\n')[0]);
  let m = await measure([[0.05, 0.5], [9.7, 10.1]]);
  check('通常：長さは曲＋0.5秒、最初の1番手が鳴る', Math.abs(m.sec - 29.3) < 0.01 && m.spans[0].rms > 0.02, JSON.stringify(m));
  await ev(() => window.__t.selectPart(2));
  await page.click('#soloBtn');
  await ready();
  m = await measure([[0.05, 4.5], [9.65, 10.1]]);
  check('自分だけ（3番手）：ほかのパートだけの所は無音、自分の所は1オクターブ下のドが鳴る', m.spans[0].rms < 1e-4 && m.spans[1].rms > 0.02 && Math.abs(m.spans[1].midi - 48) < 0.3, JSON.stringify(m.spans));
  await page.click('#soloBtn');
  await ev(() => { window.__t.selectPart(0); window.__t.setMode(3); });
  await ready();
  m = await measure([[0.05, 4.5], [5.0, 5.4]]);
  check('③自分なし（1番手）：1番手だけの所は無音、2番手が入ると鳴る', m.spans[0].rms < 1e-4 && m.spans[1].rms > 0.02, JSON.stringify(m.spans));
  await ev(() => window.__t.setMode(1));
  await ev(() => { const v = document.querySelectorAll('#parts input[type=range]')[0]; v.value = '0'; v.dispatchEvent(new Event('input')); });
  await ready();
  m = await measure([[0.05, 4.5]]);
  check('パート音量0%：そのパートは鳴らない', m.spans[0].rms < 1e-4, JSON.stringify(m.spans));
  await ev(() => { const v = document.querySelectorAll('#parts input[type=range]')[0]; v.value = '100'; v.dispatchEvent(new Event('input')); });
  await ev(() => window.__t.selectPart(0));
  await page.click('#soloBtn');
  await page.click('#keyUp'); await page.click('#keyUp'); await page.click('#keyUp');
  await ready();
  m = await measure([[0.05, 0.5], [0.65, 1.1]]);
  check('キー＋3：1番手のド→ミ♭、レ→ファ', Math.abs(m.spans[0].midi - 63) < 0.3 && Math.abs(m.spans[1].midi - 65) < 0.3, JSON.stringify(m.spans));
  await ev(() => { const r = document.getElementById('rate'); r.value = '50'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await ready();
  m = await measure([[0.1, 1.0], [1.3, 2.2]]);
  check('テンポ50%：長さが2倍、2つ目の音は1.2秒から', Math.abs(m.sec - (28.8 / 0.5 + 0.5)) < 0.01 && Math.abs(m.spans[1].midi - 65) < 0.3, JSON.stringify(m));
  await ev(() => { const r = document.getElementById('rate'); r.value = '100'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await page.click('#keyDown'); await page.click('#keyDown'); await page.click('#keyDown');
  await page.click('#soloBtn');
  await setUi(() => { const c = document.getElementById('countIn'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await ev(() => { window.__t.T.pos = 2.5; });
  await setUi(() => { const c = document.getElementById('bgRelease'); c.checked = false; c.dispatchEvent(new Event('change')); }); // 画面を離れても区間を繰り返す設定
  await page.click('#loopBtn'); // 2〜3小節目（2.4〜7.2秒）を区間に
  await ready();
  const lp = await ev(() => window.__t.B.cur.plan);
  m = await measure([[0, 0.09], [lp.pre, lp.pre + 0.05], [lp.pre + lp.lead + 0.05, lp.pre + lp.lead + 0.5]]);
  check('区間ループ：間（無音）→カウント→区間の最初の音（ミ）の1周分', Math.abs(lp.sec - (0.1 + 2.4 + 4.8 + 0.25)) < 0.01 && m.spans[0].rms < 1e-4 && m.spans[1].rms > 0.02 && Math.abs(m.spans[2].midi - 64) < 0.3, JSON.stringify({ sec: lp.sec, spans: m.spans }));
  await setUi(() => { const c = document.getElementById('bgRelease'); c.checked = true; c.dispatchEvent(new Event('change')); }); // 初めの設定に戻す
  await ready();
  const lr = await ev(() => ({ plan: window.__t.B.cur.plan, on: window.__t.S.loop.on }));
  check('初めの設定：区間ループ中でも、画面を離れた時のために曲全体の音声を用意する', lr.on && lr.plan.loop === null && Math.abs(lr.plan.sec - 29.3) < 0.01, JSON.stringify({ on: lr.on, loop: lr.plan.loop, sec: lr.plan.sec }));
  await page.click('#repeatBtn'); // ループを切る
  await setUi(() => { const c = document.getElementById('countIn'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await ready();

  note('\n## 2. 画面が隠れたら <audio> へ引き継ぎ、戻ったら同じ位置から通常の再生へ');
  await page.click('#rewBtn');
  await page.click('#playBtn');
  await sleep(1200);
  const sh = await ev(() => { const { B } = window.__t; return { playing: !B.el.paused, muted: B.el.muted, src: B.src === B.cur.url }; });
  check('再生中は、用意した音声を消音で回している（iPhoneの再生許可を操作の中で得るため）', sh.playing && sh.muted && sh.src, JSON.stringify(sh));
  const before = await ev(() => { const t = window.__t.viewTime(); window.__setHidden(true); const { T, B, bgSongTime } = window.__t; return { t, mode: T.mode, playing: T.playing, el: bgSongTime(), muted: B.el.muted, timer: T.timer }; });
  // 消音で位置を合わせてある <audio> は、0.08秒以内のずれなら飛ばさずに鳴らす設計（「プツッ」を減らすため）
  check('隠れた瞬間：Web Audioの予約を止め、聞こえていた位置（0.08秒以内）から <audio> を鳴らす', before.mode === 'bg' && before.playing && !before.muted && before.timer === 0 && Math.abs(before.el - before.t) < 0.08, JSON.stringify(before));
  await sleep(2500);
  const mid = await ev(() => { const { T, B, A, bgSongTime } = window.__t; return { t: bgSongTime(), paused: B.el.paused, active: A.active.size, title: navigator.mediaSession.metadata && navigator.mediaSession.metadata.title, state: navigator.mediaSession.playbackState }; });
  check('隠れている間：<audio> が進み、Web Audioの音は残っていない', !mid.paused && mid.t - before.t > 2.2 && mid.t - before.t < 2.9 && mid.active === 0, JSON.stringify(mid));
  check('ロック画面用の曲名と再生状態', mid.title === 'かえるの合唱（3部輪唱）' && mid.state === 'playing', JSON.stringify(mid));
  const back = await ev(() => { const { B } = window.__t; const el = B.el.currentTime; window.__setHidden(false); const { T, viewTime } = window.__t; return { el, mode: T.mode, playing: T.playing, p0: T.p0, vt: viewTime(), muted: B.el.muted, msg: document.getElementById('msg').textContent }; });
  check('戻った：<audio> の位置（Web Audio が鳴り始める0.08秒後の位置）から通常の再生に戻り、譜面の時刻が合う', back.mode === 'live' && back.playing && Math.abs(back.p0 - back.el - 0.08) < 0.02 && back.msg.includes('続けました'), JSON.stringify(back));
  await sleep(200);
  check('戻って0.2秒後には <audio> は消音に戻っている', await ev(() => window.__t.B.el.muted && !window.__t.B.fading));
  await sleep(500);
  const after = await ev(() => ({ vt: window.__t.viewTime(), playing: window.__t.T.playing }));
  check('戻った後も再生が続く', after.playing && after.vt > back.el + 0.3, JSON.stringify(after));

  note('\n## 3. テンポ50%・キー＋2でも曲の時刻で進む');
  await ev(() => { const r = document.getElementById('rate'); r.value = '50'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await page.click('#keyUp'); await page.click('#keyUp');
  await ready();
  const h3 = await ev(() => { const t = window.__t.viewTime(); window.__setHidden(true); return { t, mode: window.__t.T.mode, tr: window.__t.B.used.plan.tr, rate: window.__t.B.used.plan.rate }; });
  await sleep(2000);
  const h3b = await ev(() => window.__t.bgSongTime());
  check('隠れている間、2秒で曲の1秒ぶん進む（50%）・キー＋2の音声', h3.mode === 'bg' && h3.tr === 2 && h3.rate === 0.5 && h3b - h3.t > 0.8 && h3b - h3.t < 1.25, JSON.stringify({ h3, h3b }));
  await ev(() => window.__setHidden(false));
  check('戻るとテンポ・キーは変わらない', await ev(() => window.__t.S.rate === 0.5 && window.__t.S.transpose === 2 && window.__t.T.rate === 0.5 && window.__t.T.tr === 2));
  await ev(() => { const r = document.getElementById('rate'); r.value = '100'; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); });
  await page.click('#keyDown'); await page.click('#keyDown');
  await ready();

  note('\n## 4. 区間ループは <audio> の繰り返しで回る');
  await page.click('#playBtn'); // 一時停止
  await setUi(() => { const c = document.getElementById('countIn'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await ev(() => { window.__t.T.pos = 12.5; });
  await setUi(() => { const c = document.getElementById('bgRelease'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await page.click('#loopBtn');
  await ready();
  await page.click('#playBtn');
  await sleep(3200); // カウント（2.4秒）の後
  const lp4 = await ev(() => { window.__setHidden(true); const { T, B } = window.__t; return { mode: T.mode, loop: B.el.loop, range: B.used.plan.loop, sec: B.used.plan.sec }; });
  await ev((sec) => { window.__t.B.el.currentTime = sec - 0.3; }, lp4.sec);
  await sleep(900);
  const wrapped = await ev(() => ({ t: window.__t.bgSongTime(), x: window.__t.B.el.currentTime, playing: window.__t.T.playing }));
  check('区間の終わりで区間の始まり（カウント）へ戻る', lp4.mode === 'bg' && lp4.loop && wrapped.playing && wrapped.x < 1 && wrapped.t === lp4.range[0], JSON.stringify({ lp4, wrapped }));
  await ev(() => window.__setHidden(false));
  const lp4b = await ev(() => ({ end: window.__t.T.end, p0: window.__t.T.p0, playing: window.__t.T.playing, cN: window.__t.T.cN }));
  check('カウント中に戻ると、区間の始まりからカウントして続ける', lp4b.playing && lp4b.end === lp4.range[1] && lp4b.p0 === lp4.range[0] && lp4b.cN > 0, JSON.stringify(lp4b));
  await page.click('#playBtn');
  await page.click('#repeatBtn');
  await setUi(() => { const c = document.getElementById('bgRelease'); c.checked = true; c.dispatchEvent(new Event('change')); });
  await setUi(() => { const c = document.getElementById('countIn'); c.checked = false; c.dispatchEvent(new Event('change')); });
  await ready();

  note('\n## 4b. 初めの設定：区間ループ中に画面を離れたら、ループだけ止めて曲の終わりまで');
  await ev(() => { window.__t.T.pos = 2.5; });
  await page.click('#loopBtn'); // 2.4〜7.2秒
  await ready();
  await page.click('#playBtn');
  await sleep(1500);
  const r4 = await ev(() => { const t = window.__t.viewTime(); window.__setHidden(true); const { T, B, S, bgSongTime } = window.__t; return { t, el: bgSongTime(), mode: T.mode, loop: B.el.loop, on: S.loop.on, scope: S.loop.scope, a: S.loop.a, b: S.loop.b }; });
  check('隠れると区間ループだけOFF、範囲は残し、今の位置から曲全体の音声で続ける', r4.mode === 'bg' && !r4.loop && !r4.on && r4.scope === 'section' && r4.a === 1 && r4.b === 2 && Math.abs(r4.el - r4.t) < 0.05 && r4.t > 2.4 && r4.t < 7.2, JSON.stringify(r4));
  await ev(() => { window.__t.B.el.currentTime = 7.0; });
  await sleep(800);
  const past = await ev(() => window.__t.bgSongTime());
  check('区間の終わり（7.2秒）を越えて続く', past > 7.4, past.toFixed(2));
  await ev(() => window.__ms.seekforward({ action: 'seekforward' }));
  await sleep(150);
  const fw = await ev(() => window.__t.bgSongTime());
  check('ロック画面の10秒送りで区間の外へ移れる', fw > 17 && fw < 18.5, fw.toFixed(2));
  const r4b = await ev(() => { window.__setHidden(false); const { T, S } = window.__t; return { mode: T.mode, playing: T.playing, on: S.loop.on, end: T.end, p0: T.p0, label: document.getElementById('repeatLbl').textContent, msg: document.getElementById('msg').textContent }; });
  check('戻ると同じ位置から続き、区間ループは自動で再開しない', r4b.mode === 'live' && r4b.playing && !r4b.on && r4b.end === Infinity && Math.abs(r4b.p0 - fw - 0.08) < 0.06 && r4b.label === 'ループ' && r4b.msg.includes('区間ループはオフ'), JSON.stringify(r4b));
  await page.click('#playBtn');
  await page.click('#repeatBtn');
  const again = await ev(() => { const { S } = window.__t; return { on: S.loop.on, scope: S.loop.scope, a: S.loop.a, b: S.loop.b, label: document.getElementById('repeatLbl').textContent }; });
  check('「ループ」ボタンで、残っていた同じ区間のループに戻せる', again.on && again.scope === 'section' && again.a === 1 && again.b === 2 && again.label === '区間', JSON.stringify(again));
  await page.click('#repeatBtn');
  await ready();

  note('\n## 4c. Issue #24 の受け入れ条件の残り（全曲ループ・しおり・設定直後）');
  // 全曲ループ：裏で曲の終わりを越えても繰り返す
  await page.click('#repeatBtn'); // 「ループ」は直前の範囲（区間）を使うので、
  await page.click('#wholeLoopBtn'); // 「全曲に戻す」で全曲ループにする
  await ready();
  await ev(() => window.__t.play(window.__t.S.song.duration - 1.0));
  await sleep(200);
  await ev(() => window.__setHidden(true));
  await sleep(2200);
  const wl = await ev(() => ({ t: window.__t.bgSongTime(), playing: window.__t.T.playing, loop: window.__t.B.el.loop, on: window.__t.S.loop.on }));
  await ev(() => window.__setHidden(false));
  check('全曲ループ：裏で曲の終わりを越えて先頭から続く（ループはそのまま）', wl.playing && wl.loop && wl.on && wl.t < 1.5, JSON.stringify(wl));
  await page.click('#playBtn');
  await page.click('#repeatBtn'); // オフ
  // しおりのループ：初めの設定で離れると、しおりは残り、ループだけ止まる
  const mk = await ev(() => { const m = window.__t.addMark(2.4, 4.2); return m.id; });
  await ready();
  await page.click('#playBtn');
  await sleep(800);
  await ev(() => window.__setHidden(true));
  await ev(() => { window.__t.B.el.currentTime = 4.0; });
  await sleep(700);
  const ms = await ev((id) => ({ t: window.__t.bgSongTime(), on: window.__t.S.loop.on, mark: window.__t.S.loop.mark, marks: window.__t.S.marks.map((m) => m.id) }), mk);
  await ev(() => window.__setHidden(false));
  check('しおりのループ：しおりの終わり（4.2秒）を越えて続き、しおり自体は残る', ms.t > 4.3 && !ms.on && ms.mark === mk && ms.marks.includes(mk), JSON.stringify(ms));
  await page.click('#playBtn');
  await page.click('#repeatBtn');
  check('「ループ」で同じしおりのループに戻せる', await ev((id) => window.__t.S.loop.on && window.__t.S.loop.mark === id, mk));
  // 区間ループ中に「自分だけ」を押した直後に離れる：古い音声へは引き継がず、完成を待ってから止めて通しで流す
  await ready();
  await page.click('#playBtn');
  await sleep(600);
  await page.click('#soloBtn');
  const w4 = await ev(() => { window.__setHidden(true); return { mode: window.__t.T.mode, pending: window.__t.B.pending, on: window.__t.S.loop.on }; });
  await page.waitForFunction(() => window.__t.T.mode === 'bg', null, { timeout: 15000 }).catch(() => {});
  const w4b = await ev(() => ({ mode: window.__t.T.mode, on: window.__t.S.loop.on, loop: window.__t.B.used && window.__t.B.used.plan.loop, solo: window.__t.B.used && window.__t.B.used.plan.levels.filter((x) => x > 0).length }));
  check('設定の直後に離れても、新しい音声の完成を待ってから区間ループを止めて引き継ぐ', w4.mode === 'live' && w4.pending && w4.on && w4b.mode === 'bg' && !w4b.on && w4b.loop === null && w4b.solo === 1, JSON.stringify({ w4, w4b }));
  await ev(() => window.__setHidden(false));
  await page.click('#playBtn');
  await page.click('#soloBtn');
  await ev(() => { const { S } = window.__t; S.marks = []; S.loop.t = null; S.loop.mark = null; });
  await ready();
  // ここで作った音声を消し、後の「完成を待つ」確認で作り直しが起きるようにする（同じ設定の音声は使い回すため）
  await ev(() => { const { B } = window.__t; B.cache.forEach((x) => { if (x !== B.cur) URL.revokeObjectURL(x.url); }); B.cache = B.cache.filter((x) => x === B.cur); });

  note('\n## 5. ロック画面の操作・曲の終わり・ページを離れた時');
  await page.click('#rewBtn');
  await page.click('#playBtn');
  await sleep(500);
  await ev(() => window.__setHidden(true));
  const s0 = await ev(() => window.__t.bgSongTime());
  await ev(() => window.__ms.seekforward({ action: 'seekforward' }));
  await sleep(150);
  const s1 = await ev(() => window.__t.bgSongTime());
  check('ロック画面の「10秒送る」は曲の時刻で10秒', s1 - s0 > 9.8 && s1 - s0 < 10.5, s0.toFixed(2) + '→' + s1.toFixed(2));
  await ev(() => window.__ms.seekbackward({ action: 'seekbackward' }));
  await sleep(150);
  const s2 = await ev(() => window.__t.bgSongTime());
  check('ロック画面の「10秒戻す」', s1 - s2 > 9.5 && s1 - s2 < 10.3, s1.toFixed(2) + '→' + s2.toFixed(2));
  await ev(() => window.__ms.pause({ action: 'pause' }));
  await sleep(200);
  const p5 = await ev(() => ({ playing: window.__t.T.playing, paused: window.__t.B.el.paused, state: navigator.mediaSession.playbackState, t: window.__t.bgSongTime() }));
  check('ロック画面の一時停止で、アプリも一時停止として扱う', !p5.playing && p5.paused && p5.state === 'paused', JSON.stringify(p5));
  await ev(() => window.__ms.play({ action: 'play' }));
  await sleep(300);
  check('ロック画面の再生で再開', await ev(() => window.__t.T.playing && !window.__t.B.el.paused));
  await ev(() => window.__ms.pause({ action: 'pause' }));
  await sleep(200);
  const pt = await ev(() => window.__t.bgSongTime());
  await ev(() => window.__setHidden(false));
  const r5 = await ev(() => ({ mode: window.__t.T.mode, playing: window.__t.T.playing, pos: window.__t.T.pos, label: document.getElementById('playLbl').textContent }));
  check('止めたまま戻ると、その位置で止まっている（勝手に再生しない）', r5.mode === 'live' && !r5.playing && Math.abs(r5.pos - pt) < 0.02 && r5.label === '再生', JSON.stringify({ pt, r5 }));
  await ev(() => window.__t.play(window.__t.S.song.duration - 1.0));
  await sleep(200);
  await ev(() => window.__setHidden(true));
  await sleep(2200);
  const e5 = await ev(() => ({ playing: window.__t.T.playing, ended: window.__t.B.el.ended, state: navigator.mediaSession.playbackState }));
  await ev(() => window.__setHidden(false));
  const e5b = await ev(() => ({ mode: window.__t.T.mode, pos: window.__t.T.pos, dur: window.__t.S.song.duration }));
  check('曲の終わりまで行くと止まり、戻ると末尾を表示する', !e5.playing && e5.ended && e5b.mode === 'live' && e5b.pos === e5b.dur, JSON.stringify({ e5, e5b }));
  await page.click('#rewBtn');
  await page.click('#playBtn');
  await sleep(400);
  await ev(() => { window.__setHidden(true); window.dispatchEvent(new Event('pagehide')); });
  const ph = await ev(() => ({ mode: window.__t.T.mode, playing: window.__t.T.playing, paused: window.__t.B.el.paused }));
  check('ページ自体を離れたら <audio> も止める', ph.mode === 'live' && !ph.playing && ph.paused, JSON.stringify(ph));
  await ev(() => window.__setHidden(false));

  note('\n## 5b. 切り替えの瞬間（「プツッ」と隙間を減らす工夫。耳で聞いた確認ではない）');
  await page.click('#rewBtn');
  await ev(() => { window.__seeks = 0; window.__t.B.el.addEventListener('seeking', () => window.__seeks++); });
  await page.click('#playBtn');
  const diffs = [];
  for (let i = 0; i < 8; i++) { await sleep(400); diffs.push(await ev(() => { const { B, bgFileTime, viewTime } = window.__t; return +(B.el.currentTime - bgFileTime(B.cur.plan, viewTime())).toFixed(3); })); }
  check('前面で再生中、消音の <audio> を通常の再生に0.08秒以内で合わせておく', diffs.slice(2).every((d) => Math.abs(d) < 0.08), JSON.stringify(diffs));
  const fadeIn = await ev(async () => {
    const { B } = window.__t; const s0 = window.__seeks;
    window.__setHidden(true);
    const vols = [B.el.volume]; const t0 = performance.now();
    while (performance.now() - t0 < 120) { await new Promise((r) => setTimeout(r, 10)); vols.push(+B.el.volume.toFixed(2)); }
    return { seeks: window.__seeks - s0, muted: B.el.muted, vols };
  });
  check('隠れる時：位置を飛ばさず、<audio> の音量を0から約0.05秒で上げる', fadeIn.seeks === 0 && !fadeIn.muted && fadeIn.vols[0] === 0 && fadeIn.vols.at(-1) === 1 && fadeIn.vols.some((v) => v > 0 && v < 1), JSON.stringify(fadeIn));
  await sleep(800);
  const fadeOut = await ev(async () => {
    const { B, T } = window.__t; const x0 = B.el.currentTime;
    window.__setHidden(false);
    const p0 = T.p0, samples = []; const t0 = performance.now();
    while (performance.now() - t0 < 220) { samples.push([Math.round(performance.now() - t0), B.el.muted, +B.el.volume.toFixed(2)]); await new Promise((r) => setTimeout(r, 15)); }
    return { x0, p0, samples, fading: B.fading };
  });
  const early = fadeOut.samples.filter((s) => s[0] < 60), late = fadeOut.samples.filter((s) => s[0] > 180);
  check('戻る時：Web Audio が鳴り始める0.08秒後まで <audio> を鳴らし、その後に下げて消音・音量を元に戻す', Math.abs(fadeOut.p0 - fadeOut.x0 - 0.08) < 0.01 && early.every((s) => !s[1] && s[2] === 1) && late.every((s) => s[1] && s[2] === 1) && !fadeOut.fading, JSON.stringify(fadeOut));
  await page.click('#playBtn');
  const af = await ev(() => ({ muted: window.__t.B.el.muted, vol: window.__t.B.el.volume, fading: window.__t.B.fading, paused: window.__t.B.el.paused }));
  check('一時停止すると <audio> も止まり、消音・音量は元どおり', af.paused && af.muted && af.vol === 1 && !af.fading, JSON.stringify(af));

  note('\n## 6. 引き継がない・引き継げない時');
  await ev(() => { navigator.mediaDevices.getUserMedia = async () => { const { A } = window.__t; return A.ctx.createMediaStreamDestination().stream; }; });
  await page.click('#micBtn');
  await page.waitForFunction(() => !!window.__t.A.mic);
  await page.click('#playBtn');
  await sleep(400);
  const mic = await ev(() => ({ el: !window.__t.B.el.paused, status: document.getElementById('bgStatus').textContent }));
  await ev(() => window.__setHidden(true));
  const mic2 = await ev(() => ({ mode: window.__t.T.mode, playing: window.__t.T.playing, msg: document.getElementById('msg').textContent }));
  check('マイクON：音声を回さず、隠れたら従来どおり一時停止して理由を出す', !mic.el && mic.status.includes('マイク') && mic2.mode === 'live' && !mic2.playing && mic2.msg.includes('マイク'), JSON.stringify({ mic, mic2 }));
  await ev(() => window.__setHidden(false));
  await page.click('#micBtn');
  await ready();
  // 設定を変えた直後に隠れた：完成を待って引き継ぐ
  await page.click('#playBtn');
  await sleep(400);
  await page.click('#soloBtn');
  const w = await ev(() => { window.__setHidden(true); return { mode: window.__t.T.mode, playing: window.__t.T.playing, pending: window.__t.B.pending }; });
  await page.waitForFunction(() => window.__t.T.mode === 'bg', null, { timeout: 15000 }).catch(() => {});
  const w2 = await ev(() => ({ mode: window.__t.T.mode, playing: window.__t.T.playing, solo: window.__t.B.used && window.__t.B.used.plan.levels.filter((x) => x > 0).length }));
  check('ソロを押した直後に隠れても、新しい音声の完成を待って引き継ぐ（待つ間は鳴り続ける）', w.mode === 'live' && w.playing && w.pending && w2.mode === 'bg' && w2.playing && w2.solo === 1, JSON.stringify({ w, w2 }));
  await ev(() => window.__setHidden(false));
  await page.click('#soloBtn');
  await page.click('#playBtn');
  await ready();
  // 端末が <audio> の再生を断った：従来どおりの一時停止にする
  await ev(() => {
    window.__origPlay = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () { return Promise.reject(new DOMException('blocked', 'NotAllowedError')); };
  });
  await page.click('#playBtn');
  await sleep(400);
  await ev(() => window.__setHidden(true));
  await sleep(200);
  const ref = await ev(() => ({ mode: window.__t.T.mode, playing: window.__t.T.playing, msg: document.getElementById('msg').textContent, last: window.__t.B.last }));
  check('<audio> の再生を断られたら一時停止にし、理由を出す', ref.mode === 'live' && !ref.playing && ref.msg.includes('断られ'), JSON.stringify(ref));
  await ev(() => { HTMLMediaElement.prototype.play = window.__origPlay; window.__setHidden(false); });
  // 曲を替えたら、前の曲の音声は使わない
  await page.setInputFiles('#fileIn', path.join(ROOT, 'tests', 'midi', 'satb_sjis.mid'));
  await ready();
  const ns = await ev(() => ({ src: window.__t.B.src, cache: window.__t.B.cache.length, parts: window.__t.B.cur.plan.levels.length }));
  check('曲を替えると、新しい曲の音声を準備し直す', ns.parts === 4 && ns.cache === 1, JSON.stringify(ns));

  note('\n## エラー');
  check('ページのエラーなし', errors.length === 0, errors.join(' / '));
  note(`\n結果：NG ${fails}件`);
  fs.writeFileSync(path.join(OUT, 'background_browser.txt'), log.join('\n'));
  await browser.close();
  server.close();
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exit(1); });
