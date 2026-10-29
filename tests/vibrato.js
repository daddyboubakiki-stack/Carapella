// ビブラートのある声を、アプリと同じ間隔（約60回/秒）で判定したら「合っている」割合は？（中心は正しい音程）
const { makePitchDetector } = require('./extract');
const detect = makePitchDetector();
const sr = 48000, N = 2048, f0 = 220;
for (const ext of [0, 15, 30, 50, 80]) {
  const len = sr * 3, x = new Float32Array(len); let ph = 0;
  for (let i = 0; i < len; i++) { const f = f0 * Math.pow(2, ext / 1200 * Math.sin(2 * Math.PI * 5.5 * i / sr)); ph += 2 * Math.PI * f / sr; x[i] = 0.2 * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)); }
  let n = 0, ok50 = 0, ok25 = 0, hist = [];
  for (let s = 0; s + N < len; s += 800) {
    const r = detect(x.subarray(s, s + N), sr); if (!(r.f > 0)) continue;
    hist.push(1200 * Math.log2(r.f / f0)); if (hist.length > 3) hist.shift();
    const c = hist.length === 3 ? hist.slice().sort((a, b) => a - b)[1] : hist[hist.length - 1]; // アプリと同じ3点中央値
    n++; if (Math.abs(c) <= 50) ok50++; if (Math.abs(c) <= 25) ok25++;
  }
  console.log(`ビブラートの振れ幅 ±${ext}セント: ふつう(±50) ${Math.round(100 * ok50 / n)}%  きびしい(±25) ${Math.round(100 * ok25 / n)}%`);
}
