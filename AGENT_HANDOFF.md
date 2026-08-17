# 外部エージェント向け実行契約

この文書は、人または外部AIエージェントが、別のmacOS環境へ統合インストーラーを安全に
適用するための契約です。静的ファイルの存在だけで成功とせず、無課金検証、再起動後の表示、
実応答を段階的に確認します。

**GitHub URL だけを渡されたエージェントは、この文書を全文読んでから導入します。**
正本は `https://github.com/kit4000/deepseek-codex-claude-installer` です。
tar.gz や別端末のキー、会話から推測した秘密は使いません。

## 絶対条件

1. APIキーを推測・抽出・コピーしない。MacBook Airや別ユーザーのKeychain、設定、ログ、
   会話から取得してはいけません。`npm run store-key` で導入先ユーザー本人に非表示入力を求めます。
2. 公式の中身は変更しない。純正実体は `~/Applications/Claude Official.app` で、
   Apple署名・未パッチのまま保持します。パッチ対象の日常アプリは `/Applications/Claude.app` です。
3. `~/.codex/auth.json`、CodexのタスクDB／セッション、`~/.claude`、Claudeのユーザーデータ、
   Keychain項目を移送、削除、全面置換しません。
4. Fable 5 と Opus 4.8、Opus 5、Sonnet 5、Haiku 4.5 は純正Claudeとして維持します。
   外部APIへ割り当てるのは Opus 4.6（DeepSeek Pro）、Sonnet 4.6（DeepSeek Flash）の2枠だけです。
   ChatGPT サブスクリプションを OpenAI API キー経路として解釈しません。
   `haiku` エイリアスは DeepSeek Flash のまま残し、opus / sonnet エイリアスは純正のままです。
5. 課金テストは利用者の明示承認前に実行しません。`--allow-billing` は承認を記録した
   エージェントだけが付けます。
6. 署名、ASAR、バージョン固有アンカーの検査が失敗したら停止します。文字列の近似一致や
   未検証の別チャンクを勝手にパッチしません。
7. Codex／Claudeを強制終了せず、再起動とKeychainの「常に許可」は利用者へ依頼します。
8. DeepSeek V4をサブエージェントとして追加しても、親モデル、メインピッカー、既存の
   サブエージェント既定値を置換しません。
9. 導入の正本は GitHub リポジトリの clone です。`/tmp` へ置かず、導入後も削除しません。

## 組み込まれた重要修正

### GPTへ戻すときの暗号化コンパクション

DeepSeek経路が作る `codex-native-model-router:compaction:v1:` 項目は、同じ端末のDeepSeek
Keychain資格情報から導出した鍵でルーターが復号し、平文の要約メッセージへ変換してから
純正GPT上流へ渡します。OpenAI／ChatGPTが作った不透明な暗号化項目は変更せず、そのまま
純正上流へ渡します。秘密が不要な通常のGPT要求ではKeychain読出しを要求しません。

これにより、DeepSeekからGPT-5.6 Solなどへ切り替えた際の
`invalid_encrypted_content`／`Encrypted content could not be decrypted or parsed` を防ぎます。

### DeepSeek経路の remote compact と tool call 正規化

Codex Desktop が DeepSeek V4 Flash を使うとき、ルーターは次を行います。

1. `/v1/responses/compact` を DeepSeek の通常 Responses 要約へマップし、結果を
   ルーター密封の `compaction` へ戻す。
2. OpenAI 専用の `encrypted_content` と平文のない `agent_message` を除去する。
3. Codex の `custom_tool_call` / `custom_tool_call_output`（`apply_patch`、`exec` など）と
   `local_shell_call` 系を、DeepSeek が受け付ける `function_call` /
   `function_call_output` の整合したペアへ変換する。

これにより次の実行時エラーを防ぎます。

- `Error running remote compact task: ... Encrypted function output content could not be decrypted or decoded`
- `No tool call found for tool output with call_id ...`

