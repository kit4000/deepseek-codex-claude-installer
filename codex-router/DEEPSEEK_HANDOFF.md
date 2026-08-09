# DeepSeek 統合の安全な移管手順書（macOS）

この文書は、別の macOS 端末または別の利用者へ本バンドルを移管し、次の状態を再現するための実行手順です。

- ChatGPT アカウントで利用している **Codex Desktop / Codex CLI** のモデル一覧に、既存のネイティブモデルを残したまま DeepSeek を追加する。
- Claude Code では、通常の `claude` を既存の Anthropic 接続のまま残し、専用の `claude-deepseek` から DeepSeek Pro / Flash を選べるようにする。
- Codex と Claude の既存セッション、ログイン情報、利用者固有の設定を移送・削除・置換しない。
- DeepSeek のストリーム応答に含まれる生の推論表示とメッセージ種別の揺れを整形し、Codex Desktop の再描画とスクロール位置のリセットを抑止する。

> [!IMPORTANT]
> この文書でいう「ChatGPT」は、ChatGPT アカウント認証を利用する **Codex Desktop / CLI** を指します。一般向け ChatGPT Web / ChatGPT Desktop のモデルピッカーへ外部モデルを追加する手順ではありません。

## 1. 実行者向けの厳守事項

人または AI エージェントがこの文書を実行する場合、次を守ってください。

1. 各チェックポイントが成功するまで次へ進まない。
2. 移管元の `~/.codex/auth.json`、`~/.codex/sessions`、Codex のタスク DB、`~/.claude`、Claude のセッション、API キー、キーチェーン項目をコピーしない。
3. 移管先では、その端末の利用者本人の ChatGPT / Claude ログインと、本人に使用権限がある DeepSeek API キーを使う。
4. `~/.codex/config.toml` や `~/.claude/settings.json` を手作業で全面置換しない。
5. `ANTHROPIC_BASE_URL` や DeepSeek のモデル指定をシェル設定または `~/.claude/settings.json` へグローバル設定しない。通常の `claude` が DeepSeek に固定され、既存の Claude セッションへ影響するためです。
6. バンドルは `/tmp` ではなく、移動・削除しない永続ディレクトリへ展開する。導入後に移動した場合は、元の場所へ戻すか、その場所で導入をやり直す。
7. エラー時に認証ファイルやセッションディレクトリを削除して解決しない。本書の「トラブルシューティング」または「ロールバック」に進む。

このバンドルが自動変更する対象は次だけです。

| 対象 | 動作 |
|---|---|
| `~/.codex/config.toml` | 直前バックアップを作り、管理対象のルートキーと `[features].enable_request_compression` だけを更新 |
| `~/.codex/model-catalogs/native-plus-external.json` | 端末固有のネイティブカタログと DeepSeek 定義を合成 |
| `~/.codex/deepseek.config.toml` | 管理済みファイルだけを作成または更新 |
| `~/Library/LaunchAgents/com.local.codex-native-model-router.plist` | ローカルルーターを登録 |
| `~/.local/bin/claude-deepseek` | 管理済みランチャーだけを作成または更新 |
| `~/.local/bin/claude-desktop-credential-helper` | 管理済み Keychain 読み出しヘルパーだけを作成または更新 |
| `~/Library/Application Support/Claude-3p/` | 既存設定をバックアップし、管理対象の third-party inference 設定を配置 |
| macOS キーチェーン | 指定サービス名へ移管先利用者の DeepSeek キーを保存 |

Codex / Claude のセッション保存先とログイン情報は、インストーラーの操作対象ではありません。

## 2. 移管元で安全な配布アーカイブを作る

バンドルのルートで次を実行します。

```bash
npm test
npm run handoff:archive -- /tmp/deepseek-handoff.tar.gz
```

2つ目のコマンドは、配布対象を [`config/handoff-files.json`](config/handoff-files.json) の許可リストへ限定し、秘密らしい文字列を検査したうえで、権限 `0600` のアーカイブと SHA-256 を表示します。既存ファイルを上書きしないため、同じ出力名が存在する場合は別名を指定してください。

チェックポイント:

