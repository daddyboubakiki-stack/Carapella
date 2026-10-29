// 改修版のテスト：前回の判定結果が変わっていないか（回帰）＋新機能（段階・カウント・区間・録音まわり・スマホ対策）
require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
// マイクは前回と同じく「ガイド音をそのままマイクへ流す」仕掛け。__detune で歌う人の音程をずらす。
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'tests', 'out');
const only = process.argv[2] || 'all';
const log = [];
let fails = 0;
const note = (...a) => { const s = a.join(' '); log.push(s); console.log(s); };
const check = (label, ok, detail = '') => { if (!ok) fails++; note(`  ${ok ? 'OK ' : 'NG '} ${label}${detail ? '：' + detail : ''}`); };

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
}).listen(0);
const URL = 'http://localhost:' + server.address().port + '/';

const HARNESS = () => {
  window.__ctxs = [];
  const OrigAC = window.AudioContext;
  window.AudioContext = class extends OrigAC { constructor(...a) { super(...a); window.__ctxs.push(this); } };
  window.__detune = 0;
  const oc = BaseAudioContext.prototype.createOscillator;
  BaseAudioContext.prototype.createOscillator = function () { const o = oc.call(this); o.detune.value = window.__detune; return o; };
  window.__starts = [];
  const st = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (when) { window.__starts.push({ f: this.frequency.value, when, now: this.context.currentTime }); return st.call(this, when); };
  const conn = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    const r = conn.call(this, dest, ...rest);
    if (dest instanceof AudioDestinationNode) {
      const ctx = this.context;
      if (!ctx.__leak) ctx.__leak = ctx.createGain();
      if (!ctx.__guide) { ctx.__guide = this; conn.call(this, ctx.__leak); }
    }
    return r;
  };
  navigator.mediaDevices.getUserMedia = async () => {
    const ctx = window.__ctxs[window.__ctxs.length - 1];
    const d = ctx.createMediaStreamDestination();
    conn.call(ctx.__leak, d);
    return d.stream;
  };
  // iPhone の audioSession と画面スリープ防止を、呼ばれたかどうか記録できる偽物にする
  window.__session = [];
  const sess = { _t: 'auto' };
  Object.defineProperty(sess, 'type', { get() { return this._t; }, set(v) { this._t = v; window.__session.push(v); } });
  Object.defineProperty(navigator, 'audioSession', { value: sess, configurable: true });
  window.__wake = [];
  Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: { request: async () => { window.__wake.push('request'); const s = new EventTarget(); s.release = async () => { window.__wake.push('release'); }; return s; } } });
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = (page, sel) => page.$eval(sel, (e) => e.textContent.trim());
async function setRange(page, id, v) {
  await page.evaluate(([id, v]) => { const e = document.getElementById(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); }, [id, v]);
}
async function setCheck(page, id, on) {
  await page.evaluate(([id, on]) => { const e = document.getElementById(id); if (e.checked !== on) e.click(); }, [id, on]);
}
async function setMute(page, i, muted) {
  await page.evaluate(([i, muted]) => { const b = document.querySelector(`#parts .part:nth-child(${i + 1}) .iconbtn`); if ((b.getAttribute('aria-pressed') === 'true') !== muted) b.click(); }, [i, muted]);
}
const selectPart = (page, i) => page.click(`.chip:nth-child(${i + 1})`);
const setMode = (page, m) => page.evaluate((m) => document.querySelector(`input[name="mode"][value="${m}"]`).click(), m);
const seek = (page, t) => page.evaluate((t) => { const e = document.getElementById('seek'); e.value = String(t); e.dispatchEvent(new Event('change')); }, t);
const isPlaying = (page) => page.$eval('#playLbl', (e) => e.textContent.includes('一時停止'));
async function stop(page) { if (await isPlaying(page)) await page.click('#playBtn'); }
const ctxTime = (page) => page.evaluate(() => window.__ctxs[0].currentTime);

