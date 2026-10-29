// 音程推定（McLeod法）の精度テスト：合成音で、低音〜高音・倍音・ビブラート・雑音・基音が弱い声を試す
require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
const { makePitchDetector } = require('./extract');
const detect = makePitchDetector();
const N = 2048;

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// 声に近い合成音：倍音列 + 簡易フォルマント（母音「あ」っぽく 700/1200Hz を強調）
function voice(f0, sr, opt) {
  const o = Object.assign({ fundGain: 1, vibCents: 0, vibHz: 5.5, noise: 0, harmonics: 20, phase0: 0, amp: 0.2 }, opt);
  const r = rng(Math.round(f0 * 100));
  const x = new Float32Array(N);
  const formant = (f) => 1 / (1 + ((f - 700) / 250) ** 2) + 0.7 / (1 + ((f - 1200) / 300) ** 2) + 0.15;
  let ph = new Array(o.harmonics + 1).fill(0).map(() => r() * 6.28);
  for (let i = 0; i < N; i++) {
    const t = i / sr + o.phase0;
    const f = f0 * Math.pow(2, (o.vibCents / 1200) * Math.sin(2 * Math.PI * o.vibHz * t));
    let v = 0;
    for (let h = 1; h <= o.harmonics; h++) {
      if (h * f > sr / 2) break;
      ph[h] += (2 * Math.PI * h * f) / sr;
      v += (h === 1 ? o.fundGain : 1) * formant(h * f) / h * Math.sin(ph[h]);
    }
    x[i] = v;
  }
  let mx = 0; for (const v of x) mx = Math.max(mx, Math.abs(v));
  for (let i = 0; i < N; i++) x[i] = (x[i] / mx) * o.amp + o.noise * (r() * 2 - 1);
  return x;
}
function sine(f0, sr, amp = 0.2) {
  const x = new Float32Array(N);
  for (let i = 0; i < N; i++) x[i] = amp * Math.sin((2 * Math.PI * f0 * i) / sr);
  return x;
}
const midiOf = (f) => 69 + 12 * Math.log2(f / 440);
const name = (m) => ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][m % 12] + (Math.floor(m / 12) - 1);

function run(label, gen, sr, notes) {
  const rows = [];
  let worst = 0, octErr = 0, none = 0, n = 0;
  for (const m of notes) {
    const f0 = 440 * Math.pow(2, (m - 69) / 12);
    // 同じ音でも位相・ビブラートの位置を変えて5回
    for (let k = 0; k < 5; k++) {
      const x = gen(f0, sr, k);
      const r = detect(x, sr);
      n++;
      if (!(r.f > 0)) { none++; rows.push([name(m), 'なし']); continue; }
      const c = (midiOf(r.f) - m) * 100;
      if (Math.abs(c) > 600) octErr++;
      else worst = Math.max(worst, Math.abs(c));
      if (k === 0) rows.push([name(m), c.toFixed(1)]);
    }
  }
  console.log(`\n[${label}] sr=${sr}  試行${n}  検出なし${none}  オクターブ等の大外れ${octErr}  通常誤差の最大${worst.toFixed(1)}セント`);
  return { label, n, none, octErr, worst };
}

const notes = [];
for (let m = 36; m <= 84; m += 2) notes.push(m); // C2〜C6（バス〜ソプラノ）
const res = [];
for (const sr of [48000, 44100]) {
  res.push(run('正弦波', (f, s) => sine(f, s), sr, notes));
  res.push(run('声っぽい音（倍音+フォルマント）', (f, s, k) => voice(f, s, { phase0: k * 0.013 }), sr, notes));
  res.push(run('ビブラート±50セント', (f, s, k) => voice(f, s, { vibCents: 50, phase0: k * 0.037 }), sr, notes));
  res.push(run('基音が弱い（-20dB、スマホのマイクの男声など）', (f, s, k) => voice(f, s, { fundGain: 0.1, phase0: k * 0.013 }), sr, notes));
  res.push(run('雑音あり（SNR約14dB）', (f, s, k) => voice(f, s, { noise: 0.04, phase0: k * 0.013 }), sr, notes));
  res.push(run('小さい声（振幅0.02）', (f, s, k) => voice(f, s, { amp: 0.02, phase0: k * 0.013 }), sr, notes));
}

// 低音の限界：何Hzまで拾えるか
console.log('\n[低音の限界 48kHz 声っぽい音]');
for (const m of [28, 30, 31, 33, 35, 36, 38, 40]) {
  const f0 = 440 * Math.pow(2, (m - 69) / 12);
  const r = detect(voice(f0, 48000), 48000);
  console.log(name(m), f0.toFixed(1) + 'Hz', r.f > 0 ? ((midiOf(r.f) - m) * 100).toFixed(1) + 'セント' : '検出なし', 'clarity', r.clarity.toFixed(2));
}

// 速度
const x = voice(110, 48000);
const t0 = process.hrtime.bigint();
for (let i = 0; i < 600; i++) detect(x, 48000);
const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 600;
console.log(`\n[速度] 1回あたり ${ms.toFixed(2)} ms（Node / このPC）。60fpsなら1秒に ${(ms * 60).toFixed(0)} ms 使う`);
require('fs').writeFileSync(__dirname + '/out/pitch_result.json', JSON.stringify({ res, msPerCall: ms }, null, 1));