加えて、MultiAgent V2 が `encrypted_content` に平文ステータス文を入れてしまった履歴では、
native GPT（`gpt-5.6-sol` など）の remote compact / 親ターンも同じ復号エラーになります。
ルーターは `gAAAA...` などの不透明な暗号文はそのまま残し、平文が誤って入った
`encrypted_content` だけを `input_text`（または通常の user message）へ修復します。

### Claude Hybridの成功構成

- Codeタブが子プロセスへ `ANTHROPIC_BASE_URL=http://127.0.0.1:10102` と
  `ANTHROPIC_UNIX_SOCKET`（Hybrid ルーターの Unix ソケット）を渡す。
- 通常のClaudeモデルはAnthropicへ転送し、4.6 の2エイリアスだけを外部APIへ振り分け。
  DeepSeek は公式 Anthropic 互換。ChatGPT サブスクリプションは Claude.app のピッカー枠に載せない。
- `ANTHROPIC_UNIX_SOCKET` は Claude Code の Remote Control 判定用。
  橋は `wss://bridge.claudeusercontent.com` のままなので、外部モデル選択と共存する。
- Webピッカーの表示は Sonnet 4.6→DeepSeek V4 Flash、Opus 4.6→DeepSeek V4 Pro (1M)。
- Fable、Opus 4.8、Opus 5、Sonnet 5、Haiku 4.5は純正経路のまま。Opus 4.5 / Sonnet 4.5 / Opus 4.7 も純正。
- `model: "haiku"` のサブエージェントは DeepSeek Flash。名前付きエージェント
  `deepseek-v4-flash` / `deepseek-v4-pro` も呼べる。
  グローバルなサブエージェント既定は変更しない。
- 公式ユーザーデータディレクトリを共有し、セッションを共存。
- APIキーは共通のユーザーKeychain項目からhelper経由で読み、ファイルへ保存しない。
- Official ソースは不変。Hybrid はAPFS clone-on-writeで作り、一時ディスク消費を抑える。

### 公式Claude更新後の再構築

UPDATE CONTRACT

- Daily app: `/Applications/Claude.app` (= Hybrid, display name Claude)
- Pristine source: `~/Applications/Claude Official.app` (Apple-signed, never ASAR-patched)
- Do not use in-app updater on Hybrid
- Update = download official zip from RELEASES.json → replace Official source → `update-claude-hybrid --check` → `update-claude-hybrid --apply` → `prefer-claude-hybrid`
- On exact-anchor failure: stop; do not fuzzy-patch; update `claude-hybrid/config/claude-hybrid.json` anchors and `patchVersion` first
- Do not delete sessions, Keychain, or `before-*` backups without explicit user approval

#### 実証済み手順（Claude 1.28929.0 / patch 2026-08-18.3）

1. `https://downloads.claude.ai/releases/darwin/universal/RELEASES.json` から最新 zip URL を取得する。
2. 展開した `Claude.app` を `codesign --verify --deep --strict` と公証（Developer ID）で確認する。
3. 両アプリを完全終了する（`pgrep -x Claude` が空）。
4. 既存の `~/Applications/Claude Official.app` を
   `Claude Official.app.before-<version>-<timestamp>` へ退避し、新公式で置換する。
5. `update-claude-hybrid --check` を実行する。
6. アンカー不一致なら Official ASAR から
   `ANTHROPIC_BASE_URL:e.apiHost` と `WebContentsView` / `CLAUDE_AI_WEB` の exact 1 箇所を取り直し、
   `patchVersion` を上げてから再 check する（fuzzy patch 禁止）。
7. `update-claude-hybrid --apply` → 無課金検証通過を確認する。
8. `prefer-claude-hybrid` で Launch Services を Hybrid 優先へ戻す。
9. `/Applications/Claude.app` を開き、Safe Storage「常に許可」、4.6 枠の DeepSeek と
   Fable 5 / Opus 4.8 / Opus 5 の純正維持を確認する。

