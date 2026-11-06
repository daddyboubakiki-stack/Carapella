#!/usr/bin/env node
// 手元のMIDIで試すためのコマンド（画面の代わり）。入力ファイルは書き換えない。
//
//   node tools/lyric-fill/cli.js 曲.mid
//       トラックの一覧（番号・名前・歌詞の数・対象外の理由）
//   node tools/lyric-fill/cli.js 曲.mid --from 1 --to 2,3 [--bars 1-16]
//       写す候補と、写せない所の小節番号・理由
//   node tools/lyric-fill/cli.js 曲.mid --from 1 --to 2,3 [--bars 1-16] --out 曲_lyrics-draft.mid
//       上に加えて、歌詞を書き足した .mid を書き出す（確かめに失敗したら書き出さない。既にあるファイルは上書きしない）

import fs from 'node:fs';
import path from 'node:path';
import { readSong, planLyricFill, applyEdits, verifyOutput } from './src/lyric-fill.js';
import { formatTracks, formatPlan, describeError } from './src/report.js';

function parseArgs(argv) {
  const a = { file: null };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--from') a.from = argv[++i];
    else if (k === '--to') a.to = argv[++i];
    else if (k === '--bars') a.bars = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (!a.file && !k.startsWith('--')) a.file = k;
    else throw new Error(`わからない指定：${k}`);
  }
  return a;
}

// トラックは番号か、名前（完全一致）で選ぶ
function pickTrack(song, s) {
  if (/^\d+$/.test(s)) return Number(s);
  const hit = song.tracks.filter((t) => t.name === s);
  if (hit.length !== 1) throw new Error(`トラック「${s}」が${hit.length ? '複数あります' : '見つかりません'}。番号で選んでください`);
  return hit[0].index;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.file) {
    console.log('使い方：node tools/lyric-fill/cli.js 曲.mid [--from 元 --to 先1,先2 [--bars 1-16] [--out 出力.mid]]');
    return 2;
  }
  const song = readSong(fs.readFileSync(a.file));
  console.log(formatTracks(song));
  if (a.from == null && a.to == null) return 0;
  if (a.from == null || a.to == null) throw new Error('--from と --to の両方を指定してください（写す元と先は人が選びます）');
  let bars;
  if (a.bars) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(a.bars);
    if (!m) throw new Error('--bars は「3-8」や「5」の形で指定してください');
    bars = { from: Number(m[1]), to: Number(m[2] || m[1]) };
  }
  const plan = planLyricFill(song, { source: pickTrack(song, a.from), targets: a.to.split(',').map((s) => pickTrack(song, s.trim())), bars });
  console.log('\n' + formatPlan(song, plan));
  if (!a.out) return 0;

  if (path.resolve(a.out) === path.resolve(a.file)) throw new Error('入力と同じファイルには書き出しません');
  if (fs.existsSync(a.out)) throw new Error(`${a.out} は既にあります（上書きしません）`);
  const output = applyEdits(song, plan.edits);
  const check = verifyOutput(song, output, plan.edits);
  if (!check.ok) {
    console.error('\n書き出したファイルの確認に失敗したので、保存しません：\n  ' + check.problems.join('\n  '));
    return 1;
  }
  fs.writeFileSync(a.out, output, { flag: 'wx' });
  console.log(`\n書き出しました：${a.out}（${output.length} バイト。確認：変えないトラックはバイト単位で同じ、変えたトラックは書き足した歌詞を除いて元と同じ）`);
  return 0;
}

try {
  process.exitCode = main();
} catch (e) {
  console.error('エラー：' + (e.code ? describeError(e) : e.message));
  process.exitCode = 1;
}
