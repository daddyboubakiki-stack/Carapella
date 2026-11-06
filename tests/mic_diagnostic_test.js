// マイク診断の状態判定と、画面・音声処理への接続を確認する。
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('function micDiagnosticHint(d) {');
const b = html.indexOf('function micDiagnosticSnapshot() {', a);
assert(a >= 0 && b > a, 'diagnostic helper is available');
const hint = new Function(html.slice(a, b) + '\nreturn micDiagnosticHint;')();
const data = { micOn: true, trackState: 'live', muted: false, contextState: 'running',
  samples: 30, rms: 0.03, freq: 220 };
assert.match(hint({ ...data, micOn: false }), /OFF/);
assert.match(hint({ ...data, trackState: 'ended' }), /動いていません/);
assert.match(hint({ ...data, muted: true }), /ミュート/);
assert.match(hint({ ...data, contextState: 'suspended' }), /停止中/);
assert.match(hint({ ...data, samples: 0 }), /解析を開始/);
assert.match(hint({ ...data, rms: 0 }), /ほぼゼロ/);
assert.match(hint({ ...data, freq: 0 }), /音程を検出できていません/);
assert.match(hint(data), /動いています/);
for (const id of ['micDiagBtn', 'micDiagDialog', 'micDiagClose', 'micDiagDone', 'micDiagMicBtn', 'micDiagClarity', 'micDiagMic', 'micDiagTrack', 'micDiagAudio',
  'micDiagSamples', 'micDiagRms', 'micDiagPitch', 'micDiagAdvice', 'micDiagMeter', 'micDiagCopyBtn']) {
  assert(html.includes('id="' + id + '"'), 'missing diagnostic field: ' + id);
}
assert.match(html, /micDiag\.rms = r\.rms/);
assert.match(html, /micDiag\.freq = r\.f/);
assert.match(html, /updateMicDiagnostic\(\)/);
// 「診断」ボタンは操作ボタン2段目の「自分だけ」と「？」の間に置く
const aux = html.slice(html.indexOf('<div class="row aux control-row"'), html.indexOf('</div>', html.indexOf('<div class="row aux control-row"')));
const order = ['micBtn', 'recBtn', 'pitchBtn', 'soloBtn', 'micDiagBtn', 'transportHelpBtn'].map((id) => aux.indexOf('id="' + id + '"'));
assert(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1])), 'diagnostic button sits between solo and help: ' + order);
assert(!html.includes('id="micDiagnostic"'), 'old diagnostic panel in settings is removed');
assert.match(html, /navigator\.clipboard\.writeText\(report\)/);
console.log('PASS: microphone diagnostics distinguish no input, paused context and failed pitch detection');