- `npm test` がすべて成功している。
- JSON 出力に `archivePath`、`sha256`、`files` がある。
- アーカイブそのものと、期待する SHA-256 値を別経路で移管先へ伝える。
- リポジトリ内に残っている可能性があるバックアップ、調査資料、ログ、認証情報は別途添付しない。

## 3. 移管先の前提条件

現在の構成が対応するのは macOS です。移管先で次を確認します。

```bash
sw_vers
node --version
codex --version
claude --version
```

必要条件:

- Node.js 20 以上。
- Codex Desktop / CLI が移管先利用者の ChatGPT アカウントで利用できる。
- Codex Desktop を一度起動済みで、`~/.codex/config.toml` とネイティブモデルキャッシュが存在する。
- 公式 Claude Code の `claude` コマンドが利用できる。
- 移管先利用者自身の DeepSeek API キーがある。
- ポート `127.0.0.1:10100` を本ルーターが使用できる。

一般向け ChatGPT アプリだけを利用していて Codex がない端末、Windows / Linux、または管理ポリシーにより LaunchAgent / キーチェーンを利用できない端末では、この手順をそのまま実行しないでください。

## 4. アーカイブを検証して永続ディレクトリへ展開する

以下のパスは例です。既存ディレクトリへ混ぜず、新しい空のディレクトリを使用します。

```bash
export DEEPSEEK_ARCHIVE="/path/to/deepseek-handoff.tar.gz"
export EXPECTED_SHA256="移管元から別経路で受け取った64文字のSHA-256"
shasum -a 256 "${DEEPSEEK_ARCHIVE}"
printf '%s  %s\n' "${EXPECTED_SHA256}" "${DEEPSEEK_ARCHIVE}" | shasum -a 256 -c -
```

表示されたハッシュが `EXPECTED_SHA256` と完全一致することを人が確認してから、次へ進みます。

```bash
mkdir -p "${HOME}/Applications"
mkdir "${HOME}/Applications/deepseek-handoff"
tar -xzf "${DEEPSEEK_ARCHIVE}" -C "${HOME}/Applications/deepseek-handoff"
cd "${HOME}/Applications/deepseek-handoff"
npm test
```

`mkdir` が「File exists」で失敗した場合、そのディレクトリへ上書き展開せず、`deepseek-handoff-v2` など別の未使用名を選びます。

チェックポイント: テストがすべて成功し、特に次の表示安定化テストが成功していること。

- `removes DeepSeek raw reasoning redraws while preserving commentary`
- `keeps long final answers streaming with one stable phase`
- `passes non-JSON SSE frames through without changing their payload`

## 5. 事前検査と API キー保存

```bash
npm run handoff:preflight
```

出力の最上位 `ok` が `true` であることを確認します。API キーが未保存の場合の `DeepSeek credential: warn` と、未導入時の `router port: warn` はこの段階では許容されます。`fail` が1件でもあれば導入せず、表示された原因を解消して再実行します。

特に `native Claude provider isolation` が失敗した場合、表示されたファイルまたは環境変数を確認し、過去に設定した **DeepSeek 関連のグローバル指定だけ** を手作業で除去します。既存の Anthropic 設定全体を削除してはいけません。

続いて、移管先利用者自身の DeepSeek API キーを非表示プロンプトから保存します。

```bash
npm run store-deepseek-key
```

キーは次のキーチェーン項目へ保存され、コマンドライン引数、シェル履歴、配布設定ファイルへは書きません。

```text
service: com.local.codex-native-model-router.deepseek
account: api-key
```

## 6. Codex と Claude Code を導入する

Codex Desktop で進行中の生成がないことを確認してから実行します。Codex Desktop 内のエージェントがこの手順自体を実行している場合は、ここでアプリを強制終了せず、導入完了後に人が再起動します。

```bash
npm run handoff:install
```

このコマンドは次の順で fail-closed に処理します。

1. 事前検査を再実行する。
2. ネイティブモデルと DeepSeek のカタログを合成する。
3. ルーターを起動し、`/healthz` が期待する provider / route を返したことを確認する。
4. その後でのみ `~/.codex/config.toml` をバックアップし、管理対象キーを更新する。
5. `claude-deepseek` ランチャーを作成する。通常の `claude` 設定は変更しない。
6. API 呼び出しを行わない構成検証を実行する。

