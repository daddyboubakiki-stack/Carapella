"""テスト用MIDIを作る。期待値（音符数・時刻）も JSON に書き出す。"""
import json, os, mido
from mido import MidiFile, MidiTrack, Message, MetaMessage

OUT = os.path.join(os.path.dirname(__file__), 'midi')
os.makedirs(OUT, exist_ok=True)
expect = {}

def sj(s):  # Shift_JIS のバイト列を mido（latin1で書く）に渡すための変換
    return s.encode('shift_jis').decode('latin1')
def u8(s):
    return s.encode('utf-8').decode('latin1')

def add_notes(tr, ch, notes, tpq, lyrics=None):
    """notes: [(start_beat, dur_beat, midi)] を delta time で書く（重なりなしの単旋律）"""
    evs = []
    for i, (s, d, m) in enumerate(notes):
        evs.append((int(s * tpq), 1, Message('note_on', channel=ch, note=m, velocity=90)))
        evs.append((int((s + d) * tpq), 0, Message('note_off', channel=ch, note=m, velocity=0)))
        if lyrics:
            evs.append((int(s * tpq), 0, MetaMessage('lyrics', text=lyrics[i])))
    evs.sort(key=lambda e: (e[0], e[1]))
    now = 0
    for t, _, msg in evs:
        msg.time = t - now
        now = t
        tr.append(msg)
    tr.append(MetaMessage('end_of_track', time=0))

# ---- 1) SATB + ボイパ、Shift_JIS のトラック名と歌詞、テンポ変化、3/4拍子 ----
tpq = 480
mf = MidiFile(type=1, ticks_per_beat=tpq)
t0 = MidiTrack(); mf.tracks.append(t0)
t0.append(MetaMessage('track_name', name=sj('テスト合唱曲')))
t0.append(MetaMessage('time_signature', numerator=3, denominator=4, time=0))
t0.append(MetaMessage('set_tempo', tempo=mido.bpm2tempo(120), time=0))
t0.append(MetaMessage('set_tempo', tempo=mido.bpm2tempo(90), time=6 * tpq))  # 3小節目（6拍目）から ♩=90
t0.append(MetaMessage('end_of_track', time=0))
mel = [(i, 1, 60 + [0, 2, 4, 5, 7, 5, 4, 2, 0, 2, 4, 0][i]) for i in range(12)]
parts = [('ソプラノ', 0, 12, ['あ', 'い', 'う', 'え', 'お', 'か', 'き', 'く', 'け', 'こ', 'さ', 'し']),
         ('アルト', 1, 7, None), ('テナー', 2, 0, None), ('ベース', 3, -12, None)]
for nm, ch, sh, ly in parts:
    tr = MidiTrack(); mf.tracks.append(tr)
    tr.append(MetaMessage('track_name', name=sj(nm)))
    tr.append(Message('program_change', channel=ch, program=52))
    add_notes(tr, ch, [(s, d, m + sh) for s, d, m in mel], tpq, [sj(x) for x in ly] if ly else None)
vp = MidiTrack(); mf.tracks.append(vp)
vp.append(MetaMessage('track_name', name=sj('ボイパ')))
add_notes(vp, 9, [(i, 0.5, 36 if i % 2 == 0 else 38) for i in range(12)], tpq)
mf.save(os.path.join(OUT, 'satb_sjis.mid'))
# 期待：6拍目まで 0.5秒/拍、以降 0.6667秒/拍 → 12拍で 3.0 + 6*0.6667 = 7.0秒
expect['satb_sjis.mid'] = {'parts': ['ソプラノ', 'アルト', 'テナー', 'ベース'], 'notes': 12, 'duration': 7.0,
                           'title': 'テスト合唱曲', 'bars': 4, 'lyrics_part0': 12, 'bpm': 120}

# ---- 2) format 0、1トラックに4チャンネル（running status あり） ----
mf = MidiFile(type=0, ticks_per_beat=96)
tr = MidiTrack(); mf.tracks.append(tr)
tr.append(MetaMessage('track_name', name=u8('ひとつのトラック')))
tr.append(MetaMessage('set_tempo', tempo=mido.bpm2tempo(100)))
evs = []
for ch, base in enumerate([72, 67, 64, 48]):
    for i in range(8):
        evs.append((i * 96, 1, Message('note_on', channel=ch, note=base + (i % 3), velocity=80)))
        evs.append((i * 96 + 90, 0, Message('note_on', channel=ch, note=base + (i % 3), velocity=0)))  # velocity0 = note off
evs.sort(key=lambda e: (e[0], e[1], e[2].channel))
now = 0
for t, _, m in evs:
    m.time = t - now; now = t; tr.append(m)
tr.append(MetaMessage('end_of_track'))
mf.save(os.path.join(OUT, 'format0_4ch.mid'))
expect['format0_4ch.mid'] = {'parts': 4, 'notes': 8, 'duration': (7 * 96 + 90) / 96 * 0.6}

