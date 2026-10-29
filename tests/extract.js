// index.html から MIDI 解析と音程推定の関数だけを取り出して Node で使えるようにする
const fs = require('fs');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const a = html.indexOf('function decodeText');
const b = html.indexOf('// ===== 共通 =====');
if (a < 0 || b < 0) throw new Error('markers not found');
const src = html.slice(a, b);
module.exports = new Function(src + '\nreturn { parseMidi, makePitchDetector, decodeText };')();
