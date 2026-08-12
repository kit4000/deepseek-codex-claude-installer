# DeepSeek Codex + Claude Hybrid 統合インストーラー

macOS上で次を共存させる配布用バンドルです。

- Codex Desktop / CLI の純正GPTモデル、既存タスク、ChatGPT認証
- CodexのDeepSeek V4 Flash / Pro経路
- DeepSeekで作った暗号化コンパクションをGPTへ戻す際の安全な復号・要約変換
- DeepSeek経路での remote compact、暗号化 function output 除去、Codex
  `custom_tool_call` の `function_call` 正規化
- 公式Claudeのアカウント・セッションと、Claude CodeタブのDeepSeek経路
- ClaudeのFable 5 / Opus 4.8を残し、Opus 4.6だけをDeepSeek Pro、Sonnet 4.6だけをDeepSeek Flashとして使うモデル選択
- 公式Claude更新後にHybridを安全に再構築するコマンドとCodexスキル
- メインのモデル選択を変えず、DeepSeek V4 Flashを `deepseek-v4` サブエージェントとしても呼べる設定

普段使う `/Applications/Claude.app` は、表示名 `Claude` の DeepSeek 対応 Hybrid です。
純正実体は `~/Applications/Claude Official.app` に未パッチ・Apple署名のまま保持し、
ユーザー自身の `~/Library/Application Support/Claude` を共有します。DeepSeek
APIキーは配布物に含まず、導入先ユーザーに非表示入力を求め、macOS Keychainへ保存します。

## 標準手順

```bash
npm run verify:bundle
npm test
npm run preflight
npm run store-key
npm run install
npm run verify
```

導入後はCodex Desktopを完全終了・再起動してください。Claudeは両アプリを完全終了してから
`/Applications/Claude.app` を開き、初回の `Claude Safe Storage` 確認で
「常に許可」を選びます。

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
現行確認済み: Claude `1.28929.0` / Hybrid patch `2026-08-12.1`。詳細は
`CHANGE_SPEC-claude-app-layout-and-updates.md` §5。

Codexには `claude-hybrid-update` と `deepseek-v4-delegation` の2スキルを導入します。
再起動後、DeepSeekはメインのモデルピッカーで従来どおり選択できるほか、明示的な
`agent_type="deepseek-v4"` としても呼び出せます。グローバルなサブエージェント既定モデルは
変更しません。

実APIを使う検証は課金されるため自動実行しません。利用者が明示承認した場合だけ実行します。

```bash
npm run smoke -- --allow-billing
```

外部エージェントは先に [AGENT_HANDOFF.md](AGENT_HANDOFF.md) を全文読み、その停止条件と
完了条件に従ってください。

## 配布アーカイブ作成

```bash
npm run archive -- /path/outside/source/deepseek-codex-claude.tar.gz
```

許可リスト内のソースだけを `codex-router/` と `claude-hybrid/` にまとめ、秘密らしい文字列を
検査し、ファイル別SHA-256を `INSTALLER_MANIFEST.json` に記録します。展開後は
`npm run verify:bundle` で各ファイルを照合できます。認証、セッション、
バックアップ、ログ、既存アプリ本体は同梱しません。