# ---- 3) カラオケ形式 .kar（歌詞が meta 0x01 テキストイベント） ----
mf = MidiFile(type=1, ticks_per_beat=tpq)
t0 = MidiTrack(); mf.tracks.append(t0)
t0.append(MetaMessage('text', text='@KMIDI KARAOKE FILE'))
t0.append(MetaMessage('set_tempo', tempo=mido.bpm2tempo(120)))
t0.append(MetaMessage('end_of_track'))
words = MidiTrack(); mf.tracks.append(words)
words.append(MetaMessage('track_name', name='Words'))
words.append(MetaMessage('text', text='@TTest Song'))
syl = ['/Ka', 'e', 'ru', '\\no', 'u', 'ta']
for i, s in enumerate(syl):
    words.append(MetaMessage('text', text=s, time=(tpq if i else 0)))
words.append(MetaMessage('end_of_track'))
mel_tr = MidiTrack(); mf.tracks.append(mel_tr)
mel_tr.append(MetaMessage('track_name', name='Melody'))
add_notes(mel_tr, 0, [(i, 1, [60, 62, 64, 65, 64, 62][i]) for i in range(6)], tpq)
mf.save(os.path.join(OUT, 'karaoke.kar'))
expect['karaoke.kar'] = {'parts': 1, 'notes': 6, 'lyrics_any': 6}

# ---- 4) 1トラックに和音（ピアノ譜のように1パートに複数声部） ----
mf = MidiFile(type=1, ticks_per_beat=tpq)
t0 = MidiTrack(); mf.tracks.append(t0); t0.append(MetaMessage('end_of_track'))
tr = MidiTrack(); mf.tracks.append(tr)
tr.append(MetaMessage('track_name', name='Chorus (S+A)'))
evs = []
for i in range(4):
    for m in (72 - i, 67 - i):
        evs.append((i * tpq, 1, Message('note_on', channel=0, note=m, velocity=90)))
        evs.append(((i + 1) * tpq, 0, Message('note_off', channel=0, note=m)))
evs.sort(key=lambda e: (e[0], e[1]))
now = 0
for t, _, m in evs:
    m.time = t - now; now = t; tr.append(m)
tr.append(MetaMessage('end_of_track'))
mf.save(os.path.join(OUT, 'chords_one_track.mid'))
expect['chords_one_track.mid'] = {'parts': 1, 'notes': 8}

# ---- 5) 壊れたファイル・MIDIでないファイル ----
with open(os.path.join(OUT, 'not_midi.mid'), 'wb') as f:
    f.write(b'This is not a MIDI file at all' * 10)
with open(os.path.join(OUT, 'drums_only.mid'), 'wb') as f:
    m2 = MidiFile(type=1, ticks_per_beat=tpq)
    t = MidiTrack(); m2.tracks.append(t)
    add_notes(t, 9, [(i, 0.5, 36) for i in range(4)], tpq)
    m2.save(file=f)
# 途中で切れたファイル
raw = open(os.path.join(OUT, 'satb_sjis.mid'), 'rb').read()
open(os.path.join(OUT, 'truncated.mid'), 'wb').write(raw[: len(raw) * 2 // 3])

# ---- 6) RIFF/RMID で包んだファイル ----
smf = open(os.path.join(OUT, 'format0_4ch.mid'), 'rb').read()
import struct
data = b'data' + struct.pack('<I', len(smf)) + smf
rmid = b'RIFF' + struct.pack('<I', 4 + len(data)) + b'RMID' + data
open(os.path.join(OUT, 'wrapped.rmi'), 'wb').write(rmid)
expect['wrapped.rmi'] = expect['format0_4ch.mid']

# ---- 7) 長めの曲（5分・5パート）：動作の重さを見る ----
mf = MidiFile(type=1, ticks_per_beat=tpq)
t0 = MidiTrack(); mf.tracks.append(t0)
t0.append(MetaMessage('track_name', name='Long Song 5 parts'))
t0.append(MetaMessage('set_tempo', tempo=mido.bpm2tempo(120)))
t0.append(MetaMessage('end_of_track'))
import random
random.seed(1)
for nm, base in [('Lead', 67), ('1st', 64), ('2nd', 60), ('3rd', 55), ('Bass', 43)]:
    tr = MidiTrack(); mf.tracks.append(tr)
    tr.append(MetaMessage('track_name', name=nm))
    notes, b = [], 0.0
    while b < 600:
        d = random.choice([0.5, 0.5, 1, 1, 1, 2])
        notes.append((b, d * 0.95, base + random.choice([0, 2, 4, 5, 7, -1, -3])))
        b += d
    add_notes(tr, len(mf.tracks) - 2, notes, tpq)
mf.save(os.path.join(OUT, 'long_5parts.mid'))

json.dump(expect, open(os.path.join(OUT, 'expect.json'), 'w'), ensure_ascii=False, indent=1)
print(sorted(os.listdir(OUT)))