`prefer-claude-hybrid` は `# Managed by deepseek-codex-claude-installer.` マーカー必須。
マーカー無しだと `--apply` が上書き拒否で止まる。

インストーラーは `update-claude-hybrid` コマンドと `claude-hybrid-update` スキルを導入します。
`--check` は公式版とHybridのバージョン／ビルド／パッチ版、公式署名、厳密な2つのアンカーを
読み取るだけです。`--apply` は両アプリが終了し、導入先ユーザーのKeychain資格情報がある場合
だけ、公式版から新しいHybridを構築して無課金検証まで実行します。アンカー変更時は安全に
停止し、近似パッチは行いません。詳細は
`CHANGE_SPEC-claude-app-layout-and-updates.md` §5 を正本とする。

### DeepSeek V4の追加サブエージェント

`[agents.deepseek-v4]` が端末固有のagent profileを参照し、その子だけを
`deepseek/deepseek-v4-flash`、`max`へ切り替えます。親がGPTでも明示的に呼び出せます。
DeepSeekはメインピッカーにも残り、全サブエージェントの既定モデルは変更しません。実API課金を
伴うため、利用者がDeepSeek委譲を明示した場合または課金委譲を承認した場合だけ呼び出します。

Claude Code では `~/.claude/agents/` に次の名前付きエージェントも入れます。
`deepseek-v4-flash`、`deepseek-v4-pro`。
`model: "haiku"` は従来どおり DeepSeek Flash です。opus / sonnet エイリアスは純正のままです。

### Cursor CLI（サブスクリプション）の外部呼び出し

Composer 2.5 に公開 Messages API はなく、Grok を xAI キーで呼ぶと別課金になります。
そのため Cursor Grok 4.6 と Composer 2.5 は Claude.app のピッカー枠を借りず、
ログイン済み Cursor CLI（`agent`）をラップします。

- コマンド: `cursor-cli-delegate`、`cursor-grok-4-6`、`cursor-composer-2-5`
- モデル ID: `cursor-grok-4.6-high-fast`、`composer-2.5-fast`
- 認証: `agent login`。ラッパーは `CURSOR_API_KEY` を外してサブスク経路を強制する
- Claude Code エージェント `cursor-grok-4-6` / `cursor-composer-2-5` は自分で実装せず CLI に委譲する
- スキル: `cursor-cli-delegation`（Codex と Claude Code の両方）
- print モードは書き込み可能なので、プロンプトは bounded task に限定する

課金実呼び出しは利用者の明示承認前に行いません。`cursor-cli-delegate --check-auth` と
`--dry-run` は無課金です。

### ChatGPT サブスク（Codex CLI）の外部呼び出し

GPT-5.6 Sol / Luna を Claude.app のピッカー枠に載せることはしません。
ChatGPT サブスクリプションは OpenAI API キーではないため、ログイン済み Codex CLI
（`codex exec`）をラップします。

- コマンド: `codex-cli-delegate`、`gpt-5-6-sol`、`gpt-5-6-luna`
- モデル ID: `gpt-5.6-sol`、`gpt-5.6-luna`
- 認証: `codex login`（ChatGPT）。ラッパーは `OPENAI_API_KEY` を外してサブスク経路を強制する
- Claude Code のスラッシュコマンド `/gpt-5-6-sol` / `/gpt-5-6-luna` と
  同名エージェントは自分で実装せず CLI に委譲する。以前の Hybrid API エージェントは置き換える
- スキル: `chatgpt-codex-delegation`（Codex と Claude Code の両方）
- exec は書き込み可能なので、プロンプトは bounded task に限定する

課金実呼び出しは利用者の明示承認前に行いません。`codex-cli-delegate --check-auth` と
`--dry-run` は無課金です。

## 実行順序

### 1. GitHub から永続 clone

