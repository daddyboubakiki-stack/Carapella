// mido（Python で書かれた、まったく別の MIDI 読み込み）で、元と書き出しを読み比べる。
// mido がない環境では省略する（pip install mido で入る。tests/make_midis.py と同じもの）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fillLyrics } from '../src/lyric-fill.js';
import { carapellaMidi, rhythmFixture, runningFixture, meterFixture } from './helpers/fixtures.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const hasMido = spawnSync('python3', ['-c', 'import mido'], { encoding: 'utf8' }).status === 0;

function midoDump(...byteArrays) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyric-fill-mido-'));
  try {
    const files = byteArrays.map((b, i) => { const f = path.join(dir, `${i}.mid`); fs.writeFileSync(f, b); return f; });
    const r = spawnSync('python3', [path.join(here, 'helpers', 'mido_dump.py'), ...files], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const cases = [
  { name: 'satb_sjis.mid', bytes: carapellaMidi('satb_sjis.mid'), opts: { source: 1, targets: [2, 3, 4] } },
  { name: '別リズム・既存歌詞混在', bytes: rhythmFixture(), opts: { source: 1, targets: [2, 3] } },
  { name: 'running status・いろいろなイベント（未知のチャンクと End of Track の後ろの1バイトは外す）', bytes: runningFixture({ forMido: true }), opts: { source: 1, targets: [2] } },
  { name: '拍子・テンポ変化', bytes: meterFixture(), opts: { source: 1, targets: [2], bars: { from: 3, to: 4 } } },
];

for (const c of cases) {
  test(`mido で読み比べる：${c.name}`, { skip: hasMido ? false : 'mido がないので省略' }, () => {
    const { plan, output } = fillLyrics(c.bytes, c.opts);
    const [a, b] = midoDump(c.bytes, output);
    assert.equal(a.error, undefined, 'mido が元のファイルを読めること');
    assert.equal(b.error, undefined, 'mido が書き出したファイルを読めること');
    assert.equal(b.type, a.type);
    assert.equal(b.tpq, a.tpq);
    assert.equal(b.tracks.length, a.tracks.length);
    a.tracks.forEach((ta, i) => {
      const added = plan.edits.filter((e) => e.track === i);
      if (!added.length) { assert.deepEqual(b.tracks[i], ta, `track ${i}`); return; }
      const want = new Set(added.map((e) => `${e.tick}|${[...e.bytes].join(',')}`));
      const isAdded = ([t, d]) => d.type === 'lyrics' && want.has(`${t}|${d.text.join(',')}`);
      // 書き足した歌詞を除くと元と同じ（tick・種類・中身。running status は mido の上では見えない）
      assert.deepEqual(b.tracks[i].filter((x) => !isAdded(x)), ta, `track ${i}`);
      assert.equal(b.tracks[i].filter(isAdded).length, added.length);
    });
  });
}

test('記録：mido は未知のチャンク・End of Track の後ろのバイトがあると読めない（このツールとカラモニは読み、そのまま残す）', { skip: hasMido ? false : 'mido がないので省略' }, () => {
  const [a] = midoDump(runningFixture());
  assert.ok(a.error, 'mido は読めない想定');
});
