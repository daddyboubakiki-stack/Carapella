// 手元で試すためのコマンド：一覧・候補・書き出し、入力を書き換えない・上書きしない
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readSong, verifyOutput, planLyricFill } from '../src/lyric-fill.js';
import { CARAPELLA_MIDI_DIR } from './helpers/fixtures.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.js');
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
const satb = path.join(CARAPELLA_MIDI_DIR, 'satb_sjis.mid');

test('一覧：トラック番号・名前・対象外の理由', () => {
  const r = run(satb);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[1\] ソプラノ（ch1、音 12、歌詞 12）/);
  assert.match(r.stdout, /\[5\] ボイパ … 対象外：打楽器（ch10）だけ/);
});

test('候補：元と先の両方を人が指定しないと進まない', () => {
  const r = run(satb, '--to', '2');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--from と --to の両方/);
  const ok = run(satb, '--from', 'ソプラノ', '--to', '2,テナー', '--bars', '2-3');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /範囲：2〜3小節/);
  assert.match(ok.stdout, /■ \[3\] テナー：書き足す歌詞 6/);
});

test('書き出し：確かめてから保存し、入力は変えず、既にあるファイルは上書きしない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-fill-cli-'));
  try {
    const out = path.join(dir, 'satb_lyrics-draft.mid');
    const before = fs.readFileSync(satb);
    const r = run(satb, '--from', '1', '--to', '2,3,4', '--out', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /書き出しました/);
    assert.deepEqual(fs.readFileSync(satb), before);
    const song = readSong(before);
    const plan = planLyricFill(song, { source: 1, targets: [2, 3, 4] });
    assert.equal(verifyOutput(song, new Uint8Array(fs.readFileSync(out)), plan.edits).ok, true);
    // 2回目は上書きしない
    const again = run(satb, '--from', '1', '--to', '2', '--out', out);
    assert.equal(again.status, 1);
    assert.match(again.stderr, /上書きしません/);
    // 入力と同じファイルには書かない
    const same = run(out, '--from', '1', '--to', '2', '--out', out);
    assert.equal(same.status, 1);
    assert.match(same.stderr, /入力と同じファイル/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('対象外のファイル：理由を出して止まる', () => {
  const r = run(path.join(CARAPELLA_MIDI_DIR, 'format0_4ch.mid'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /format 0/);
});
