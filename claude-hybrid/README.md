# Claude Hybrid

Claude Desktop の **Code タブだけ** をローカルルーターに向け、公式サブスクリプション
（OAuth）と DeepSeek 公式 API を同じ画面・同じセッションで切り替えます。

- Chat / Cowork タブと OAuth の設定は変更しません。
- `~/Library/Application Support/Claude` をそのまま共有するため、公式 Claude で作った
  Code セッションも Claude Hybrid から開けます。
- 日常アプリは `/Applications/Claude.app`（表示名 `Claude`）です。これは純正ソースから
  構築した Hybrid で、ad-hoc 再署名のため hardened runtime は外れます。
- 純正ソースは `~/Applications/Claude Official.app` に未パッチ・Apple署名のまま保持します。

## 構成

### `/Applications/Claude.app`（Hybrid）

- 公式 `Claude.app` のコピー。自動更新は `DISABLE_AUTOUPDATER=1` で無効化。
- Code タブが Claude Code 子プロセスへ渡す `ANTHROPIC_BASE_URL` だけを
  `http://127.0.0.1:10102` に書き換え。
- Code タブのWebピッカーで Sonnet 4.6 を DeepSeek V4 Flash、Opus 4.6 を
  DeepSeek V4 Pro (1M) と表示し、選択時はルーターが対応するDeepSeekモデルへ
  振り分けます。Fable 5 / Opus 4.8 と、純正の Opus 5 / Sonnet 5 / Haiku 4.5
  はそのまま残ります。
- `CLAUDE_USER_DATA_DIR` を `~/Library/Application Support/Claude` に固定し、
  以前の 3P 設定（`Claude-3p`）に引きずられず公式アカウント・セッションを共有。
- asar は正しいヘッダー位置・パディングで再パックし、`ElectronAsarIntegrity` を再計算。
- アプリ複製はAPFSのコピーオンライトを使い、インストール時の一時容量を抑制。

### ローカルルーター（LaunchAgent: com.local.claude-hybrid-router）

- ポート `127.0.0.1:10102`。
- 通常モデル（`claude-*`）は `api.anthropic.com` へ OAuth のまま転送。
- 外部モデルは DeepSeek 公式 Anthropic 互換 API へ送信し、モデル名を変換:
  - `claude-opus-4-5-external-pro` → `deepseek-v4-pro[1m]`
  - `claude-haiku-4-5-external-flash` → `deepseek-v4-flash`
- DeepSeek キーはファイルへ保存せず、macOS キーチェーン
  `com.local.codex-native-model-router.deepseek` から credential helper 経由で読み出し。
- `/v1/models` は公式一覧に DeepSeek エントリを追加して返却。
- 上流の `content-encoding` は fetch が展開済みボディを渡すため除去して転送。

## インストール

```bash
npm test
npm run store-deepseek-key   # 初回のみ。非表示入力
npm run install
npm run verify
npm run smoke                # DeepSeek は実 API を少量使用（課金発生）
```

## 公式Claude更新後のHybrid更新

Hybrid自身のアプリ内更新は使いません。Apple署名を検証した純正アプリで
`~/Applications/Claude Official.app` を更新し、次で互換性だけを読み取り確認します。

```bash
npm run update:check
```

更新可能と表示されたら公式ClaudeとHybridを完全終了し、再構築します。

```bash
npm run update
```

公式署名、バージョン固有の2つのパッチ位置、Keychain、実行中プロセスを検査し、条件が
揃わなければ変更せず停止します。更新済みの Official ソースから新しいHybridを作り、以前の
Hybridは `Claude.app.before-deepseek-*` へ退避し、無課金の整合性検証まで自動実行します。

同じ純正版から作られた既存Hybridが現行パッチ契約をすべて満たし、管理用の
`ClaudeHybridPatchVersion` だけが不足している場合は、巨大なElectron Frameworkを
再署名せず、検証済みアプリのメタデータだけをAPFSステージ経由で移行します。
それ以外は従来どおり純正アプリから完全再構築します。

両アプリを先に完全終了してください。その後 `/Applications/Claude.app` を開きます。
純正をフルパスで開いた後などにランチャーがずれた場合は `prefer-claude-hybrid` を実行します。

初回起動時は macOS が「Claude がキーチェーン内の 'Claude Safe Storage' に
保存されている機密情報を使用しようとしています」と表示します。ログインパスワードを
入力し「常に許可」を選んでください（再署名後の一度きりの確認です）。

Code タブのモデルピッカーには、よく使うモデル（Fable / Opus / Sonnet / Haiku）と
「他のモデル」の DeepSeek V4 Pro (1M) / DeepSeek V4 Flash が並びます。

## 検証

`npm run verify` は以下を確認します。

- asar ヘッダー整合性ハッシュが Info.plist と一致
- `ANTHROPIC_BASE_URL` パッチが適用済み
- DeepSeek のカスタムモデル環境変数が適用済み
- WebピッカーのDeepSeek表示名パッチとルーターaliasが適用済み
- codesign 検証
- Official ソースの Apple 署名と未パッチ状態
- Hybrid の表示名 `Claude`、`ClaudeHybridPatchVersion`、`DISABLE_AUTOUPDATER=1`
- ルーター /v1/models に外部モデルが含まれる
- LaunchAgent が running
- `CLAUDE_USER_DATA_DIR` が公式 Claude データディレクトリを指す

`npm run smoke` はルーター経由で実通信し、純正ルートは 401（認証なし）、
DeepSeek ルートは `DEEPSEEK_HYBRID_OK` の完全応答を確認します。

## ロールバック

`/Applications/Claude.app.before-deepseek-*` の対象バックアップを元の場所へ戻し、
以下を実行します。

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.local.claude-hybrid-router.plist
```

純正ソースは `Claude Official.app.before-*` の対象バックアップから戻せます。
DeepSeek キー、セッション、Application Support は削除しません。
