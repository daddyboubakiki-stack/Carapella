// 低レベルの読み書き：何も変えなければ、元と同じバイト列に戻ること
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readSmf, encodeTrack, writeSmf, SmfError } from '../src/smf.js';
import { carapellaMidi, CARAPELLA_MIDI_DIR, rhythmFixture, runningFixture, meterFixture, largeFixture } from './helpers/fixtures.js';
import { rmid } from './helpers/build.js';

const built = { rhythm: rhythmFixture(), running: runningFixture(), meter: meterFixture(), large: largeFixture() };
const carapellaFiles = fs.readdirSync(CARAPELLA_MIDI_DIR).filter((f) => !f.endsWith('.json'));

test('何も変えずに書くと、元と同じバイト列になる（Carapella のテスト用MIDI と、組み立てたMIDI）', () => {
  const inputs = { ...built };
  for (const f of carapellaFiles) {
    try { readSmf(carapellaMidi(f)); inputs[f] = carapellaMidi(f); } catch (e) { /* 壊れたファイルは別のテスト */ }
  }
  assert.ok(Object.keys(inputs).length >= 9);
  for (const [name, bytes] of Object.entries(inputs)) {
    const smf = readSmf(bytes);
    const expectSmf = name === 'wrapped.rmi' ? smf.bytes : bytes; // RIFF の包みは外れる
    assert.deepEqual(writeSmf(smf, new Map()), expectSmf, name);
    // トラックを1本ずつ組み直しても（挿入なし）、元のチャンクと同じ
    for (const c of smf.chunks.filter((x) => x.track)) assert.deepEqual(encodeTrack(c.track, new Map()), c.raw, `${name} track ${c.track.index}`);
  }
});

test('running status・冗長な delta・End of Track の後ろのバイトを、読んだ通りに覚えている', () => {
  const smf = readSmf(built.running);
  const harmony = smf.tracks[2];
  assert.ok(harmony.events.filter((e) => e.running).length >= 8, 'running status を使うイベントがある');
  assert.deepEqual([...harmony.tail], [0x00]);
  assert.ok(harmony.events.some((e) => e.delta.length === 2 && e.delta[0] === 0x80 && e.delta[1] === 0x00));
  assert.deepEqual(smf.chunks.map((c) => c.id), ['MThd', 'MTrk', 'XFIH', 'MTrk', 'MTrk']);
});

test('RIFF(RMID) で包んだ format 1 は、包みを外して読む', () => {
  const plain = carapellaMidi('satb_sjis.mid');
  const smf = readSmf(rmid(plain));
  assert.deepEqual(smf.bytes, plain);
  assert.deepEqual(writeSmf(smf, new Map()), plain);
});

test('壊れたファイルは読まずにエラー', () => {
  assert.throws(() => readSmf(carapellaMidi('not_midi.mid')), (e) => e instanceof SmfError && e.code === 'not_midi');
  assert.throws(() => readSmf(carapellaMidi('truncated.mid')), (e) => e.code === 'truncated'); // 最後のトラックがない
  const satb = carapellaMidi('satb_sjis.mid');
  for (const cut of [20, 100, 300, satb.length - 1]) assert.throws(() => readSmf(satb.subarray(0, cut)), (e) => e.code === 'truncated', `cut ${cut}`);
});