正本は GitHub です。別経路の tar.gz より、次を使います。

```bash
git clone https://github.com/kit4000/deepseek-codex-claude-installer.git \
  "${HOME}/Applications/deepseek-codex-claude-installer"
cd "${HOME}/Applications/deepseek-codex-claude-installer"
```

`/tmp` や Downloads へ clone しません。ラッパーは clone した絶対パスを指すため、
導入後もこのディレクトリを残します。既存の永続 clone がある場合は上書き clone せず、
そのディレクトリで `git pull` するか、新しい空ディレクトリへ clone します。

導入先ユーザーの前提を確認し、足りないものは本人に依頼します。

- Node.js 20 以上（追加の `npm install` は不要）
- 公式 Claude（未パッチ）
- Codex CLI と `codex login`（ChatGPT サブスク。API キーではない）
- Cursor CLI（`agent`）と `agent login`
- DeepSeek API キーは次の `store-key` で本人が入力

任意のオフラインアーカイブを使う場合だけ、受け取った SHA-256 と照合してから
永続ディレクトリへ展開します。既存ディレクトリへ上書き展開しません。

```bash
shasum -a 256 /path/to/deepseek-codex-claude.tar.gz
mkdir -p "${HOME}/Applications/deepseek-codex-claude-installer"
tar -xzf /path/to/deepseek-codex-claude.tar.gz -C "${HOME}/Applications"
cd "${HOME}/Applications/deepseek-codex-claude-installer"
```

### 2. 静的テストと事前検査

```bash
npm test
npm run preflight
```

任意で `npm run verify:bundle` を実行し、`INSTALLER_MANIFEST.json` のSHA-256一覧と
clone 内容を照合できます。これが失敗したコピーは実行しません。

`npm test` はCodexルーター、Claude Hybrid、統合契約を検査します。特に次が必須です。

- native GPTでルーター製コンパクションだけを復元するテスト
- ChatGPT製暗号項目を温存するテスト
- コンパクションがなければ秘密を要求しないテスト
- Claude 4.6 / 4.8 / 4.7エイリアスとFable／Opus 5温存テスト

`preflight` の `fail` は一件でも停止条件です。未保存キーと、未起動の10102ルーターは
この段階だけ `warn` を許容します。Claudeのパッチアンカーが見つからない場合は、現在の
Claudeバージョンへ対応するソース・テストを別途作り直す必要があります。

### 3. 導入先ユーザーによるキー登録

```bash
npm run store-key
```

入力は画面に表示されません。保存先は現在のログインユーザーのKeychain内の次の項目です。

```text
service: com.local.codex-native-model-router.deepseek
account: api-key
```

既存項目の更新時も、利用者に確認せず別端末の値を再利用してはいけません。

### 4. 導入と無課金検証

```bash
npm run install
npm run verify
```

`install` はCodexのカタログ／10100ルーターを導入した後、Claudeの10102ルーターとHybrid
を `/Applications/Claude.app` に導入し、最後に更新スキル、更新コマンド、Launch Services
優先コマンド、DeepSeek V4 agent profile、Cursor CLI ラッパー、ChatGPT サブスクの
Codex CLI ラッパー（`/gpt-5-6-sol` / `/gpt-5-6-luna`）を登録します。
Codex設定は書込み直前に端末内バックアップを作ります。Claude Hybridが
既にある場合は端末内バックアップへrenameしてから新しいコピーへ切り替えます。

空き容量が少なくてもAPFS clone-on-writeを使いますが、ファイルシステムが対応しない、または
ASAR再パック領域が不足する場合は停止します。古いバックアップをエージェント判断で削除しません。

### 5. 利用者による再起動とUI確認