出力された `backupPath` を安全な場所へ記録してください。既存の Codex 設定テーブルやプロファイル、タスク DB、セッションは削除されません。また、既存の未管理 `claude-deepseek` 実行ファイルや `deepseek.config.toml` がある場合は上書きせず停止します。

`~/.local/bin` が PATH にない現在のシェルでは、次を実行します。永続化する場合も、この PATH 行だけをシェル設定へ追加し、Anthropic / DeepSeek の環境変数は追加しません。

```bash
export PATH="${HOME}/.local/bin:${PATH}"
```

## 7. 無課金の構成検証

```bash
npm run handoff:verify
claude-deepseek --deepseek-print-config
```

期待結果:

- `handoff:verify` の最上位 `ok` が `true`。
- Codex の `model_provider` は引き続き組み込みの `openai`。
- 合成カタログにネイティブモデルと `deepseek/deepseek-v4-flash` の両方がある。
- `/healthz` は `provider: openai` と `routes: ["deepseek", ...]` を返す。
- `claude-deepseek --deepseek-print-config` は公式 URL、選択モデル、`credential.available: true` を表示するが、API キー値は表示しない。
- `sessionStore` は既存の場所のままであり、通常の `claude` は従来の provider のまま。

`handoff:verify` と `--deepseek-print-config` は DeepSeek へ生成リクエストを送らないため、API 利用料は発生しません。

## 8. Codex Desktop の再起動と UI 受け入れ確認

1. Codex Desktop を完全終了し、再度起動する。
2. 既存のタスクを1件開き、履歴が残り、従来のネイティブモデルで継続できることを確認する。
3. 新しいテスト用タスクを開き、モデル一覧にネイティブモデルと `DeepSeek V4 Flash (Official API)` が両方あることを確認する。
4. Flash を選び、進捗更新が3回以上発生する少し長めのタスクを実行する。
5. 生成中に表示が先頭へ飛ばず、最新の進捗を追えることを確認する。
6. 進捗、最終回答、ツール呼び出しが残り、巨大な生の推論ブロックが挿入されないことを確認する。
7. 生成後、同じタスクをネイティブモデルへ戻して継続できることを確認する。

ルーターは `reasoning_text` の表示用イベントだけを抑止し、通常の `commentary`、最終回答、ツール呼び出しは保持します。また、同一メッセージの `phase` が生成途中で変化して表示要素が再配置されることを抑止します。ただし、実際の Codex Desktop UI の受け入れ確認は自動テストでは代替できないため、上記の目視確認を完了条件に含めてください。

Codex 用の `DeepSeek V4 Pro (Responses API pending)` は、DeepSeek 公式 Responses API 側の対応待ちです。表示されても、Codex 側の移管受け入れテストには使用しません。

## 9. Claude Code で DeepSeek を選ぶ

通常の Claude を使う場合:

```bash
claude
claude --resume
```

DeepSeek Pro（既定、max effort）を使う場合:

```bash
claude-deepseek
```

DeepSeek Flash を選ぶ場合:

```bash
claude-deepseek --deepseek-model flash
```

DeepSeek で作成したセッションを DeepSeek 接続のまま再開する場合:

```bash
claude-deepseek --resume
```

専用ランチャーは起動した子プロセスにだけ、DeepSeek 公式 Anthropic 互換 endpoint、モデル、max effort、キーチェーンのトークンを設定します。終了後にシェルや通常の `claude` へ設定は残りません。

既存の Anthropic / Claude.ai セッションは、従来どおり通常の `claude --resume` で利用してください。異なる provider 間で同じ会話を相互に再開できるとは限らないため、既存の Anthropic セッションを初回の DeepSeek 動作確認には使わず、新規テストセッションを使用します。

## 10. 課金を伴う API 疎通確認（任意）

以下は実際の生成 API を呼ぶため、利用者の許可と API 残高を確認してから実行します。

