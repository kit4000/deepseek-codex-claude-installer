# Codex native model router

Codex Desktop/CLI の組み込み `openai` provider id を保ったまま、ネイティブモデルと
Responses API 互換の外部モデルを同じモデルメニューへ載せるローカルルーターです。

別端末・別利用者への安全な移管、Claude Code / Claude Desktop の設定、既存セッションの
保護、表示安定性の受け入れ確認、ロールバックは
[`DEEPSEEK_HANDOFF.md`](DEEPSEEK_HANDOFF.md) を使用してください。

ここでいう ChatGPT 連携は、ChatGPT アカウント認証を利用する Codex Desktop/CLI が対象です。
一般向け ChatGPT Web/Desktop のモデルピッカーは変更しません。

## Routing

- `gpt-*` など名前空間のないモデルは ChatGPT Codex upstream へそのまま転送します。
- `deepseek/deepseek-v4-flash` は DeepSeek 公式 Responses API へ直接転送し、upstream では
  `deepseek/` 名前空間だけを除きます。
- Flash の reasoning effort は公式Codex向け定義に合わせて `low` / `high` / `max` を表示し、
  既定値は `high` です。
- DeepSeek が通常の進捗メッセージとは別に返す生の `reasoning_text` は Desktop へ転送しません。
  大きな推論ブロックの再描画によるスクロール位置のリセットを避けながら、`commentary` の進捗、
  最終回答、ツール呼び出しは保持します。短い進捗メッセージは完了時の `phase` を確定してから配信し、
  生成途中の `final_answer` から `commentary` への切替による表示要素の再配置も防ぎます。
- `deepseek/deepseek-v4-pro` もモデルメニューへ追加済みです。ただしDeepSeek公式の
  Responses API 側でCodex対応が有効になるまでは、モデル名に `Responses API pending` を表示し、
  選択後の実行は公式APIのエラーになります。上流で有効化された後はローカル側の追加変更なしで
  同じルートから利用できます。
- ChatGPT の Authorization と account id は外部 endpoint へ転送しません。
- Codex の remote compaction v2 は、DeepSeek 用の通常要約ターンと単一の
  `compaction` 応答へ相互変換します。要約は DeepSeek API キーから導出した鍵で
  AES-256-GCM 暗号化します。次の DeepSeek ターンでは通常履歴へ戻し、GPT など
  native モデルへ切り替えたときもルーターが復号して平文の要約として転送するため、
  `invalid_encrypted_content` にならずに既存セッションを継続できます。
- `/v1/responses/compact` は DeepSeek に無いため、通常の `/v1/responses` 要約ターンへ
  マップし、SSE を Codex 用の単一 `compaction` 項目へ再構成します。
- DeepSeek へ渡す前に、OpenAI 専用の `encrypted_content` / `agent_message` を除去し、
  Codex の `custom_tool_call`・`local_shell_call` とその output を
  `function_call` / `function_call_output` ペアへ正規化します。これにより
  `Encrypted function output content could not be decrypted or decoded` と
  `No tool call found for tool output with call_id ...` を防ぎます。
- native GPT 経路でも、MultiAgent V2 が `encrypted_content` に平文を入れた不正履歴を
  検出し、`input_text` / user message へ修復します（本物の `gAAAA...` 暗号文は保持）。
- ChatGPT など別 provider が暗号化した `compaction` は復号・転送できないため、
  DeepSeek への切替時だけ除外し、切替後の通常メッセージから会話を継続します。
  native へ戻すときは ChatGPT 自身が検証できるためそのまま転送します。
- 未登録の名前空間とモデル名のない Responses リクエストは fail-closed で拒否します。
- リクエスト本文、プロンプト、コードはログやファイルへ保存しません。

## Install

同一端末への Codex 単体導入は次のとおりです。移管時は個別コマンドではなく、手順書の
preflight と `handoff:install` を使用してください。

```bash
npm test
npm run store-deepseek-key
npm run install
npm run smoke -- gpt-5.6-sol
npm run smoke -- deepseek/deepseek-v4-flash
npm run smoke -- deepseek/deepseek-v4-flash max
```

インストーラーは先にカタログと LaunchAgent を準備し、`/healthz` 成功後に
`~/.codex/config.toml` をタイムスタンプ付きでバックアップします。その後だけ、ルート直下へ
次の3キーを設定します。

```toml
model_provider = "openai"
model_catalog_json = "/Users/.../.codex/model-catalogs/native-plus-external.json"
openai_base_url = "http://127.0.0.1:10100/v1"
```

CodexのHTTPリクエスト圧縮はループバックルーターでは不要なため、インストーラーは
`[features] enable_request_compression = false`も設定します。DeepSeek用CLIプロファイルは
現行Codex形式の`~/.codex/deepseek.config.toml`へ分離します。

タスクDBやスレッドの provider id は読み書きしません。外部 endpoint やモデルを増やしたら
`router-config.json` を編集し、`npm run catalog` と LaunchAgent の再起動を行います。

DeepSeek API キーは `config.toml` や plist には保存せず、macOS キーチェーンの
`com.local.codex-native-model-router.deepseek` に保存します。`store-deepseek-key` は
非表示プロンプトを使うため、キーはコマンドライン引数やシェル履歴に残りません。

## Claude Code

移管用インストーラーは `~/.local/bin/claude-deepseek` を作成します。このランチャーで起動した
子プロセスにだけ DeepSeek 公式 Anthropic 互換 endpoint とモデルを設定するため、通常の
`claude`、`~/.claude/settings.json`、既存セッションは変更しません。

```bash
npm run install:claude
claude-deepseek                         # DeepSeek V4 Pro (1M), max effort
claude-deepseek --deepseek-model flash # DeepSeek V4 Flash
claude-deepseek --deepseek-print-config
```

Claude Desktop 用には、実キーを一切含まない構成を自動導入できます。

```bash
npm run install:claude-desktop
```

インストーラーは `~/Library/Application Support/Claude-3p/configLibrary/` へ固定モデル一覧
（`claude-opus-4-5` → DeepSeek V4 Pro (1M)、`claude-haiku-4-5` → DeepSeek V4 Flash）を書き、
`~/.local/bin/claude-desktop-credential-helper` から
macOS キーチェーンの DeepSeek キーを読み出します。キーはファイルや設定 JSON へ埋め込まれません。
Claude Desktop を完全終了して再起動すると third-party inference が有効になり、モデル選択と
Chat / Cowork / Code で DeepSeek が使えます（3P の Chat タブは 1.13576.0 以降で対応）。

元の Claude.ai 接続へ戻す場合は、インストーラーが表示した `*.before-deepseek-*` バックアップを
元の場所へ戻してから再起動してください。手動でアプリ内設定する場合は、実キーを含まない
[`config/claude-desktop-gateway.template.json`](config/claude-desktop-gateway.template.json) を
参照し、キーは Claude Desktop の画面へ直接入力します。

## Handoff commands

```bash
npm run handoff:preflight
npm run handoff:install
npm run handoff:verify
npm run handoff:archive -- /tmp/deepseek-handoff.tar.gz
```

復元は、インストーラーが表示する `config.toml.before-model-router.*.bak` を
`config.toml` へ戻し、`launchctl bootout gui/$(id -u)
~/Library/LaunchAgents/com.local.codex-native-model-router.plist` を実行します。