1. Codex Desktopを完全終了して再起動。
2. 既存タスクが見え、GPTモデルとDeepSeekモデルが共存することを確認。
3. 既存タスクをGPT→DeepSeek→GPTと切り替え、暗号化コンパクションエラーがないことを確認。
4. 両方のClaudeを完全終了し、`/Applications/Claude.app` を開く。
5. `Claude Safe Storage` の確認へログインパスワードを入力し「常に許可」を選ぶ。
6. Codeタブの一覧でFable 5とOpus 4.8とOpus 5が残り、DeepSeek Pro／Flashが 4.6 枠にあることを確認。
7. ProとFlashをそれぞれ選択でき、同じユーザーの既存Codeセッションが見えることを確認。
8. Codex再起動後、スキル一覧に `claude-hybrid-update`、`deepseek-v4-delegation`、
   `cursor-cli-delegation`、`chatgpt-codex-delegation` があり、利用可能なagent typeに
   `deepseek-v4` が追加されていることを確認。
   `cursor-cli-delegate --check-auth` がログイン済みアカウントを返すこと。
   `codex-cli-delegate --check-auth` が ChatGPT ログインを返すこと。
9. Claude Code は新しいセッションを開き、`/cursor-grok-4-6`、`/cursor-composer-2-5`、
   `/gpt-5-6-sol`、`/gpt-5-6-luna` が親モデルへ実装させず CLI へ委譲することを確認。

UI確認を静的なモデルカタログの存在だけで代替しません。

### 6. 課金疎通（明示承認後だけ）

```bash
npm run smoke -- --allow-billing
```

Codexは `deepseek/deepseek-v4-flash` を `max` で呼び `ROUTER_OK` を、Claude Hybridは
4.6 Flashエイリアス経由で `DEEPSEEK_HYBRID_OK` を確認します。Claudeの純正経路はダミー
トークンによる401／403等を期待し、実ユーザーのOAuthトークンを抽出しません。

## 完了条件

- 全テストと無課金検証が成功。
- 10100と10102が期待するルーターとして応答。
- 再起動後もCodex純正GPT／DeepSeek、Claude純正／DeepSeekが共存。
- GPT復帰時に暗号化コンパクションエラーが再発しない。
- ClaudeでFable 5とOpus 4.8とOpus 5を失わず、4.6枠のPro／Flashを選択可能。
- `~/Applications/Claude Official.app` の署名対象ファイルを一切変更していない。
- `/Applications/Claude.app` が Hybrid マーカー、表示名 `Claude`、自動更新無効を持つ。
- `prefer-claude-hybrid` が Official を unregister し Hybrid を登録する。
- 認証情報、セッション、バックアップ、ログを配布物へ含めていない。
- 正本は `https://github.com/kit4000/deepseek-codex-claude-installer` の clone であり、
  URL だけ渡されたエージェントが AGENT_HANDOFF に従って導入できる。
- DeepSeekはメイン選択可能なまま、`deepseek-v4` サブエージェントも呼び出せる。
- `cursor-cli-delegate --check-auth` が成功し、Grok 4.6 / Composer 2.5 は Cursor
  サブスクの CLI ラッパーとして呼べる。Claude.app ピッカー枠は増やしていない。
- `codex-cli-delegate --check-auth` が成功し、GPT-5.6 Sol / Luna は ChatGPT
  サブスクの Codex CLI ラッパーとして呼べる。Claude.app ピッカー枠は増やしていない。
- `update-claude-hybrid --check` が公式版とHybridの更新状態を返す。
- 課金テストを行った場合は、事前の明示承認と両方の期待文字列がある。

## ロールバック境界

Codexはインストール出力の正確な `backupPath` を使い、10100 LaunchAgentを停止してから
戻します。Claude Hybrid は `Claude.app.before-deepseek-*`、純正ソースは
`Claude Official.app.before-*` の当該端末バックアップだけを使います。認証ファイル、
セッションディレクトリ、Keychain項目を削除して
ロールバックしません。バックアップ削除やKeychain削除は、この導入とは別の破壊的操作として
利用者の明示承認が必要です。