```bash
npm run smoke -- deepseek/deepseek-v4-flash
npm run smoke -- deepseek/deepseek-v4-flash max
npm run smoke:claude
```

期待結果は、Codex 用の2件が `completed: true` かつ `output: "ROUTER_OK"`、Claude 用が `completed: true` かつ `output: "CLAUDE_DEEPSEEK_OK"` です。Claude smoke は一時的な `CLAUDE_CONFIG_DIR` を使い、終了時にテストセッションを削除します。

ネイティブ Codex 側も API 疎通を確認する場合は、現在その端末で利用可能な名前空間なしのネイティブモデル ID を指定します。モデル ID は更新され得るため、この文書へ固定値を持たせません。

## 11. Claude Desktop でもモデル一覧を使う場合（任意・別経路）

推奨経路は、既存 Claude を保護できる `claude-deepseek` です。Claude Desktop の third-party inference はアプリ全体の provider 設定であり、セッションごとの安全な切替ではありません。既存の Claude.ai セッションを常用する端末では、影響を理解した場合だけ設定してください。

### 自動導入（推奨・キーは Keychain のまま）

Claude Desktop を完全終了してから、バンドルのルートで次を実行します。

```bash
npm run install:claude-desktop
```

このコマンドは次の処理を fail-closed で行います。

1. `config/claude-deepseek.json` と `config/claude-desktop-gateway.template.json` を検証する。
2. `~/.local/bin/claude-desktop-credential-helper` へ、Keychain の
   `com.local.codex-native-model-router.deepseek` / `api-key` だけを読む実行ファイルを配置する。
3. `~/Library/Application Support/Claude-3p/` の既存 `claude_desktop_config.json` と
   `configLibrary/` を `*.before-deepseek-<timestamp>` へ退避する。
4. `deploymentMode: "3p"` と `configLibrary/_meta.json`、`<appliedId>.json` を書き、実キーは
   `inferenceGatewayApiKey` にも helper 本体にも含めない。認証は公式サポートの
   `inferenceCredentialKind: "helper-script"` 経由にする。
5. Gateway URL `https://api.deepseek.com/anthropic`、auth scheme `bearer`、model discovery 無効、
   固定モデル `claude-opus-4-5`（DeepSeek 側で V4 Pro へ解決）/ `claude-haiku-4-5`（V4 Flash へ解決）
   を設定し、3P でも Chat タブを使えるよう `chatTabEnabled: true` を有効にする。

Claude Desktop を完全終了して再起動すると、third-party inference が有効になります。このモードでは
モデル選択と Chat / Cowork / Code が DeepSeek 経由になります。新規セッションでモデル一覧に
両モデルが出て、応答が返ることを確認してください。

### 手動導入（アプリ内でキーを入力する場合）

1. Claude Desktop の Help → Troubleshooting から Developer Mode を有効化し、アプリを完全終了して再起動する。
2. Developer → Configure Third-Party Inference を開く。
3. Gateway URL に `https://api.deepseek.com/anthropic`、認証方式に static / Bearer を指定する。
4. 移管先利用者自身の API キーを **Claude Desktop の画面へ直接** 入力する。テンプレートファイルの `<ENTER_PER_DEVICE_IN_CLAUDE_DESKTOP>` を実キーへ置換して保存しない。
5. model discovery を無効にし、テンプレート記載の完全一致 ID `claude-opus-4-5` と `claude-haiku-4-5` を明示登録する。
6. Claude Desktop を完全終了して再起動し、新規セッションでモデル一覧と応答を確認する。

Claude Desktop は設定を起動時に読みます。元の Claude.ai provider へ戻すときは、自動導入時に表示された
`*.before-deepseek-*` バックアップを元の場所へ戻した後、完全終了・再起動してください。利用中バージョンの
UI に従い、履歴や認証ファイルを削除して戻そうとしないでください。

静的 API キーを埋め込んだ `.mobileconfig` や完成済み JSON を他者へ配布してはいけません。配布物に含めるのは
プレースホルダーのテンプレートだけです。

## 12. ロールバック

### Claude Code

