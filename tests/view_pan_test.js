// 表示の移動と音楽の時計を分離する回帰テスト。ブラウザ・音声デバイス不要。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('node:assert/strict');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const section = (from, to) => {
  const start = html.indexOf(from), end = html.indexOf(to, start);
  assert(start >= 0 && end > start, 'source markers must exist');
  return html.slice(start, end);
};
const nodes = Object.fromEntries(['plotStatus', 'followBtn', 'pitchViewReset', 'rollWrap'].map(id => [id, { dataset: {} }]));
const ctx = vm.createContext({
  Math, clock: 25, drag: null,
  view: { w: 390, h: 300, follow: true, time: 0, pitchOffset: 0, wheelPitch: 0 },
  S: { song: { duration: 180, parts: [{ min: 48, max: 60 }] }, sel: 0, zoom: 100 },
  T: { playing: true, pos: 25, p0: 25, t0: 10 },
  $: id => nodes[id], clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  kick: () => {}, curTr: () => 0, zoomTouched: true,
  GUT: Number(html.match(/const GUT = (\d+)/)[1]),
  matchMedia: () => ({ matches: true }),
});
vm.runInContext('function viewTime() { return clock; }', ctx);
vm.runInContext(section('function displayTime()', '\nlet C ='), ctx);
vm.runInContext(section('function baseViewRange()', '\nfunction marker('), ctx);
vm.runInContext(section('function pixelsPerSecond()', '// なぞった位置'), ctx);
vm.runInContext(section('function beginPan(', '// しおりモードの座標変換'), ctx);
const run = code => vm.runInContext(code, ctx);
const transport = JSON.stringify(ctx.T);

run('beginPan(100, 100, 1); clock = 26; movePan(102, 180);');
assert.equal(ctx.view.follow, true, 'vertical drag must keep following');
assert.equal(run('displayTime()'), 26);
assert.notEqual(ctx.view.pitchOffset, 0, 'vertical drag must move the pitch range');
run('clock = 27');
assert.equal(run('displayTime()'), 27, 'horizontal position must keep advancing during vertical drag');
console.log('PASS: vertical movement keeps live horizontal follow, including small horizontal jitter');

run('beginPan(100, 100, 2); movePan(40, 103);');
assert.equal(ctx.view.follow, false, 'horizontal drag must suspend following');
const frozen = run('displayTime()');
assert(Math.abs(frozen - 27.6) < 1e-9);
run('clock = 32');
assert.equal(run('displayTime()'), frozen, 'manual display must stay still as audio advances');
assert.equal(JSON.stringify(ctx.T), transport, 'view gestures must not change playback or seek state');
console.log('PASS: horizontal movement freezes only the display; playback state is untouched');

run('beginPan(100, 100, 3); movePan(101, 150);');
assert.equal(run('displayTime()'), frozen, 'vertical movement must not unexpectedly resume manual follow');
const pitch = ctx.view.pitchOffset;
run('resumeFollow()');
assert.equal(ctx.view.follow, true);
assert.equal(run('displayTime()'), 32);
assert.equal(ctx.view.pitchOffset, pitch, 'return-to-current must retain the chosen pitch range');
console.log('PASS: return-to-current resumes follow without resetting the pitch range');

run('beginPan(100, 100, 4); movePan(103, 103);');
assert.equal(ctx.view.follow, true, 'a tap or tiny movement must not suspend follow');
run('beginPan(100, 100, 5); movePan(140, 140);');
assert.equal(ctx.view.follow, false, 'intentional diagonal movement includes horizontal pan');
console.log('PASS: movement threshold and diagonal gestures');

run('view.time = 80; view.follow = false; clock = 100;');
const centre = 56 + (390 - 56) * 0.3;
assert.equal(run(`timeAtX(${centre})`), 80, 'bookmark coordinates must use display time, not audio time');
assert(Math.abs(run(`timeAtX(${centre + 100})`) - 81) < 1e-9);
run('panToTime(-100)'); assert.equal(ctx.view.time, 0);
run('panToTime(1000)'); assert.equal(ctx.view.time, 180);
run('shiftPitch(10000)'); assert(run('viewRange()[1]') <= 139);
run('shiftPitch(-10000)'); assert(run('viewRange()[0]') >= -12);
assert.equal(JSON.stringify(ctx.T), transport);
console.log('PASS: shifted bookmark mapping and pan bounds');
