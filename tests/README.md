# テスト

`index.html`（リポジトリ直下）をテストします。結果や画面写真は `tests/out/` に出ます（Gitには入れません）。

## 準備

- Node.js 18 以上
- `npm install`（Playwright と Chromium が入ります。初回のみ `npx playwright install chromium` も必要なことがあります）
- テスト用MIDIを作り直す時だけ：Python 3 と `pip install mido`

## テストの種類

| コマンド | 内容 | ブラウザ |
|---|---|---|
| `npm run test:unit` | MIDI解析、音程推定、ビブラート、表示移動、入力設定、和音復帰・お手本、ソロ・シーク・ループ | 不要 |
| `npm run test:e2e` | 実ブラウザで操作する総合テスト（下の6項目）。5分ほどかかります | Chromium |
| `npm run test:marks` | しおりの操作（長押しして離すと作る・なぞると表示の移動・タップでシート・取り消し・中断や2本指では作らない・ここから／ここまで・指での操作）と、「ずれ」欄の高さが変わらないこと | Chromium |
| `npm run test:parts` | パートごとの音量（最大200%）、バーの色（パート順の初期色・変更・記憶）、音色（記憶・音色ごとの判定） | Chromium |
| `npm run test:chord` | 和音練習（一人用）：和音の区切り、押した時刻の和音から始める、お手本＝全パート／合わせる＝自分以外、判定の線、前後の和音、戻る | Chromium |
| `npm run test:zoom` | 2本指のピンチ（横＝バーの長さ、縦＝音の間隔）とCtrl（＋Shift）＋ホイール。方向は指を離すまで固定、指・マウスの下の時刻を保つ、縦の拡大の中心は動かない、25%でも音名が9px以上で重ならない、範囲が端を越えない、250%でも音符を選べる、音域を戻す、記憶 | Chromium |
| `npm run test:share` | 曲専用リンク：API（`worker/`）の確認（MIDIだけ受け付ける・大きさ・回数の上限・キー違いと「ない」を区別しない・やめた後・送り直しで2つにならない・IPを残さない）と、アプリの画面（作る・コピー・LINE・開く・やめる・エラー時の表示・スマホでメニューと重ならない）。データベースは Node の `node:sqlite` で代用（`tests/helpers/d1-sqlite.js`） | APIは不要／画面はChromium |
| `npm run test:share:workerd` | 曲専用リンクのAPIを、Cloudflare の実行環境（`npx wrangler@4 dev` の workerd ＋ 手元のD1）で確かめる：MIDIの出し入れでバイト列が変わらない、同時に30件送っても上限の20件を超えない など。公開後は `node tests/share_workerd.js --remote <WorkerのURL>` で本番を合成MIDIで確かめる（作った曲は最後にやめる） | 不要（wranglerを取得） |
| `npm run test:background` | 画面を切り替えても聴く：用意した音声の中身（ソロ・段階・音量0%・キー・テンポ・区間ループ）を読み戻して測る。隠れた時に `<audio>` へ引き継ぐ・戻ると同じ位置から続ける・テンポ50%・区間ループの繰り返し・ロック画面の操作・曲の終わり・ページを離れた時・マイクON・設定直後・再生を断られた時・曲の変更 | Chromium |
| `npm run test:layout` | スマホ幅で、音程バーと下の操作バーが同じ画面に収まるか＋画面写真 | Chromium |

HTTPプレビューで `tests/controls-browser.html` を開いて「検証を開始」を押すと、操作ボタン更新の結合テストを実行できます。再生中の10秒シーク・全4段階のソロと元のミックスへの復帰・全曲折り返し・区間指定・合成マイクでの録音・6サイズのレイアウトを、本体のコードと実際のAudioContextで確認します。アプリはテスト用iframe内に読み込まれ、実際のマイク許可は要求しません。

`node tests/transport_test.js` は今回の音量・再生状態の変更だけをブラウザなしで検証します。実機の画面ロック・バックグラウンド動作の確認を代用するテストではありません。

`node tests/background_test.js`（`test:unit` に含む）と `npm run test:background` は、画面が隠れたことを `document.visibilityState` の書き換えで知らせます。本物の画面ロック・別アプリ切り替えではないので、スマホでの確認は `docs/handoff-controls-2026-11-05.md` の7.6の手順で行います。

`node tests/e2e2.js <名前>` で一部だけ実行できます：

- `judge` … 判定の回帰（前の版と同じ結果か：完璧100%、30セント高い・半音・オクターブなど）
- `modes` … 練習の段階（スピーカー漏れの再現、③④で最初の音が鳴るか）
- `count` … カウントイン（回数・間隔・テンポ50%・止めた時の位置）
- `loop` … 区間リピート（行き来・回ごとの記録・区間の録音・録音中の操作禁止）
- `guard` … 保存していない録音を消す前の確認、聴き返し
- `mobile` … 画面切替で一時停止、音が止められた時、iPhone用の音声設定、画面スリープ防止、設定の記憶、LINE内ブラウザの案内、Android相当の操作

## マイクの代わり

マイクには人の声ではなく「ガイド音をそのまま流し込む」仕掛けを使います。ガイド全体の音程をずらして「30セント高く歌う人」「1オクターブ下で歌う人」を作ります。スピーカーから漏れた音を拾う状況の再現にもなります。

## 限界

お手本の単音→和音・1秒／3秒・予約の取消は、`test:unit` の `chord_model_test.js` でも検査する。これは記録用AudioContextでの予約と取消の検査。

実際のWeb Audioの波形は、アプリを配信する同じサーバーで `/tests/chord-audio.html` を開くと検査できる（OfflineAudioContext。単音の各区間にほかの音が残らない、最後に全音が鳴る、終了後の無音、押し直しで旧予約が復活しない）。実機スピーカー・イヤホンの聞こえ方の検査とは区別する。

- Chromium のみ。iPhoneのSafari・Android実機・Bluetoothイヤホンは確認できません（`docs/device-checklist.md` で人が確かめる）
- 合成音での確認で、人の声ではありません
- 曲専用リンクは、手元の SQLite と、手元の Cloudflare の実行環境（wrangler dev）で確かめています。本物の D1（世界のどこからでも届く版）での確認は、公開の設定をした後に `--remote` で行います