通常の `claude` は変更されていないため、`claude-deepseek` の使用をやめれば元の接続を使えます。セッションディレクトリや `~/.claude/settings.json` を削除する必要はありません。

### Codex

導入時に表示された **この端末の正確な `backupPath`** を使います。別端末のバックアップは使いません。

1. Codex Desktop の作業を終了して完全終了する。
2. 現在の設定も別名で退避する。
3. LaunchAgent を停止する。
4. 記録したバックアップを `config.toml` へ戻す。
5. Codex Desktop を再起動し、既存タスクとネイティブモデルを確認する。

```bash
cp "${HOME}/.codex/config.toml" "${HOME}/.codex/config.toml.before-handoff-rollback.$(date +%Y%m%d-%H%M%S).bak"
launchctl bootout "gui/$(id -u)" "${HOME}/Library/LaunchAgents/com.local.codex-native-model-router.plist"
cp "/導入時に記録した/config.toml.before-model-router....bak" "${HOME}/.codex/config.toml"
```

この操作でもセッションやタスク DB は削除しません。キーチェーン資格情報が今後どの統合からも不要であることを確認した場合に限り、次で削除できます。これは取り消せないため、通常のロールバックには不要です。

```bash
/usr/bin/security delete-generic-password \
  -s com.local.codex-native-model-router.deepseek \
  -a api-key
```

## 13. トラブルシューティング

### `native Claude provider isolation` が失敗する

エラーは値を表示せず、該当するファイル名と環境変数名だけを示します。`~/.claude/settings.json`、`.zshrc`、`.zprofile`、`.bashrc`、`.bash_profile`、`.profile` のうち指摘された場所から、DeepSeek に向けたグローバル指定だけを取り除き、新しいシェルで事前検査を再実行します。

### ポート `10100` が予期しないサービスに使われている

導入を続行しません。`npm run handoff:preflight` が期待する `/healthz` でないことを検出します。占有プロセスの所有者と用途を確認し、勝手に終了させずに調整してください。

### 導入後にバンドルを移動した

LaunchAgent と `claude-deepseek` は絶対パスを保持します。元の場所へ戻すか、新しい永続場所で `npm test`、`npm run handoff:preflight`、`npm run handoff:install` を再実行してください。

### Codex のモデル一覧が更新されない

`npm run handoff:verify` を実行し、すべて成功してから Codex Desktop を完全終了・再起動します。`~/.codex/config.toml` の全面置換やモデルキャッシュの削除は行いません。

### ルーターが起動しない

次を確認します。ログへリクエスト本文、プロンプト、コードを保存する設計ではありません。

```bash
curl -sS http://127.0.0.1:10100/healthz
tail -n 100 /tmp/codex-native-model-router.err.log
```

期待する health は `ok: true`、`provider: "openai"`、`routes` に `deepseek` を含む JSON です。

## 14. 完了条件

次がすべて成立した時だけ移管完了とします。

- 配布アーカイブの SHA-256 が一致した。
- `npm test`、`handoff:preflight`、`handoff:verify` が成功した。
- Codex の既存タスクとネイティブモデルが引き続き利用できる。
- Codex で DeepSeek Flash を選択できる。
- 長めの DeepSeek タスクで画面が先頭へ戻らず、進捗・最終回答・ツール呼び出しが表示される。
- 通常の `claude` と既存 Anthropic セッションが従来どおり利用できる。
- `claude-deepseek` で Pro / Flash を選べる。
- API キー、認証情報、セッションデータが配布物へ含まれていない。
- 課金疎通を実施した場合は、各 smoke の期待文字列を確認した。

## 公式仕様

- [DeepSeek: Use DeepSeek in Claude Code and other coding agents](https://api-docs.deepseek.com/guides/coding_agents/)
- [Anthropic: Connect Claude Code to tools via an LLM gateway](https://docs.anthropic.com/en/docs/claude-code/llm-gateway-connect)
- [Anthropic: Configure Claude Desktop with third-party inference](https://claude.com/docs/third-party/claude-desktop/gateway)
- [Anthropic: Configuration reference for third-party integrations](https://claude.com/docs/third-party/claude-desktop/configuration)
