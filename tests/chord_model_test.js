// 実際の音声関数に記録用のAudioContextを渡し、単音の終了境界・最後の和音・取消を検証する。
// スピーカー／イヤホンの聞こえ方そのものは、実機で別に確かめる。
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const section = (a, b) => {
  const start = html.indexOf(a), end = html.indexOf(b, start);
  assert(start >= 0 && end > start, a);
  return html.slice(start, end);
};
const hz = m => 440 * 2 ** ((m - 69) / 12);
const close = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function harness() {
  const oscillators = [], gains = [], messages = [], timers = new Map();
  let timerId = 0;
  const param = () => {
    const p = { value: 0, events: [] };
    for (const name of ['setValueAtTime', 'linearRampToValueAtTime', 'setTargetAtTime', 'cancelAndHoldAtTime', 'cancelScheduledValues']) {
      p[name] = (...args) => p.events.push([name, ...args]);
    }
    return p;
  };
  const ctx = {
    currentTime: 0, state: 'running', resume: async () => { ctx.state = 'running'; },
    createGain() { const g = { gain: param(), connect(dest) { this.dest = dest; }, disconnect() {} }; gains.push(g); return g; },
    createOscillator() {
      const o = { frequency: { value: 0 }, stops: [], setPeriodicWave(w) { this.wave = w; }, connect(g) { this.g = g; }, start(t) { this.start = t; }, stop(t) { this.stops.push(t); this.end = t; } };
      oscillators.push(o); return o;
    },
  };
  const A = { ctx, guide: {}, active: new Set(), waves: { soft: {}, clear: {} } };
  const S = { song: {}, transpose: 0, pstate: [0, 1, 2, 3, 4, 5].map(i => ({ vol: 0.7, muted: true, tone: i === 1 ? 'clear' : 'soft' })) };
  const T = { playing: false }, CP = { on: false }, document = { visibilityState: 'visible' };
  const chord = [{ m: 64, part: 0 }, { m: 48, part: 2 }, { m: 60, part: 1 }];
  const pick = { part: 1, note: { m: 65 }, t: 9.9 };
  const TONES = { soft: { gain: 1 }, clear: { gain: 0.9 } };
  const src = 'let previewRequest = 0;\n' + section('function playNote(', 'function playClick(')
    + section('function stopNotes()', '// ===== 再生') + section('const MODEL_CHORD_HOLD', 'function setPick');
  const api = new Function('A', 'S', 'T', 'CP', 'R', 'pick', 'document', 'TONES', 'ensureCtx', 'curTr', 'chordAt', 'say', 'setTimeout', 'clearTimeout', src + '\nreturn { playPickedNote, playChord, playChordModel, scheduleChordModel, stopNotes };')(
    A, S, T, CP, null, pick, document, TONES, () => {}, () => S.transpose, () => chord, m => messages.push(m),
    (fn, ms) => { const id = ++timerId; timers.set(id, { fn, ms }); return id; }, id => timers.delete(id)
  );
  return { ...api, A, S, T, CP, document, chord, ctx, oscillators, gains, timers, messages };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

(async () => {
  for (const step of [1, 3]) {
    const h = harness(), original = JSON.stringify(h.chord);
    await h.playChordModel(9.9, step);
    assert.equal(JSON.stringify(h.chord), original, 'sorting must not mutate the selected chord');
    assert.equal(h.oscillators.length, 6);
    const solo = h.oscillators.slice(0, 3), full = h.oscillators.slice(3);
    for (let i = 0; i < 3; i++) {
      close(solo[i].frequency.value, hz([48, 60, 64][i]));
      close(solo[i].start, 0.03 + i * step);
      close(solo[i].end, 0.03 + (i + 1) * step);
      assert(solo[i].g.gain.events.some(e => e[0] === 'setValueAtTime' && e[1] === 0 && Math.abs(e[2] - solo[i].end) < 1e-8), 'solo gain reaches zero at its end');
      if (i < 2) close(solo[i].end, solo[i + 1].start);
      close(full[i].start, 0.03 + 3 * step);
      close(full[i].end, 0.03 + 3 * step + 3);
    }
    close(solo[2].end, full[0].start);
    assert.equal(solo[1].wave, h.A.waves.clear, 'each part keeps its tone');
    console.log(`PASS: ${step}s model: low-to-high solos stop exactly at the next onset; final chord lasts 3s`);
  }

  let h = harness();
  const duration = h.scheduleChordModel([48, 52, 55, 60, 64, 67].map((m, part) => ({ m, part })), 0.03, 3);
  assert.equal(duration, 21);
  assert.equal(h.oscillators.length, 12);
  close(h.oscillators[6].start, 18.03); close(h.oscillators[6].end, 21.03);
  assert.equal(h.scheduleChordModel([], 0, 3), 0);
  console.log('PASS: six parts at 3s take 18s + final 3s; there is no 10s limit or compressed interval');

  h = harness(); h.S.transpose = 2;
  await h.playPickedNote();
  assert.equal(h.oscillators.length, 1); close(h.oscillators[0].frequency.value, hz(67));
  assert.equal(h.oscillators[0].wave, h.A.waves.clear); close(h.oscillators[0].end - h.oscillators[0].start, 1);
  console.log('PASS: this-note preview uses only the picked part, with its tone and transposition');

  h = harness(); await h.playChord(9.9);
  assert.equal(h.oscillators.length, 3);
  assert(h.oscillators.every(o => Math.abs(o.start - 0.03) < 1e-8 && Math.abs(o.end - 3.03) < 1e-8));
  console.log('PASS: chord preview starts all parts together for 3s, including muted parts');

  for (const delay of [0.3, 4]) {
    h = harness(); await h.playChordModel(9.9, 3);
    const old = h.oscillators.slice(); h.ctx.currentTime = delay;
    await h.playChordModel(9.9, 1);
    assert(old.every(o => o.end <= delay + 0.1 + 1e-8), 'old sounding and future nodes must be cancelled');
    const next = h.oscillators.slice(old.length);
    assert.equal(next.length, 6); close(next[0].start, delay + 0.03); close(next[3].end, delay + 6.03);
  }
  console.log('PASS: early and late replacement cancel both active solos and future solos/final chords');

  for (const cancel of ['stop', 'normal playback', 'hidden', 'newer preview']) {
    h = harness(); const d = deferred(); h.ctx.state = 'suspended';
    h.ctx.resume = async () => { await d.promise; h.ctx.state = 'running'; };
    const old = h.playChordModel(9.9, 3);
    if (cancel === 'hidden') h.document.visibilityState = 'hidden';
    else if (cancel === 'normal playback') { h.stopNotes(); h.T.playing = true; }
    else if (cancel === 'newer preview') { h.ctx.state = 'running'; await h.playPickedNote(); }
    else h.stopNotes();
    const before = h.oscillators.length; d.resolve(); await old;
    assert.equal(h.oscillators.length, before, cancel + ' must invalidate an older audio-resume request');
  }
  console.log('PASS: late audio resume cannot restart a stopped, hidden or replaced preview');

  h = harness(); h.ctx.state = 'suspended'; h.ctx.resume = async () => { throw Error('blocked'); };
  await h.playChordModel(9.9, 1);
  assert.equal(h.oscillators.length, 0); assert.equal(h.messages.length, 1);
  console.log('PASS: failed audio resume reports failure without scheduling sound');
})().catch(e => { console.error(e); process.exitCode = 1; });
