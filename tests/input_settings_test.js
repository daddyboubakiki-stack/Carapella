// 感度3段階の実効性・周期性チェックの維持・遅れ補正の保存範囲を確認。
const fs = require('fs');
const path = require('path');
const assert = require('node:assert/strict');
const { makePitchDetector } = require('./extract');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('const SENSITIVITY =');
const end = html.indexOf('// ===== 設定の記憶', start);
assert(start >= 0 && end > start);
const { SENSITIVITY, MAX_LATENCY_MS, validLatency, readSensitivity } = new Function(
  html.slice(start, end) + '\nreturn { SENSITIVITY, MAX_LATENCY_MS, validLatency, readSensitivity };'
)();
const sampleRate = 48000;
const sine = amplitude => Float32Array.from({ length: 2048 }, (_, i) => amplitude * Math.sin(2 * Math.PI * 220 * i / sampleRate));
const detect = makePitchDetector();
const detections = amplitude => Object.values(SENSITIVITY).map(minRms => detect(sine(amplitude), sampleRate, { minRms }).f > 0);
assert.deepEqual(detections(0.0085), [false, false, true]);
assert.deepEqual(detections(0.017), [false, true, true]);
assert.deepEqual(detections(0.034), [true, true, true]);
assert.equal(SENSITIVITY.medium, 0.008, 'medium must retain the previous minimum level');
assert(Math.abs(detect(sine(0.0085), sampleRate, { minRms: SENSITIVITY.high }).f - 220) < 1);
console.log('PASS: low / medium / high accept progressively quieter pitched signals');

let seed = 42;
const noise = Float32Array.from({ length: 2048 }, () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return ((seed / 2 ** 32) * 2 - 1) * 0.02;
});
assert.equal(detect(noise, sampleRate, { minRms: SENSITIVITY.high }).f, 0);
assert.equal(detect(new Float32Array(2048), sampleRate, { minRms: SENSITIVITY.high }).f, 0);
console.log('PASS: high sensitivity still rejects silence and the tested aperiodic noise');

assert.equal(MAX_LATENCY_MS, 1000);
assert.equal(Number(html.match(/id="lat"[^>]*max="(\d+)"/)[1]), MAX_LATENCY_MS);
for (const n of [0, 80, 400, 650, 1000]) assert(validLatency(n));
for (const n of [-1, 1001, Infinity, NaN, null, false, '650']) assert(!validLatency(n));
for (const s of ['low', 'medium', 'high']) assert.equal(readSensitivity(s), s);
for (const s of [undefined, null, 'unknown', '__proto__']) assert.equal(readSensitivity(s), 'medium');
console.log('PASS: 0–1000 ms are valid; old 400 ms settings and default medium remain valid');
