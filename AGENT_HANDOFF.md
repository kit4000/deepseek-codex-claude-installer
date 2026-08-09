# 外部エージェント向け実行契約

この文書は、人または外部AIエージェントが、別のmacOS環境へ統合インストーラーを安全に
適用するための契約です。静的ファイルの存在だけで成功とせず、無課金検証、再起動後の表示、
実応答を段階的に確認します。

## 絶対条件

1. APIキーを推測・抽出・コピーしない。MacBook Airや別ユーザーのKeychain、設定、ログ、
   会話から取得してはいけません。`npm run store-key` で導入先ユーザー本人に非表示入力を求めます。
2. 公式の中身は変更しない。純正実体は `~/Applications/Claude Official.app` で、
   Apple署名・未パッチのまま保持します。パッチ対象の日常アプリは `/Applications/Claude.app` です。
3. `~/.codex/auth.json`、CodexのタスクDB／セッション、`~/.claude`、Claudeのユーザーデータ、
   Keychain項目を移送、削除、全面置換しません。
4. Fable 5 と Opus 4.8 は純正Claudeとして維持します。DeepSeekへ割り当てるのは
   Opus 4.6（Pro）とSonnet 4.6（Flash）の2枠だけです。
5. 課金テストは利用者の明示承認前に実行しません。`--allow-billing` は承認を記録した
   エージェントだけが付けます。
6. 署名、ASAR、バージョン固有アンカーの検査が失敗したら停止します。文字列の近似一致や
   未検証の別チャンクを勝手にパッチしません。
7. Codex／Claudeを強制終了せず、再起動とKeychainの「常に許可」は利用者へ依頼します。
8. DeepSeek V4をサブエージェントとして追加しても、親モデル、メインピッカー、既存の
   サブエージェント既定値を置換しません。

## 組み込まれた重要修正

### GPTへ戻すときの暗号化コンパクション

DeepSeek経路が作る `codex-native-model-router:compaction:v1:` 項目は、同じ端末のDeepSeek
Keychain資格情報から導出した鍵でルーターが復号し、平文の要約メッセージへ変換してから
純正GPT上流へ渡します。OpenAI／ChatGPTが作った不透明な暗号化項目は変更せず、そのまま
純正上流へ渡します。秘密が不要な通常のGPT要求ではKeychain読出しを要求しません。

これにより、DeepSeekからGPT-5.6 Solなどへ切り替えた際の
`invalid_encrypted_content`／`Encrypted content could not be decrypted or parsed` を防ぎます。

### Claude Hybridの成功構成

- Codeタブが子プロセスへ渡す `ANTHROPIC_BASE_URL` だけを `127.0.0.1:10102` に変更。
- 通常のClaudeモデルはAnthropicへ転送し、4.6の2エイリアスだけをDeepSeek公式
  Anthropic互換APIへ振り分け。
- Webピッカーの表示は Sonnet 4.6→DeepSeek V4 Flash、Opus 4.6→DeepSeek V4 Pro (1M)。
- Fable、Opus 4.8、Opus 5、Sonnet 5、Haiku 4.5は純正経路のまま。
- 公式ユーザーデータディレクトリを共有し、セッションを共存。
- APIキーは共通のユーザーKeychain項目からhelper経由で読み、ファイルへ保存しない。
- Official ソースは不変。Hybrid はAPFS clone-on-writeで作り、一時ディスク消費を抑える。

### 公式Claude更新後の再構築

UPDATE CONTRACT

- Daily app: `/Applications/Claude.app` (= Hybrid, display name Claude)
- Pristine source: `~/Applications/Claude Official.app` (Apple-signed, never ASAR-patched)
- Do not use in-app updater on Hybrid
- Update = replace Official source → `update-claude-hybrid --check` → `update-claude-hybrid --apply` → `prefer-claude-hybrid`
- On exact-anchor failure: stop; do not fuzzy-patch
- Do not delete sessions, Keychain, or `before-*` backups without explicit user approval

