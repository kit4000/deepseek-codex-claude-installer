# DeepSeek Codex + Claude Hybrid 統合インストーラー

正本は GitHub リポジトリです。外部エージェントには **この URL だけ** を渡してください。

https://github.com/kit4000/deepseek-codex-claude-installer

エージェントは clone した直後に [AGENT_HANDOFF.md](AGENT_HANDOFF.md) を全文読み、その停止条件と
完了条件に従って導入します。tar.gz や別端末のキーは使いません。

macOS上で次を共存させます。

- Codex Desktop / CLI の純正GPTモデル、既存タスク、ChatGPT認証
- CodexのDeepSeek V4 Flash / Pro経路
- DeepSeekで作った暗号化コンパクションをGPTへ戻す際の安全な復号・要約変換
- DeepSeek経路での remote compact、暗号化 function output 除去、Codex
  `custom_tool_call` の `function_call` 正規化
- 公式Claudeのアカウント・セッションと、Claude CodeタブのDeepSeek経路
- ClaudeのFable 5 / Opus 4.8 / Opus 5 / Sonnet 5 / Haiku 4.5を残し、Opus 4.6 を DeepSeek Pro、Sonnet 4.6 を DeepSeek Flash として使うモデル選択
- 公式Claude更新後にHybridを安全に再構築するコマンドとCodexスキル
- メインのモデル選択を変えず、DeepSeek を名前付きサブエージェントとしても呼べる設定
- ログイン済み Cursor CLI 経由で Grok 4.6 と Composer 2.5 をサブスク課金のまま外から呼ぶラッパー
- ログイン済み Codex CLI 経由で GPT-5.6 Sol / Luna を ChatGPT サブスク課金のまま外から呼ぶラッパー

普段使う `/Applications/Claude.app` は、表示名 `Claude` の DeepSeek 対応 Hybrid です。
純正実体は `~/Applications/Claude Official.app` に未パッチ・Apple署名のまま保持し、
ユーザー自身の `~/Library/Application Support/Claude` を共有します。DeepSeek
APIキーはリポジトリに含まず、導入先ユーザーに非表示入力を求め、macOS Keychainへ保存します。

## 導入（GitHub が正本）

`/tmp` へ clone しません。導入後もこのディレクトリを残します（ラッパーが絶対パスを参照します）。
追加の `npm install` は不要です（Node.js 20 以上）。

```bash
git clone https://github.com/kit4000/deepseek-codex-claude-installer.git \
  "${HOME}/Applications/deepseek-codex-claude-installer"
cd "${HOME}/Applications/deepseek-codex-claude-installer"
```

導入先ユーザー側の前提:

- 公式 Claude（未パッチ）が `/Applications/Claude.app` または後で Official にする純正アプリとしてある
- Codex CLI が入り、`codex login` が ChatGPT サブスクである（GPT スラッシュコマンド用）
- Cursor CLI（`agent`）が入り、`agent login` 済みである（Grok / Composer 用）
- DeepSeek API キーは本人が次の `store-key` で入力する。推測・転記しない

```bash
npm test
npm run preflight
npm run store-key
npm run install
npm run verify
```

`npm run verify:bundle` は clone 内容の改ざん検査です。必須ではありませんが、実行してよいです。

導入後はCodex Desktopを完全終了・再起動してください。Claudeは両アプリを完全終了してから
`/Applications/Claude.app` を開き、初回の `Claude Safe Storage` 確認で
「常に許可」を選びます。Claude Code の `/gpt-5-6-sol` と `/gpt-5-6-luna` は
新しいセッションで使います。

Hybrid のアプリ内「更新」は使いません。正式なアップデートパターンは次のとおりです。

```bash
# 1) 公式最新を取得
curl -fsSL https://downloads.claude.ai/releases/darwin/universal/RELEASES.json
# 2) zip を展開し、codesign / 公証を確認
# 3) 両アプリを完全終了
# 4) Official をバックアップして置換
mv "$HOME/Applications/Claude Official.app" \
  "$HOME/Applications/Claude Official.app.before-<version>-<timestamp>"
ditto /path/to/staged/Claude.app "$HOME/Applications/Claude Official.app"
# 5) Hybrid 再構築
update-claude-hybrid --check
update-claude-hybrid --apply   # 両方のClaudeを完全終了してから
prefer-claude-hybrid           # ランチャーが純正を選ぶ場合
```

アンカー不一致時は停止が正常です。近似パッチせず、Official ASAR から
`patchFile` / `modelLabelPatchFile` を取り直し、`patchVersion` を上げてから再実行します。
現行確認済み: Claude `1.28929.0` / Hybrid patch `2026-08-18.3`。詳細は
`CHANGE_SPEC-claude-app-layout-and-updates.md` §5。

Codexには `claude-hybrid-update`、`deepseek-v4-delegation`、`cursor-cli-delegation`、
`chatgpt-codex-delegation` のスキルを導入します。再起動後、DeepSeek はメインのモデルピッカーで
選べるほか、Claude Code では `deepseek-v4-flash` / `deepseek-v4-pro` として、Codex では明示的な
`agent_type="deepseek-v4"` としても呼び出せます。ChatGPT サブスクリプションの GPT-5.6 Sol /
Luna は Claude.app のピッカー枠ではなく、ログイン済み Codex CLI のラッパーです。Cursor Grok 4.6
と Composer 2.5 もピッカー枠ではなく、ログイン済み Cursor CLI のラッパーです。Claude Code では
新しいセッションで `/cursor-grok-4-6`、`/cursor-composer-2-5`、`/gpt-5-6-sol`、
`/gpt-5-6-luna` を使います。

```bash
cursor-cli-delegate --check-auth
cursor-grok-4-6 --workspace "$PWD" -- "bounded task"
cursor-composer-2-5 --workspace "$PWD" -- "bounded task"
codex-cli-delegate --check-auth
gpt-5-6-sol --workspace "$PWD" -- "bounded task"
gpt-5-6-luna --workspace "$PWD" -- "bounded task"
```

`CURSOR_API_KEY` と `OPENAI_API_KEY` は使いません。xAI 直呼びもしません。グローバルな
サブエージェント既定モデルは変更しません。

実APIを使う検証は課金されるため自動実行しません。利用者が明示承認した場合だけ実行します。

```bash
npm run smoke -- --allow-billing
```

外部エージェントは先に [AGENT_HANDOFF.md](AGENT_HANDOFF.md) を全文読み、その停止条件と
完了条件に従ってください。

## 任意: オフライン配布アーカイブ

```bash
npm run archive -- /path/outside/source/deepseek-codex-claude.tar.gz
```

許可リスト内のソースだけを `codex-router/` と `claude-hybrid/` にまとめ、秘密らしい文字列を
検査し、ファイル別SHA-256を `INSTALLER_MANIFEST.json` に記録します。展開後は
`npm run verify:bundle` で各ファイルを照合できます。認証、セッション、
バックアップ、ログ、既存アプリ本体は同梱しません。
