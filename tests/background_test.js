// 画面を離れても聴くための音声（バックグラウンド再生）の、設定の反映・時刻の対応・引き継ぎの判断を、実装の関数で検証する。
// 実機の画面ロック・別アプリ切り替えの代わりにはならない（docs/handoff-controls-2026-11-05.md の実機手順で確かめる）。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const section = (a, b) => {
  const i = html.indexOf(a), j = html.indexOf(b, i);
  assert(i >= 0 && j > i, a);
  return html.slice(i, j);
};
const near = (a, b, eps = 1e-9, msg) => assert(Math.abs(a - b) < eps, (msg || '') + ` ${a} != ${b}`);

function harness() {
  const el = {
    paused: true, ended: false, muted: false, loop: false, currentTime: 0, readyState: 4, src: '', calls: [],
    canPlayType: () => 'maybe',
    play() { this.calls.push('play'); if (this.reject) return Promise.reject(Object.assign(new Error('no'), { name: this.reject })); this.paused = false; return Promise.resolve(); },
    pause() { this.calls.push('pause'); this.paused = true; },
    addEventListener() {}, removeAttribute() {}, load() {},
  };
  const nodes = new Map();
  const state = {
    S: {
      song: { duration: 60, bars: Array.from({ length: 30 }, (_, i) => ({ t: i * 2, n: i + 1, num: 4 })),
        parts: [0, 1, 2].map((i) => ({ name: 'P' + i, notes: [{ s: 1 + i, e: 3 + i, m: 60 + i }] })) },
      label: 'テスト曲', sel: 1, mode: 1, solo: false, guideVol: 0.8, rate: 1, transpose: 0, countIn: true,
      pstate: [{ vol: 0.7, muted: false, tone: 'soft' }, { vol: 0.7, muted: false, tone: 'clear' }, { vol: 0.7, muted: false, tone: 'voice' }],
      loop: { on: false, scope: 'all', a: 0, b: 1, t: null, mark: null }, events: [],
    },
    T: { playing: false, mode: 'live', pos: 0, p0: 0, t0: 0, rate: 1, tr: 0, timer: 7, cN: 0 },
    A: { ctx: { currentTime: 100, state: 'running' }, mic: null, active: new Set() },
    CP: { on: false }, R: null, recStarting: false, view: { follow: false },
    MODES: { 1: { mark: '①', name: '一緒に', own: 1, others: 1 }, 2: { mark: '②', name: '小さく', own: 0.3, others: 1 }, 3: { mark: '③', name: '自分なし', own: 0, others: 1 }, 4: { mark: '④', name: 'ひとりで', own: 0, others: 0 } },
    LOOP_TAIL: 0.25,
    window: { OfflineAudioContext: function () {} },
    document: { visibilityState: 'visible' },
    navigator: {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    performance: { now: () => 0 },
    setTimeout: () => 1, clearTimeout() {}, clearInterval() {},
    calls: [], said: [],
    $: (id) => { if (!nodes.has(id)) nodes.set(id, { textContent: '' }); return nodes.get(id); },
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    fmt: (t) => String(Math.round(t * 100) / 100),
    el,
  };
  const c = vm.createContext(state);
  vm.runInContext(`
    function stopNotes() { calls.push('stopNotes'); }
    function play(p, take, opts) { T.playing = true; T.mode = 'live'; T.p0 = p; calls.push({ play: p, opts }); }
    function pause() { calls.push('pause'); T.playing = false; }
    function ensureCtx() {}
    function viewTime() { return T.mode === 'bg' ? bgSongTime() : T.playing ? clock : T.pos; }
    function say(t, info) { said.push(t); }
    function syncTransportUI() {} function syncViewUI() {} function kick() {}
    function stopForInterruption(m) { calls.push('interrupt'); T.playing = false; }
    function seekRelative(s) { calls.push({ seekRelative: s }); }
    function togglePlay() { calls.push('toggle'); }
    function barIndexAt(t) { return Math.min(29, Math.floor(t / 2)); }
    function barEnd(i) { return (i + 1) * 2; }
    function barCount() { return 30; }
    function countParams(p) { return { n: 4, beat: 0.5 }; }
    var clock = 0;
  `, c);
  vm.runInContext(section('const modeFactor =', '// amps は'), c);
  vm.runInContext(section('const partLevel =', 'function syncSoloUI('), c);
  vm.runInContext(section('const looping =', 'function countParams('), c);
  vm.runInContext(section('const BG_SR =', '// ===== マイクと音程判定'), c);
  vm.runInContext('B.el = el; B.silent = "blob:silent";', c);
  return { state, run: (code) => vm.runInContext(code, c), el };
}

// 1) 設定ごとに音声の中身（署名）が変わり、ソロ・段階・音量・音色・テンポ・キー・ループ・カウントを反映する
{
  const h = harness();
  const sig = () => h.run('bgSig()');
  const base = sig();
  const plan = h.run('bgPlan()');
  assert.deepEqual(Array.from(plan.levels), [0.7, 0.7, 0.7]);
  near(plan.sec, 60.5);
  const changes = {
    solo: 'S.solo = true', mode3: 'S.mode = 3', mute: 'S.pstate[0].muted = true', volume: 'S.pstate[2].vol = 1.4',
    tone: "S.pstate[0].tone = 'organ'", tempo: 'S.rate = 0.5', key: 'S.transpose = 2', guide: 'S.guideVol = 0.4',
    loopAll: "S.loop = { on: true, scope: 'all', a: 0, b: 1, t: null, mark: null }",
  };
  for (const [name, code] of Object.entries(changes)) {
    const one = harness();
    one.run(code);
    assert.notEqual(one.run('bgSig()'), base, name + ' must change the prepared audio');
  }
  // ソロ中は段階を変えても聞こえる音は同じ（ソロが優先）なので、作り直さない
  h.run('S.solo = true');
  const soloSig = sig();
  h.run('S.mode = 3');
  assert.equal(sig(), soloSig);
  // ソロは選んだパートだけ（自分のミュート・③④を上書き）。ほかのパートの音色は音声に影響しないので署名にも入れない
  h.run("S.loop.on = false; S.solo = true; S.mode = 4; S.pstate[1].muted = true;");
  const solo = h.run('bgPlan()');
  assert.deepEqual(Array.from(solo.levels), [0, 0.7, 0]);
  assert.deepEqual(Array.from(solo.tones), [null, 'clear', null]);
  const before = sig();
  h.run("S.pstate[0].tone = 'voice'");
  assert.equal(sig(), before, 'silent parts do not cause a re-render');
  // カウントのON/OFFは、ループの1周に入る「間・カウント」だけを変える
  h.run("S.solo = false; S.mode = 1; S.loop = { on: true, scope: 'section', a: 3, b: 4, t: null, mark: null }");
  const lp = h.run('bgPlan()');
  assert.deepEqual(Array.from(lp.loop), [6, 10]);
  near(lp.pre, 0.1); near(lp.lead, 2); assert.equal(lp.n, 4);
  near(lp.sec, 0.1 + 2 + 4 + 0.25);
  h.run('S.countIn = false');
  const lp2 = h.run('bgPlan()');
  near(lp2.pre, 0.08); near(lp2.lead, 0); near(lp2.sec, 0.08 + 4 + 0.25);
  // ③④はカウント中に自分の最初の音（区間の中の最初の音）
  h.run('S.countIn = true; S.mode = 3; S.loop.a = 0; S.loop.b = 1; S.sel = 2');
  const own = h.run('bgPlan()');
  assert.deepEqual({ ...own.own }, { m: 62, tone: 'voice' });
  // テンポは長さとカウントの間隔に効く
  h.run('S.rate = 0.5');
  const slow = h.run('bgPlan()');
  near(slow.beat, 1); near(slow.sec, 0.1 + 4 + 8 + 0.25);
  console.log('PASS: prepared audio follows solo, stage, mute, volume, tone, tempo, key, guide volume, loop range and count-in');
}

// 2) 曲の時刻 ⇔ 音声ファイルの時刻
{
  const h = harness();
  h.run('S.rate = 0.8');
  for (const t of [0, 1.234, 30, 59.9]) near(h.run(`bgSongTimeAt(bgPlan(), bgFileTime(bgPlan(), ${t}))`), t, 1e-9, 'whole song round trip');
  near(h.run('bgFileTime(bgPlan(), 40)'), 50);
  h.run("S.loop = { on: true, scope: 'section', a: 3, b: 4, t: null, mark: null }");
  const p = h.run('bgPlan()');
  near(h.run('bgFileTime(bgPlan(), 6)'), p.pre + p.lead);
  near(h.run('bgFileTime(bgPlan(), 8)'), p.pre + p.lead + 2 / 0.8);
  near(h.run('bgSongTimeAt(bgPlan(), 0.05)'), 6, 1e-9, 'count-in maps to the section start');
  near(h.run(`bgSongTimeAt(bgPlan(), ${p.sec - 0.01})`), 10, 1e-9, 'tail maps to the section end');
  console.log('PASS: song time and audio-file time map both ways, with tempo, count-in and loop tail');
}

// 3) 画面が隠れた時の判断：聴くだけなら引き継ぐ。マイク・録音・聴き返し・和音練習・未準備なら引き継がない
{
  const ready = (h) => h.run("B.cur = { sig: bgSig(), plan: bgPlan(), url: 'blob:a' }");
  let h = harness();
  h.run("T.playing = true; T.mode = 'live'; T.p0 = 10; T.t0 = 90; clock = 20; S.rate = 1");
  ready(h);
  h.el.paused = false; h.el.muted = true; h.el.src = 'blob:a'; h.run("B.src = 'blob:a'");
  assert.equal(h.run('bgHandoff()'), 'ok');
  assert.equal(h.state.T.mode, 'bg');
  assert.equal(h.state.T.playing, true);
  assert.equal(h.el.muted, false, 'audio element becomes audible');
  near(h.el.currentTime, 20, 1e-9, 'continues from the audible position');
  assert.equal(h.el.loop, false);
  assert(h.state.calls.includes('stopNotes'));
  assert.equal(h.state.T.timer, 0, 'Web Audio scheduler stops');
  assert(!h.el.calls.includes('play'), 'an already running shadow is unmuted, not restarted');
  // 戻った：同じ位置から通常の再生へ
  h.el.currentTime = 23.5;
  h.run('bgReturn()');
  assert.equal(h.state.T.mode, 'live');
  assert.equal(h.state.calls.at(-1).play, 23.5);
  assert.equal(h.state.calls.at(-1).opts, undefined, 'no extra count-in after returning mid-song');
  assert.equal(h.el.muted, true);
  assert.equal(h.state.view.follow, true, 'score follows playback again');

  for (const [name, code] of [['mic', 'A.mic = {}'], ['recording', 'R = {}'], ['chord', 'CP.on = true'], ['review', "T.mode = 'review'"]]) {
    h = harness();
    h.run("T.playing = true; T.mode = 'live'");
    ready(h);
    h.run(code);
    assert.equal(h.run('bgHandoff()'), '', name + ' keeps the old pause');
    assert.notEqual(h.state.T.mode, 'bg');
  }
  // 設定を変えた直後で音声が古い：作っている途中なら完成を待つ。作っていなければ引き継がない
  h = harness();
  h.run("T.playing = true; T.mode = 'live'; B.cur = { sig: 'old', plan: bgPlan(), url: 'blob:a' }");
  assert.equal(h.run('bgHandoff()'), '');
  h.run('B.busy = true');
  assert.equal(h.run('bgHandoff()'), 'wait');
  assert.equal(h.run('B.pending'), true);
  assert.equal(h.state.T.mode, 'live', 'Web Audio keeps playing while waiting');
  console.log('PASS: hidden page hands listening playback to <audio>; mic, recording, review, chord practice and stale audio do not');
}

// 4) カウント中・ループ・テンポ50%の位置合わせ、戻った時のカウント
{
  const h = harness();
  h.run("S.rate = 0.5; S.loop = { on: true, scope: 'section', a: 3, b: 4, t: null, mark: null }");
  h.run("T.playing = true; T.mode = 'live'; T.p0 = 6; T.t0 = 101.5; A.ctx.currentTime = 100");
  h.run("B.cur = { sig: bgSig(), plan: bgPlan(), url: 'blob:a' }");
  const p = h.run('bgPlan()');
  assert.equal(h.run('bgHandoff()'), 'ok');
  near(h.el.currentTime, p.pre + p.lead - 1.5, 1e-9, 'count-in continues in the file');
  assert.equal(h.el.loop, true, 'section loop repeats natively in <audio>');
  h.run('bgReturn()');
  assert.deepEqual(JSON.parse(JSON.stringify(h.state.calls.at(-1))), { play: 6, opts: { count: true } }, 'returning during count-in restarts the count');
  // ロック画面の ±10 秒は曲の時刻で動き、区間ループでは区間の中に収まる
  h.run("T.playing = true; T.mode = 'live'; T.t0 = 0; A.ctx.currentTime = 100; clock = 7");
  h.run("B.cur = { sig: bgSig(), plan: bgPlan(), url: 'blob:a' }");
  h.run('bgHandoff()');
  h.run('bgSeekBy(10)');
  near(h.run('bgSongTime()'), 9.95, 1e-9);
  h.run('bgSeekBy(-10)');
  near(h.run('bgSongTime()'), 6, 1e-9);
  console.log('PASS: count-in, tempo 50% and section loop positions; lock-screen ±10s stays inside the section');
}

// 5) ロック画面・イヤホン・電話・曲の終わりで <audio> が止まったら、アプリも一時停止として扱い、戻ったらその位置を表示する
{
  const h = harness();
  h.run("T.playing = true; T.mode = 'live'; clock = 30");
  h.run("B.cur = { sig: bgSig(), plan: bgPlan(), url: 'blob:a' }");
  h.run('bgHandoff()');
  h.el.paused = true; h.el.currentTime = 41;
  h.run("bgOnEl({ type: 'pause' })");
  assert.equal(h.state.T.playing, false);
  near(h.run('viewTime()'), 41);
  h.run('bgReturn()');
  assert.equal(h.state.T.mode, 'live');
  assert.equal(h.state.T.playing, false);
  near(h.state.T.pos, 41);
  assert(!h.state.calls.some((x) => x && x.play !== undefined), 'paused state is not restarted on return');
  // 末尾まで行った
  h.run("T.playing = true; T.mode = 'live'; clock = 59");
  h.run('bgHandoff()');
  h.el.ended = true; h.el.paused = true; h.el.currentTime = 60.5;
  h.run("bgOnEl({ type: 'ended' })");
  assert.equal(h.state.T.playing, false);
  h.run('bgReturn()');
  near(h.state.T.pos, 60);
  // 端末に断られた
  const h2 = harness();
  h2.run("T.playing = true; T.mode = 'live'; clock = 12");
  h2.run("B.cur = { sig: bgSig(), plan: bgPlan(), url: 'blob:a' }");
  h2.el.reject = 'NotAllowedError';
  assert.equal(h2.run('bgHandoff()'), 'ok');
  return Promise.resolve().then(() => new Promise((r) => setImmediate(r))).then(() => {
    assert.equal(h2.state.T.mode, 'live');
    assert.equal(h2.state.T.playing, false);
    near(h2.state.T.pos, 12);
    assert(h2.state.said.at(-1).includes('断られ'));
    console.log('PASS: pauses from the lock screen, headphones, calls, song end and refused playback become a consistent paused state');
  });
}
