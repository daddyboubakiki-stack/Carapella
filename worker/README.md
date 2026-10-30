# 曲専用リンクのAPI（Cloudflare Workers ＋ D1）

アカペラ練習帳の「共有リンク」で使う、曲（MIDI）の置き場です。練習画面は今まで通り GitHub Pages で、ここは曲の出し入れだけを行います。

- ログインも合言葉もありません。**リンクを知っている人は誰でも開けます。**
- 受け付けるのは MIDI ファイルだけ（256KB まで、曲名は80文字まで）。
- 登録の上限：同じネットワークから1時間に20件、全体で24時間に300件。
- 共有をやめると、その曲の本体は消え、リンクは開けなくなります（すでに開いた人の画面からは消せません）。
- IP アドレスそのものは保存しません（秘密値つきのハッシュだけ。日をまたぐとつながりません）。

## 用意するもの（本人の作業）

1. Cloudflare のアカウント（無料プラン）
2. パソコンに Node.js（`npx wrangler` を使うため）

## 手順

```bash
cd worker
npx wrangler login
```

1. D1 を作る

```bash
npx wrangler d1 create carapella-share
```

2. 表示された `database_id` を `wrangler.toml` に書き込む

3. 表を作る

```bash
npx wrangler d1 execute carapella-share --remote --file=schema.sql
```

4. 公開する

```bash
npx wrangler deploy
```

5. 秘密値を登録する（無作為の長い文字列を作って、そのまま渡す。画面に出ず、どこにも書き残さなくてよい）。これを済ませるまで、曲の登録は「混み合っています」ではなくエラー（503）で断られます

```bash
node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" | npx wrangler secret put IP_SALT
```

6. 手順4で表示された URL（`https://carapella-share.<アカウント>.workers.dev`）を、`index.html` の `const SHARE_API = '';` に入れる（Claude Code が PR で行います）

## テスト

リポジトリ直下で：

```bash
npm run test:share
```

```bash
npm run test:share:workerd
```

1つ目は D1 を Node の SQLite でまね、アプリの画面も確かめます。2つ目は手元で Cloudflare の実行環境（`wrangler dev`）を起こして確かめます（同時に届いた登録で上限を超えないか、MIDIの出し入れでバイト列が変わらないか）。どちらも Cloudflare のアカウントは使いません。

公開した後は、合成MIDIで本番を確かめます（作った曲は最後に「共有をやめる」まで行います）：

```bash
node tests/share_workerd.js --remote https://carapella-share.<アカウント>.workers.dev
```
