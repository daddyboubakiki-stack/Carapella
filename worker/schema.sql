-- アカペラ練習帳：共有した曲（1曲＝1行。MIDI本体と管理情報を1回の書き込みで保存する）
CREATE TABLE IF NOT EXISTS songs (
  id TEXT PRIMARY KEY,          -- リンクに入る曲のID（アプリが作る16文字）
  read_hash TEXT NOT NULL,      -- 読み取りキーのSHA-256（キーそのものは保存しない）
  admin_hash TEXT NOT NULL,     -- 管理キー（共有をやめる用）のSHA-256
  name TEXT NOT NULL,           -- 曲名（80文字まで）
  midi BLOB NOT NULL,           -- MIDIファイル（256KBまで。共有をやめたら空にする）
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,         -- MIDIの中身のハッシュ（曲の版を区別する）
  src TEXT NOT NULL,            -- 送り元の目印：HMAC(秘密値, IP＋日付)。IPそのものは保存しない
  created_at INTEGER NOT NULL,  -- 登録した時刻（ミリ秒）
  stopped_at INTEGER            -- 共有をやめた時刻（やめていなければ NULL）
);
-- 回数の上限を数えるための索引
CREATE INDEX IF NOT EXISTS songs_created ON songs (created_at);
CREATE INDEX IF NOT EXISTS songs_src ON songs (src, created_at);
