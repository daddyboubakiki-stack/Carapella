"""mido（Python の別の実装）で MIDI を読み、トラックごとのイベントを JSON で出す。
文字は mido の既定（latin1）で読んだものをバイト列に戻して出す（文字コードに関係なく比べられるように）。
使い方: python3 mido_dump.py a.mid b.mid ...
"""
import json
import sys

import mido


def plain(v):
    if isinstance(v, str):
        return list(v.encode('latin1'))
    if isinstance(v, (tuple, list, bytes, bytearray)):
        return [plain(x) for x in v] if isinstance(v, (tuple, list)) else list(v)
    return v


def dump(path):
    mf = mido.MidiFile(path, clip=False)
    tracks = []
    for tr in mf.tracks:
        tick, evs = 0, []
        for msg in tr:
            tick += msg.time
            d = msg.dict()
            d.pop('time', None)
            evs.append([tick, {k: (v if k == 'type' else plain(v)) for k, v in d.items()}])
        tracks.append(evs)
    return {'type': mf.type, 'tpq': mf.ticks_per_beat, 'tracks': tracks}


if __name__ == '__main__':
    out = []
    for p in sys.argv[1:]:
        try:
            out.append(dump(p))
        except Exception as e:  # mido が読めないファイル（未知のチャンクなど）
            out.append({'error': f'{type(e).__name__}: {e}'})
    print(json.dumps(out))