インストーラーは `update-claude-hybrid` コマンドと `claude-hybrid-update` スキルを導入します。
`--check` は公式版とHybridのバージョン／ビルド／パッチ版、公式署名、厳密な2つのアンカーを
読み取るだけです。`--apply` は両アプリが終了し、導入先ユーザーのKeychain資格情報がある場合
だけ、公式版から新しいHybridを構築して無課金検証まで実行します。アンカー変更時は安全に
停止し、近似パッチは行いません。

### DeepSeek V4の追加サブエージェント

`[agents.deepseek-v4]` が端末固有のagent profileを参照し、その子だけを
`deepseek/deepseek-v4-flash`、`max`へ切り替えます。親がGPTでも明示的に呼び出せます。
DeepSeekはメインピッカーにも残り、全サブエージェントの既定モデルは変更しません。実API課金を
伴うため、利用者がDeepSeek委譲を明示した場合または課金委譲を承認した場合だけ呼び出します。

## 実行順序

### 1. 配布物の検証と永続配置

送付元から別経路で受け取ったSHA-256と照合し、`/tmp` ではない永続ディレクトリへ展開します。
既存ディレクトリへ上書き展開しません。

```bash
shasum -a 256 /path/to/deepseek-codex-claude.tar.gz
mkdir -p "${HOME}/Applications/deepseek-codex-claude-installer"
tar -xzf /path/to/deepseek-codex-claude.tar.gz -C "${HOME}/Applications"
cd "${HOME}/Applications/deepseek-codex-claude-installer"
```

### 2. 静的テストと事前検査

```bash
npm run verify:bundle
npm test
npm run preflight
```

`verify:bundle` は展開後の各ファイルを `INSTALLER_MANIFEST.json` のSHA-256一覧と照合します。
これが失敗した配布物は実行しません。`npm test` はCodexルーター、Claude Hybrid、統合契約を
検査します。特に次が必須です。

- native GPTでルーター製コンパクションだけを復元するテスト
- ChatGPT製暗号項目を温存するテスト
- コンパクションがなければ秘密を要求しないテスト
- Claude 4.6エイリアスとFable／Opus 4.8温存テスト

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
優先コマンド、DeepSeek V4 agent profileを登録します。
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
6. Codeタブの一覧でFable 5とOpus 4.8が残り、DeepSeek Pro／Flashが「他のモデル」にあることを確認。
7. ProとFlashをそれぞれ選択でき、同じユーザーの既存Codeセッションが見えることを確認。
8. Codex再起動後、スキル一覧に `claude-hybrid-update` と `deepseek-v4-delegation` があり、
   利用可能なagent typeに `deepseek-v4` が追加されていることを確認。

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
- ClaudeでFable 5とOpus 4.8を失わず、4.6枠のPro／Flashを選択可能。
- `~/Applications/Claude Official.app` の署名対象ファイルを一切変更していない。
- `/Applications/Claude.app` が Hybrid マーカー、表示名 `Claude`、自動更新無効を持つ。
- `prefer-claude-hybrid` が Official を unregister し Hybrid を登録する。
- 認証情報、セッション、バックアップ、ログを配布物へ含めていない。
- DeepSeekはメイン選択可能なまま、`deepseek-v4` サブエージェントも呼び出せる。
- `update-claude-hybrid --check` が公式版とHybridの更新状態を返す。
- 課金テストを行った場合は、事前の明示承認と両方の期待文字列がある。

## ロールバック境界

Codexはインストール出力の正確な `backupPath` を使い、10100 LaunchAgentを停止してから
戻します。Claude Hybrid は `Claude.app.before-deepseek-*`、純正ソースは
`Claude Official.app.before-*` の当該端末バックアップだけを使います。認証ファイル、
セッションディレクトリ、Keychain項目を削除して
ロールバックしません。バックアップ削除やKeychain削除は、この導入とは別の破壊的操作として
利用者の明示承認が必要です。
