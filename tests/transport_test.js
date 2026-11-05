// 実装の関数を使って、一時ソロ・ループの範囲・再生中のシークを検証する。
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
function harness() {
  const nodes = new Map();
  const state = {
    S: { song: { duration: 60, bars: Array.from({ length: 30 }, (_, i) => ({ t: i * 2, n: i + 1 })) }, sel: 1,
      mode: 1, solo: false, showOthers: true, guideVol: 0.8, passes: [],
      pstate: [{ vol: 0.4, muted: false }, { vol: 0.8, muted: true }, { vol: 1.2, muted: false }],
      loop: { on: false, scope: 'all', a: 0, b: 1, t: null, mark: null } },
    T: { playing: false, mode: 'live', pos: 25, p0: 25, end: Infinity }, CP: { on: false }, R: null,
    MODES: { 1: { own: 1, others: 1 }, 2: { own: 0.3, others: 1 }, 3: { own: 0, others: 1 }, 4: { own: 0, others: 0 } },
    A: { ctx: { currentTime: 10 }, partGains: [], guide: { gain: { setTargetAtTime() {} } } },
    calls: [], clock: 25, view: { follow: false, time: 12, pitchOffset: 3 },
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { setAttribute(k, v) { this[k] = v; } });
      return nodes.get(id);
    },
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
    kick() {}, syncLoopUI() {}, resumeFollow() {}, bgRefresh() {},
  };
  state.A.partGains = Array.from({ length: 3 }, () => ({ gain: { value: null, setTargetAtTime(v) { this.value = v; } } }));
  const c = vm.createContext(state);
  vm.runInContext(`
    function viewTime() { return clock; }
    function barCount() { return S.song.bars.length; }
    function barIndexAt(t) { return Math.min(29, Math.floor(t / 2)); }
    function barEnd(i) { return (i + 1) * 2; }
    function play(p, take, opts) { T.playing = true; T.p0 = p; calls.push({ p, take, opts }); }
    function pause() { T.playing = false; calls.push('pause'); }
    function stopNotes() { calls.push('stop'); }
    function exitChord() { CP.on = false; }
  `, c);
  vm.runInContext(section('const modeFactor =', '// amps は'), c);
  vm.runInContext(section('const partLevel =', 'function playNote('), c);
  vm.runInContext(section('const looping =', 'function countParams('), c);
  vm.runInContext(section('function seekTo(', 'function restartIfPlaying('), c);
  vm.runInContext(section('function setLoop(', 'function syncLoopUI('), c);
  return { state, run: code => vm.runInContext(code, c), nodes };
}
let h = harness();
for (let mode = 1; mode <= 4; mode++) {
  h.state.S.mode = mode;
  const settings = JSON.stringify({ parts: h.state.S.pstate, mode, view: h.state.view, showOthers: h.state.S.showOthers });
  const transport = JSON.stringify(h.state.T);
  h.run('setSolo(true)');
  assert.deepEqual(h.state.A.partGains.map(g => g.gain.value), [0, 0.8, 0], 'solo must override own mute and stages ③④');
  assert.equal(JSON.stringify(h.state.T), transport, 'solo must not restart or seek');
  assert.equal(h.state.S.showOthers, true);
  assert.equal(JSON.stringify({ parts: h.state.S.pstate, mode: h.state.S.mode, view: h.state.view, showOthers: h.state.S.showOthers }), settings);
  h.run('setSolo(false)');
  assert.deepEqual(h.state.A.partGains.map(g => g.gain.value), mode === 4 ? [0, 0, 0] : [0.4, 0, 1.2]);
}
h.state.S.pstate[1].muted = false; h.state.S.mode = 2;
h.run('setSolo(true); S.sel = 2; applyGains()');
assert.deepEqual(h.state.A.partGains.map(g => g.gain.value), [0, 0, 1.2]);
h.run('setSolo(false)');
assert.deepEqual(h.state.A.partGains.map(g => g.gain.value), [0.4, 0.8, 0.36]);
h.state.CP.on = true; h.run('setSolo(true)'); assert.equal(h.state.S.solo, false);
console.log('PASS: live solo changes gains only, works in all four stages, restores mute/volume and follows the selected part');

h = harness(); h.state.T.playing = true;
h.run('toggleRepeat()');
assert.equal(h.state.S.loop.scope, 'all'); assert.equal(h.state.T.end, 60); assert.equal(h.state.calls.length, 0);
assert.deepEqual(Array.from(h.run('loopRange()')), [0, 60]);
h.run('setLoop(true)');
assert.equal(h.state.S.loop.scope, 'section');
assert.deepEqual(Array.from(h.run('loopRange()')), [24, 28]);
assert.equal(h.state.calls.at(-1).p, 24);
const before = JSON.stringify(h.state.S.loop);
h.run('toggleRepeat(); toggleRepeat()');
assert.equal(JSON.stringify(h.state.S.loop), before, 'main repeat button must retain the last section');
h.run('setWholeLoop()'); assert.equal(h.state.T.end, 60);
assert.deepEqual(Array.from(h.run('loopRange()')), [0, 60]);
h.state.R = {}; const locked = JSON.stringify(h.state.S.loop);
h.run('toggleRepeat(); setLoop(true); setWholeLoop()'); assert.equal(JSON.stringify(h.state.S.loop), locked);
console.log('PASS: full-song loop keeps playback moving; section selection, remembered range and recording guards work');

h = harness();
h.run('seekRelative(-10)'); assert.equal(h.state.T.pos, 15);
h.run('seekRelative(-100)'); assert.equal(h.state.T.pos, 0);
h.state.T.playing = true; h.state.clock = 22;
h.run('seekRelative(10)'); assert.equal(h.state.calls.at(-1).p, 32); assert.equal(h.state.T.playing, true);
assert.equal(h.state.calls.at(-1).opts, undefined, 'seek must not add a count-in');
h.run('seekTo(60)'); assert.equal(h.state.T.pos, 60); assert.equal(h.state.T.playing, false);
h.state.R = {}; h.run('seekTo(0)'); assert.equal(h.state.T.pos, 60);
h.state.R = null; h.state.S.loop = { on: true, scope: 'section', a: 4, b: 5, t: [8, 12], mark: 'bookmark' };
h.run('seekTo(9)'); assert.equal(h.state.S.loop.on, true);
h.run('seekTo(20)'); assert.equal(h.state.S.loop.on, false); assert.equal(h.state.S.loop.mark, 'bookmark');
console.log('PASS: ±10s uses the playback position, clamps to the song, stops at the end and retains an exited bookmark');
