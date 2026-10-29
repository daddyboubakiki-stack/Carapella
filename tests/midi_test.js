// MIDI 読み込みのテスト：期待値と比べる
require('fs').mkdirSync(require('path').join(__dirname, 'out'), { recursive: true });
const fs = require('fs');
const path = require('path');
const { parseMidi } = require('./extract');
const dir = path.join(__dirname, 'midi');
const expect = JSON.parse(fs.readFileSync(path.join(dir, 'expect.json'), 'utf8'));
const results = {};
for (const f of fs.readdirSync(dir).filter((x) => !x.endsWith('.json')).sort()) {
  let r;
  try {
    const s = parseMidi(fs.readFileSync(path.join(dir, f)));
    r = {
      title: s.title, bpm: s.bpm, duration: +s.duration.toFixed(3), bars: s.bars.filter((b) => b.t < s.duration - 0.01).length, // 曲の終わりちょうどの小節線は数えない（index.html の barCount と同じ）
      parts: s.parts.map((p) => ({ name: p.name, notes: p.notes.length, lyrics: p.lyrics.length, first: p.notes[0] && [+p.notes[0].s.toFixed(3), p.notes[0].m], last: p.notes.length && +p.notes[p.notes.length - 1].e.toFixed(3) })),
      lyricsSample: s.parts.flatMap((p) => p.lyrics.slice(0, 4).map((l) => l.text)),
    };
  } catch (e) { r = { error: e.message }; }
  results[f] = r;
  const ex = expect[f];
  const checks = [];
  if (ex && !r.error) {
    if (Array.isArray(ex.parts)) checks.push(['パート名', JSON.stringify(r.parts.map((p) => p.name)) === JSON.stringify(ex.parts)]);
    else if (ex.parts != null) checks.push(['パート数', r.parts.length === ex.parts]);
    if (ex.notes != null) checks.push(['音符数', r.parts.every((p) => p.notes === ex.notes)]);
    if (ex.duration != null) checks.push(['長さ', Math.abs(r.duration - ex.duration) < 0.01]);
    if (ex.title != null) checks.push(['曲名', r.title === ex.title]);
    if (ex.bars != null) checks.push(['小節数', r.bars === ex.bars]);
    if (ex.lyrics_part0 != null) checks.push(['歌詞', r.parts[0].lyrics === ex.lyrics_part0]);
    if (ex.lyrics_any != null) checks.push(['歌詞（KAR）', r.parts.some((p) => p.lyrics === ex.lyrics_any)]);
    if (ex.bpm != null) checks.push(['テンポ', r.bpm === ex.bpm]);
  }
  console.log('\n■', f, r.error ? '→ エラー: ' + r.error : '');
  if (!r.error) console.log('  ', JSON.stringify({ title: r.title, bpm: r.bpm, duration: r.duration, bars: r.bars, lyrics: r.lyricsSample }), '\n  ', r.parts.map((p) => `${p.name}(${p.notes}音,歌詞${p.lyrics})`).join(' / '));
  for (const [k, ok] of checks) console.log('   ', ok ? 'OK ' : 'NG ', k);
}
fs.writeFileSync(path.join(__dirname, 'out', 'midi_result.json'), JSON.stringify(results, null, 1));
