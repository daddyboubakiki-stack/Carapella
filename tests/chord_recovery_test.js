// 和音練習の中断・マイク拒否・非同期の許可待ちを実際の関数から検証する。
const fs = require('fs');
const assert = require('node:assert/strict');
const html = fs.readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
const section = (a, b) => {
  const start = html.indexOf(a), end = html.indexOf(b, start);
  assert(start >= 0 && end > start);
  return html.slice(start, end);
};
function harness() {
  const CP = { on: true, kind: null, pending: null, request: 0, stopTimer: 0, idx: 0, trail: [] };
  const A = { mic: null, active: new Set(), ctx: { state: 'running', currentTime: 0, resume: async () => {} } };
  const T = { playing: false }, S = { live: { midi: 60 } }, document = { visibilityState: 'visible' };
  const log = { stopped: 0, paused: 0, notes: [], messages: [], micCalls: 0 };
  let getMic = async () => { A.mic = {}; };
  const src = section('function cpSound(kind)', 'function syncChordUI()');
  const api = new Function('CP', 'A', 'T', 'S', 'document', 'stopNotes', 'pause', 'say', 'kick', 'syncChordUI', 'ensureCtx', 'micOn', 'cpSeg', 'playNote', 'curTr', 'CP_HOLD', 'clamp', 'clearTimeout', 'setTimeout', src + '\nreturn { cpPress, cpSound, cpMove, stopForInterruption };')(
    CP, A, T, S, document, () => log.stopped++, () => { log.paused++; T.playing = false; }, m => log.messages.push(m), () => {}, () => {}, () => {},
    async () => { log.micCalls++; await getMic(); }, () => ({ notes: [60, 64] }), m => log.notes.push(m), () => 0, 30,
    (n, a, b) => Math.max(a, Math.min(b, n)), () => {}, () => 1
  );
  A.ctx.createGain = () => ({ gain: {}, connect() {} });
  A.guide = {}; S.sel = 0; S.pstate = [{ vol: 1, tone: 'soft' }, { vol: 1, tone: 'soft' }];
  CP.segs = [{}, {}];
  return { CP, A, T, S, document, log, ...api, mic: fn => { getMic = fn; } };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
(async () => {
  let h = harness();
  h.mic(async () => {});
  await h.cpPress('sing');
  assert.equal(h.CP.kind, null); assert.equal(h.CP.pending, null); assert.deepEqual(h.log.notes, []);
  console.log('PASS: denied/unavailable microphone never starts accompaniment');

  h = harness();
  let resumed = 0;
  h.mic(async () => { h.A.mic = {}; h.A.ctx.state = 'interrupted'; });
  h.A.ctx.resume = async () => { resumed++; h.A.ctx.state = 'running'; };
  await h.cpPress('sing');
  assert.equal(resumed, 1); assert.equal(h.CP.kind, 'sing'); assert.deepEqual(h.log.notes, [64]);
  console.log('PASS: context resumes AFTER mic acquisition; own part is excluded');

  h = harness();
  h.A.ctx.state = 'suspended'; h.A.ctx.resume = async () => { throw Error('blocked'); };
  await h.cpPress('demo'); assert.equal(h.CP.kind, null); assert.equal(h.CP.pending, null); assert.equal(h.log.messages.length, 1);
  console.log('PASS: failed audio resume leaves idle buttons and no sound');

  for (const kind of ['demo', 'sing']) {
    h = harness(); h.CP.kind = kind; h.CP.pending = 'sing'; h.A.active.add({});
    const req = h.CP.request;
    h.stopForInterruption('interrupted');
    assert.equal(h.CP.kind, null); assert.equal(h.CP.pending, null); assert(h.CP.request > req); assert.equal(h.S.live, null); assert(h.log.stopped > 0);
  }
  h = harness(); h.T.playing = true; h.stopForInterruption('hidden'); assert.equal(h.log.paused, 1);
  h = harness(); h.A.active.add({}); h.stopForInterruption('hidden'); assert(h.log.stopped > 0);
  console.log('PASS: chord, normal playback and short preview all stop on interruption');

  for (const cancel of ['back', 'hidden', 'move', 'replace']) {
    h = harness(); const d = deferred(); h.mic(async () => { await d.promise; h.A.mic = {}; });
    const old = h.cpPress('sing');
    await h.cpPress('sing'); assert.equal(h.log.micCalls, 1, 'repeated click must not duplicate permission');
    if (cancel === 'back') { h.cpSound(null); h.CP.on = false; }
    if (cancel === 'hidden') { h.document.visibilityState = 'hidden'; h.stopForInterruption('hidden'); }
    if (cancel === 'move') h.cpMove(1);
    if (cancel === 'replace') await h.cpPress('demo');
    const before = [...h.log.notes]; d.resolve(); await old;
    assert.deepEqual(h.log.notes, before, cancel + ': old request must not start sound');
  }
  console.log('PASS: back, hidden, next chord and newer playback cancel stale permission requests');

  h = harness(); const d = deferred(); h.A.ctx.state = 'interrupted';
  h.A.ctx.resume = () => d.promise;
  const p = h.cpPress('demo'); h.stopForInterruption('interrupted'); h.A.ctx.state = 'running'; d.resolve(); await p;
  assert.deepEqual(h.log.notes, []);
  console.log('PASS: late context resume cannot restart an interrupted chord');

  const callback = html.match(/ctx.addEventListener\('statechange', ([\s\S]*?)\n    \}\);/)[1] + '\n}';
  let stopped = 0; const CP = { on: true, kind: 'demo' }, T = { playing: false }, ctx = { state: 'interrupted' };
  new Function('ctx', 'CP', 'T', 'stopForInterruption', 'return (' + callback + ');')(ctx, CP, T, () => stopped++)();
  assert.equal(stopped, 1);
  const hiddenSrc = section('const onHidden =', "document.addEventListener('visibilitychange'");
  new Function('document','stopForInterruption', hiddenSrc + 'return onHidden;')({ visibilityState: 'hidden' }, () => stopped++)();
  assert.equal(stopped, 2);
  assert(html.includes("window.addEventListener('pagehide', () => stopForInterruption("));
  console.log('PASS: actual statechange, visibilitychange and pagehide handlers include chord interruption');
})().catch(e => { console.error(e); process.exitCode = 1; });