async function sing(page, { from = 0, secs = 9, part = 0, audible = [true, true, true], detune = 0, tol = 50, oct = false, lat = null, mode = 1 }) {
  await stop(page);
  await page.evaluate((d) => { window.__detune = d; }, detune);
  await selectPart(page, part);
  await setMode(page, mode);
  for (let i = 0; i < 3; i++) await setMute(page, i, !audible[i]);
  await page.evaluate(([tol, oct]) => {
    document.querySelector(`input[name="tol"][value="${tol}"]`).click();
    const o = document.getElementById('octFree'); if (o.checked !== oct) o.click();
  }, [tol, oct]);
  if (lat != null) await setRange(page, 'lat', lat);
  await seek(page, from);
  await page.click('#playBtn');
  await sleep(secs * 1000);
  const score = await text(page, '#scoreLbl');
  await stop(page);
  return score;
}

(async () => {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, acceptDownloads: true });
  await ctx.addInitScript(HARNESS);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route(/fonts\.g/, (r) => r.abort());
  await page.goto(URL);
  await page.click('#demoBtn');
  await sleep(300);
  await page.click('#micBtn');
  await sleep(400);

  if (only === 'all' || only === 'judge') {
    note('\n## 1. 判定の回帰テスト（カウントなし・①一緒に。前回の結果と比べる）');
    await setCheck(page, 'countIn', false);
    const prev = { perfect: 100, sharp30n: 99, sharp30s: 0, semi: 0, oct: 0, octFree: 100, part3: 100 };
    const R = {};
    R.perfect = await sing(page, { audible: [true, false, false] });
    R.sharp30n = await sing(page, { audible: [true, false, false], detune: 30, tol: 50 });
    R.sharp30s = await sing(page, { audible: [true, false, false], detune: 30, tol: 25 });
    R.semi = await sing(page, { audible: [true, false, false], detune: 100 });
    R.oct = await sing(page, { audible: [true, false, false], detune: -1200 });
    R.octFree = await sing(page, { audible: [true, false, false], detune: -1200, oct: true });
    R.part3 = await sing(page, { from: 9.6, part: 2, audible: [false, false, true] });
    for (const k of Object.keys(prev)) {
      const m = /(\d+)%/.exec(R[k]);
      const v = m ? Number(m[1]) : null;
      check(`${k}: 前回 ${prev[k]}% → 今回 ${R[k] || '（表示なし）'}`, v != null && Math.abs(v - prev[k]) <= 3);
    }
  }

  if (only === 'all' || only === 'modes') {
    note('\n## 2. 練習の段階（マイクにはスピーカーから漏れた音だけが入る＝歌っていない状態）');
    await setCheck(page, 'countIn', false);
    for (let i = 0; i < 3; i++) await setMute(page, i, false);
    const m1 = await sing(page, { audible: [true, true, true], mode: 1, secs: 4 });
    check('①一緒に：自分のガイドが漏れて、歌わなくても点が出る（前回の問題2の再現）', /\d+%/.test(m1) && Number(/(\d+)%/.exec(m1)[1]) > 80, m1);
    const m3 = await sing(page, { from: 4.8, audible: [true, true, true], mode: 3, secs: 6 });
    const v3 = /(\d+)%/.exec(m3);
    check('③自分なし：自分のガイドが鳴らないので、歌わなければ点は低い', !v3 || Number(v3[1]) < 20, m3 || '（判定対象なし）');
    const m4 = await sing(page, { audible: [true, true, true], mode: 4, secs: 4 });
    check('④ひとりで：ガイドが鳴らないので、マイクに何も入らず点は出ない', m4 === '', m4 || '（表示なし）');
    // ③④のカウント中に自分のパートの最初の音が鳴るか
    await setCheck(page, 'countIn', true);
    await setMode(page, 3);
    await selectPart(page, 0);
    await seek(page, 0);
    const n0 = await page.evaluate(() => window.__starts.length);
    const t0 = await ctxTime(page);
    await page.click('#playBtn');
    await sleep(800);
    const st = await page.evaluate((n) => window.__starts.slice(n), n0);
    await stop(page);
    const c4 = 261.63;
    const startNote = st.find((s) => Math.abs(s.f - c4) < 1 && s.when < t0 + 0.5);
    check('③でカウント中に最初の音（C4）が鳴る', !!startNote);
    await setMode(page, 1);
    const n1 = await page.evaluate(() => window.__starts.length);
    const t1 = await ctxTime(page);
    await page.click('#playBtn');
    await sleep(800);
    const st1 = await page.evaluate((n) => window.__starts.slice(n), n1);
    await stop(page);
    check('①ではカウント中に最初の音を鳴らさない（ガイドがあるため）', !st1.some((s) => Math.abs(s.f - c4) < 1 && s.when < t1 + 0.5));
  }

  if (only === 'all' || only === 'count') {
    note('\n## 3. カウントイン');
    await setCheck(page, 'countIn', true);
    await setMode(page, 1);
    for (const rate of [100, 50]) {
      await setRange(page, 'rate', rate);
      await seek(page, 0);
      const n0 = await page.evaluate(() => window.__starts.length);
      await page.click('#playBtn');
      await sleep(rate === 100 ? 3200 : 5600);
      const st = await page.evaluate((n) => window.__starts.slice(n), n0);
      const clicks = st.filter((s) => s.f === 1760 || s.f === 1320).sort((a, b) => a.when - b.when);
      const firstNote = st.filter((s) => s.f !== 1760 && s.f !== 1320).sort((a, b) => a.when - b.when)[0];
      const gaps = clicks.slice(1).map((c, i) => c.when - clicks[i].when);
      const beat = 0.6 / (rate / 100);
      check(`テンポ${rate}%：クリック4回`, clicks.length === 4, clicks.length + '回');
      check(`テンポ${rate}%：間隔 ${beat}秒`, gaps.every((g) => Math.abs(g - beat) < 0.005), gaps.map((g) => g.toFixed(3)).join(','));
      check(`テンポ${rate}%：1拍目は高い音（強拍）`, clicks[0] && clicks[0].f === 1760);
      check(`テンポ${rate}%：最後のクリックの1拍後に歌が始まる`, firstNote && Math.abs(firstNote.when - (clicks[3].when + beat)) < 0.01, firstNote ? (firstNote.when - clicks[3].when).toFixed(3) + '秒後' : 'なし');
      await stop(page);
    }
    await setRange(page, 'rate', 100);
    await seek(page, 3);
    await page.click('#playBtn');
    await sleep(800);
    const tl = await text(page, '#timeLbl');
    await page.click('#playBtn');
    check('カウント中は位置が進まない', tl.startsWith('0:03'), tl);
    const tl2 = await text(page, '#timeLbl');
    check('カウント中に止めると、歌い出しの位置（0:03）に戻る', tl2.startsWith('0:03'), tl2);
    // シークで再生し直す時はカウントしない
    await page.click('#playBtn');
    await sleep(3000);
    const n2 = await page.evaluate(() => window.__starts.length);
    await seek(page, 10);
    await sleep(500);
    const st2 = await page.evaluate((n) => window.__starts.slice(n), n2);
    check('再生中のシークではカウントしない', !st2.some((s) => s.f === 1760 || s.f === 1320));
    await stop(page);
  }

  if (only === 'all' || only === 'loop') {
    note('\n## 4. 区間リピート');
    await setCheck(page, 'countIn', false);
    await setMode(page, 1);
    await selectPart(page, 0);
    for (let i = 0; i < 3; i++) await setMute(page, i, i !== 0);
    await page.evaluate(() => { window.__detune = 0; });
    await setRange(page, 'lat', 40);
    await seek(page, 3); // 2小節目
    await page.click('#loopBtn'); // 今の小節から2小節＝2〜3小節（2.4〜7.2秒）
    const range = await page.evaluate(() => [document.getElementById('loopAOut').textContent, document.getElementById('loopBOut').textContent]);
    check('区間の初期値は今の小節から2小節（2〜3小節）', range.join('-') === '2-3', range.join('〜'));
    await page.click('#playBtn');
    let minT = 99, maxT = 0;
    for (let i = 0; i < 34; i++) {
      await sleep(500);
      const t = await page.evaluate(() => { const m = /(\d+):(\d+)/.exec(document.getElementById('timeLbl').textContent); return Number(m[1]) * 60 + Number(m[2]); });
      minT = Math.min(minT, t); maxT = Math.max(maxT, t);
    }
    const passes = await text(page, '#passes');
    await stop(page);
    check('17秒のあいだ、位置が区間（0:02〜0:07）の中を行き来する', minT >= 2 && maxT <= 7, `${minT}〜${maxT}秒`);
    check('回ごとの一致が記録される（2回以上）', (passes.match(/%/g) || []).length >= 2, passes);
    // カウントありの区間：毎回カウントが入る
    await setCheck(page, 'countIn', true);
    const n0 = await page.evaluate(() => window.__starts.length);
    await page.click('#playBtn');
    await sleep(12500);
    const st = await page.evaluate((n) => window.__starts.slice(n), n0);
    await stop(page);
    const downbeats = st.filter((s) => s.f === 1760).length;
    check('カウントありでは、繰り返しのたびにカウントが入る', downbeats >= 2, `強拍クリック${downbeats}回`);
    // 区間を録音：1回分で自動的に止まる
    await setCheck(page, 'countIn', false);
    await page.click('#recBtn');
    await sleep(1000);
    const dis = await page.evaluate(() => ({ chip: document.querySelector('.chip').disabled, mode: document.querySelector('input[name="mode"]').disabled, loop: document.getElementById('loopBtn').disabled }));
    check('録音中はパート・段階・区間を変えられない', dis.chip && dis.mode && dis.loop, JSON.stringify(dis));
    await page.click('.chip:nth-child(2)', { force: true }).catch(() => {});
    check('録音中にパートを押しても切り替わらない', await page.$eval('.chip:nth-child(1)', (e) => e.getAttribute('aria-checked') === 'true'));
    await sleep(6000);
    const recState = await text(page, '#recLbl');
    check('区間の終わりで録音が自動で止まる', recState === '録音', recState);
    await sleep(600);
    const take = (await page.$$eval('.take .info', (els) => els.map((e) => e.textContent)))[0] || '';
    check('テイクに段階と「区間」が記録される', /①一緒に・区間/.test(take) && /0:02〜0:07/.test(take), take);
    // 再生を途中で止めても、次の再生・録音は区間の始まりから
    await setCheck(page, 'countIn', false);
    await page.click('#playBtn'); await sleep(3500); await page.click('#playBtn');
    const mid = await text(page, '#timeLbl');
    await page.click('#playBtn'); await sleep(400);
    const restart = await text(page, '#timeLbl');
    await stop(page);
    check('区間の途中で止めて再生すると、区間の始まり（0:02）から', restart.startsWith('0:02'), `止めた所 ${mid.slice(0, 4)} → 再生 ${restart.slice(0, 4)}`);
    await page.click('#loopBtn');
    check('区間リピートを切る', !(await page.$eval('#loopBtn', (e) => e.getAttribute('aria-pressed') === 'true')));
  }

  if (only === 'all' || only === 'guard') {
    note('\n## 5. 保存していない録音を消す前の確認');
    if (!(await page.$$('.take')).length) {
      await setCheck(page, 'countIn', false);
      await seek(page, 0);
      await page.click('#recBtn'); await sleep(4000); await page.click('#recBtn'); await sleep(600);
    }
    const before = (await page.$$('.take')).length;
    await page.click('#demoBtn');
    await sleep(200);
    check('確認の帯が出る', !(await page.$eval('#confirmBar', (e) => e.hidden)), await text(page, '#confirmText'));
    await page.click('#confirmNo');
    check('「やめる」で録音は残る', (await page.$$('.take')).length === before);
    await page.click('.take .btn.primary');
    await sleep(1500);
    const rv = await text(page, '#scoreLbl');
    const rvBtn = await page.$eval('.take .btn', (b) => b.textContent);
    await stop(page);
    check('テイクの聴き返しができる（段階つきで表示）', rvBtn === '止める' && /このテイク（①一緒に）/.test(rv), rv);
    await page.setInputFiles('#fileIn', path.join(ROOT, 'tests', 'midi', 'not_midi.mid'));
    await sleep(300);
    check('読めないファイルを選んでも、録音は消えず確認も出ない', (await page.$$('.take')).length === before && (await page.$eval('#confirmBar', (e) => e.hidden)));
    for (const b of await page.$$('.take .tools .btn:first-child')) {
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 3000 }).catch(() => null), b.click()]);
      if (dl) await dl.cancel().catch(() => {});
    }
    await page.click('#demoBtn');
    await sleep(200);
    check('全部保存した後は確認なしで開く', (await page.$eval('#confirmBar', (e) => e.hidden)) && (await page.$$('.take')).length === 0);
  }

  if (only === 'all' || only === 'mobile') {
    note('\n## 6. スマホ向けの動き');
    // 画面を切り替えたら一時停止
    await setCheck(page, 'countIn', false);
    await seek(page, 0);
    await page.click('#playBtn');
    await sleep(1000);
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(200);
    check('ほかの画面に切り替わると一時停止する', !(await isPlaying(page)), await text(page, '#msg'));
    await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); });
    // 音が外から止められたら一時停止
    await page.click('#playBtn');
    await sleep(800);
    await page.evaluate(() => window.__ctxs[0].suspend());
    await sleep(500);
    check('音が止められたら（電話などを想定）一時停止する', !(await isPlaying(page)), await text(page, '#msg'));
    await page.click('#playBtn');
    await sleep(800);
    check('もう一度「再生」で音が戻る', (await page.evaluate(() => window.__ctxs[0].state)) === 'running' && (await isPlaying(page)));
    await stop(page);
    const sess = await page.evaluate(() => window.__session.slice());
    check('iPhone用：再生では playback、マイク使用中は play-and-record を伝える', sess.includes('playback') && sess.includes('play-and-record'), [...new Set(sess)].join(', '));
    const wake = await page.evaluate(() => window.__wake.slice());
    check('再生中は画面スリープ防止を頼み、止めたら解除する', wake.includes('request') && wake.includes('release'), wake.slice(0, 6).join(','));
    // 設定の記憶
    await page.evaluate(() => document.querySelector('input[name="naming"][value="ja"]').click());
    await selectPart(page, 1);
    await setMode(page, 3);
    await page.reload();
    await sleep(300);
    await page.click('#demoBtn');
    await sleep(300);
    const remembered = await page.evaluate(() => ({ part: document.querySelector('.chip[aria-checked="true"]').textContent, mode: document.querySelector('input[name="mode"]:checked').value, naming: document.querySelector('input[name="naming"]:checked').value, range: document.querySelector('.chip .r').textContent }));
    check('再読み込み後もパート・段階・音名の書き方を覚えている', remembered.part.startsWith('2番手') && remembered.mode === '3' && remembered.naming === 'ja', JSON.stringify(remembered));
    // LINE の中のブラウザ・タッチ端末
    const c2 = await browser.newContext({ viewport: { width: 390, height: 664 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.9.0' });
    const p2 = await c2.newPage();
    await p2.route(/fonts\.g/, (r) => r.abort());
    await p2.goto(URL);
    check('LINEの中で開くと案内が出る', !(await p2.$eval('#inAppNote', (e) => e.hidden)));
    check('タッチ端末ではファイルの種類で絞り込まない（LINEから保存したファイルも選べる）', (await p2.$eval('#fileIn', (e) => e.getAttribute('accept'))) === null);
    await p2.screenshot({ path: OUT + '/v2_line_banner.png' });
    await c2.close();
    const c3 = await browser.newContext({ viewport: { width: 412, height: 780 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36' });
    await c3.addInitScript(HARNESS);
    const p3 = await c3.newPage();
    const e3 = [];
    p3.on('pageerror', (e) => e3.push(e.message));
    await p3.route(/fonts\.g/, (r) => r.abort());
    await p3.goto(URL);
    check('Android相当：通常のブラウザでは案内を出さない', await p3.$eval('#inAppNote', (e) => e.hidden));
    await p3.setInputFiles('#fileIn', path.join(ROOT, 'tests', 'midi', 'satb_sjis.mid'));
    await sleep(300);
    await p3.tap('.chip:nth-child(4)');
    await p3.tap('#micBtn');
    await sleep(300);
    await p3.tap('#loopBtn');
    await p3.tap('#playBtn');
    await sleep(3000);
    const st3 = await p3.evaluate(() => ({ part: document.querySelector('.chip[aria-checked="true"]').textContent, playing: document.getElementById('playLbl').textContent, you: document.getElementById('hYou').textContent }));
    check('Android相当：タップでパート選択・マイク・区間・再生ができる', st3.part.startsWith('ベース') && st3.playing === '一時停止' && st3.you !== 'オフ', JSON.stringify(st3));
    await p3.screenshot({ path: OUT + '/v2_android_satb.png' });
    check('Android相当：エラーなし', e3.length === 0, e3.join(';'));
    await c3.close();
  }

  note('\n## エラー');
  const errs = errors.filter((e) => !/fonts\.g|ERR_FAILED/.test(e));
  check('ページのエラーなし', errs.length === 0, errs.join(' / '));
  note(`\n結果：NG ${fails}件`);
  fs.writeFileSync(OUT + `/e2e2_${only}.txt`, log.join('\n'));
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
