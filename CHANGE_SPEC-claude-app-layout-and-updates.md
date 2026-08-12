# 変更指示書: Claude.app 配置（Hybrid 昇格）とアップデート手順の明確化

- 対象: DeepSeek Codex + Claude Hybrid 統合インストーラー
- 作成日: 2026-08-09
- 背景端末での実証済み構成: Claude Desktop `1.28929.0` / Hybrid patch `2026-08-12.1`
- 目的: ランチャーが純正を開いてしまう問題を解消し、公式更新と Hybrid 再構築の手順をインストーラー契約として固定する

---

## 1. 背景と問題

### 1.1 旧構成の問題

旧デフォルト:

| 役割 | パス | 表示名 |
|------|------|--------|
| 純正（未改造） | `/Applications/Claude.app` | Claude |
| Hybrid（DeepSeek 経路） | `~/Applications/Claude Hybrid.app` | Claude Hybrid |

両方とも Bundle ID は `com.anthropic.claudefordesktop`。  
Launch Services / Raycast / Alfred 等は **純正 `/Applications/Claude.app` を優先**するため、利用者は Hybrid を開けない。

### 1.2 追加で起きた更新失敗

Hybrid を `/Applications/Claude.app` に昇格した後も、次が重なると公式のアプリ内更新が失敗する。

1. Hybrid の `LSEnvironment.DISABLE_AUTOUPDATER=1`
2. Hybrid は adhoc 署名（Apple 署名の純正ではない）
3. Squirrel/ShipIt の更新先が常に `/Applications/Claude.app`
4. 壊れた `ShipItState.plist`（欠落した update キャッシュを指したまま）

→ 「Claude の最新アップデートに失敗する」は、**Hybrid を日常アプリとして `/Applications/Claude.app` に置いた結果として起きうる**。  
アプリ内自動更新で Hybrid を上げる設計にしてはいけない。

---

## 2. 目標エンド状態（必須）

### 2.1 アプリ配置

| 役割 | パス | 表示名 (`CFBundleDisplayName`) | 署名 | 自動更新 |
|------|------|--------------------------------|------|----------|
| **日常利用（Hybrid）** | `/Applications/Claude.app` | `Claude` | adhoc | **無効** (`DISABLE_AUTOUPDATER=1`) |
| **純正ソース（未パッチ）** | `~/Applications/Claude Official.app` | `Claude`（純正のまま可） | Apple 署名を維持 | 使わない／パス指定でのみ開く |

制約:

- 公式アプリの**中身は改造しない**。移動・リネームのみ。
- Hybrid だけを ASAR パッチ対象にする。
- ユーザーデータは従来どおり  
  `~/Library/Application Support/Claude` を共有する。
- Bundle ID は両方とも `com.anthropic.claudefordesktop` のまま（セッション / Safe Storage 共有のため）。

### 2.2 Launch Services

- 日常起動の勝者は `/Applications/Claude.app`（Hybrid）。
- 純正 `Claude Official.app` は **Launch Services に登録しない**（または明示 unregister）。
- 理由: 同じ Bundle ID では Apple 署名の純正が勝ちやすく、ランチャー問題が再発する。
- 純正を開くときはフルパスのみ:

```bash
open "$HOME/Applications/Claude Official.app"
```

- 純正を一度開いた後にランチャーがずれたら、再優先コマンドを用意する（後述 `prefer-claude-hybrid`）。

### 2.3 表示名

- Hybrid の `CFBundleDisplayName` は **`Claude`**（`Claude Hybrid` にしない）。
- アプリバンドル名（Finder 上）も **`Claude.app`**。
- 内部識別用に `ClaudeHybridPatchVersion` は Info.plist に残す。

---

## 3. インストーラーへ入れるべき仕様変更

### 3.1 デフォルトパス（config）

`claude-hybrid/config/claude-hybrid.json`（および同等のテンプレート）:

```json
"app": {
  "source": "<home>/Applications/Claude Official.app",
  "target": "/Applications/Claude.app",
  "userDataDir": "<home>/Library/Application Support/Claude",
  "routerBaseUrl": "http://127.0.0.1:10102"
}
```

旧デフォルト（廃止）:

- source: `/Applications/Claude.app`
- target: `<home>/Applications/Claude Hybrid.app`

互換: 環境変数 `CLAUDE_HYBRID_SOURCE` / `CLAUDE_HYBRID_TARGET` は残してよい。

### 3.2 初回 install の配置アルゴリズム

`install`（Claude 側）は次を正式手順にする。

1. 公式 Claude と Hybrid 相当プロセスが起動中なら **停止して利用者に終了を依頼**（エージェントは原則 kill しない。利用者が承認した作業時のみ例外可）。
2. 既存の純正 `/Applications/Claude.app` があり、かつ Hybrid マーカー（`ClaudeHybridPatchVersion`）が無い場合:
   - `/Applications/Claude.app` → `~/Applications/Claude Official.app` へ退避  
   - 既に Official がある場合はタイムスタンプ付きバックアップへ rename（上書き禁止）。
3. Hybrid を `target`（`/Applications/Claude.app`）として公式ソースから構築。
4. `CFBundleDisplayName = "Claude"`。
5. Launch Services:
   - `lsregister -u` で Official を unregister
   - `lsregister -f -R` で Hybrid（`/Applications/Claude.app`）を登録
6. ヘルパーコマンド `prefer-claude-hybrid` を `~/.local/bin` に導入。

旧 `~/Applications/Claude Hybrid.app` が残っている移行ケース:

- Hybrid マーカーがあるなら `/Applications/Claude.app` へ昇格（または再構築）し、旧パスはバックアップ名へ退避。

### 3.3 `app-patch.mjs`

1. `updateInfoPlist(..., displayName, ...)` の displayName 既定を **`Claude`** にする（`"Claude Hybrid"` 禁止）。
2. `modelLabelPatch` は戻り値変数が `Z` 固定でないこと。  
   Claude 1.26832 系では `Y` に変わった。  
   アンカー末尾 `,ViewVar}` から変数名を抽出し、handler もそれに合わせる。
3. 近似パッチ禁止は維持（exact anchor のみ）。

### 3.4 preflight / verify / tests

- target 許可リストを新デフォルト中心に更新:
  - 必須: `/Applications/Claude.app`
  - 移行互換で旧 `~/Applications/Claude Hybrid.app` を残すなら「非推奨」と明記
- source は Apple 署名検証対象のまま（`Claude Official.app`）。
- テストの fixture パスを新配置に更新。
- `npm run verify` で「Hybrid が `/Applications/Claude.app` にあり、Official が source にある」ことを確認。

### 3.5 ドキュメント・契約の書き換え（必須）

次の文言を **全面置換**する。

| 文書 | 旧 | 新 |
|------|----|----|
| `AGENT_HANDOFF.md` | 公式 `/Applications/Claude.app` は変更しない。パッチ対象は `~/Applications/Claude Hybrid.app` | 公式**中身**は変更しない。純正実体は `~/Applications/Claude Official.app`。パッチ対象（日常アプリ）は `/Applications/Claude.app` |
| `README.md` / `claude-hybrid/README.md` | Hybrid.app を開く | `/Applications/Claude.app` を開く。純正は Official パス |
| `skills/claude-hybrid-update/SKILL.md` | Never modify `/Applications/Claude.app` | `/Applications/Claude.app` は Hybrid。純正は Official。純正の中身は改造しない。再構築は `update-claude-hybrid` のみ |
| install 完了 `next` メッセージ | Claude Hybrid.app を開く | `/Applications/Claude.app` を開く。更新は公式アプリ内更新ではなく §4 の手順 |

### 3.6 ヘルパーコマンド

`~/.local/bin/prefer-claude-hybrid`（install / install-extensions で配置）:

```sh
#!/bin/sh
set -e
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
OFFICIAL="${HOME}/Applications/Claude Official.app"
HYBRID="/Applications/Claude.app"
"$LSREGISTER" -u "$OFFICIAL" >/dev/null 2>&1 || true
"$LSREGISTER" -f -R "$HYBRID"
echo "Launch Services now prefers: $HYBRID"
```

任意で `update-claude-official` のような薄いラッパーを追加してもよい（実体は §4.2）。

---

## 4. アップデート方法（インストーラーが利用者・エージェントに示す正式手順）

### 4.1 原則（最重要）

1. **Hybrid（`/Applications/Claude.app`）のアプリ内「更新」は使わない**（無効化済み・失敗して正常）。
2. **純正ソースを先に最新化する**。
3. 両アプリを完全終了する。
4. `update-claude-hybrid --check` → 問題なければ `--apply`。
5. アンカー不一致なら **停止**（fuzzy patch 禁止）。インストーラー側の version-specific 更新が必要。
6. 必要なら `prefer-claude-hybrid`。
7. 課金スモークは別承認がない限り実行しない。

### 4.2 純正の最新化（推奨手順）

Anthropic の公開 release フィード例:

```text
https://downloads.claude.ai/releases/darwin/universal/RELEASES.json
```

手順:

```bash
# 1) 最新 zip URL を RELEASES.json から取得
# 2) 展開して署名検証
codesign --verify --deep --strict "/path/to/staged/Claude.app"

# 3) Claude を完全終了

# 4) 純正ソースを置換（既存 Official はタイムスタンプ付きバックアップへ）
mv "$HOME/Applications/Claude Official.app" \
   "$HOME/Applications/Claude Official.app.before-<version>-<timestamp>"
cp -R "/path/to/staged/Claude.app" \
   "$HOME/Applications/Claude Official.app"

# 5) Hybrid 再構築
update-claude-hybrid --check
update-claude-hybrid --apply   # 両方終了済みであること

# 6) ランチャー優先を戻す
prefer-claude-hybrid
```

ShipIt が壊れている場合（任意の清掃）:

```bash
rm -f "$HOME/Library/Caches/com.anthropic.claudefordesktop.ShipIt/ShipItState.plist"
rm -rf "$HOME/Library/Caches/com.anthropic.claudefordesktop.ShipIt/update."*
```

※ Application Support のセッションディレクトリは消さない。

### 4.3 エージェント向け短契約（AGENT_HANDOFF に追記）

```text
UPDATE CONTRACT
- Daily app: /Applications/Claude.app (= Hybrid, display name Claude)
- Pristine source: ~/Applications/Claude Official.app (Apple-signed, never ASAR-patched)
- Do not use in-app updater on Hybrid
- Update = replace Official source → update-claude-hybrid --apply → prefer-claude-hybrid
- On exact-anchor failure: stop; do not fuzzy-patch
- Do not delete sessions, Keychain, or before-deepseek-* backups without explicit user approval
```

### 4.4 利用者向け UI 文言（README 用ドラフト）

> 普段使う Claude は `/Applications/Claude.app` です（内部的には DeepSeek 対応 Hybrid）。  
> アプリ内の「更新」は使いません。  
> 公式が新しい版を出したら、純正ソースを更新したあとターミナルで  
> `update-claude-hybrid --apply` を実行してください。  
> ランチャーがずれたら `prefer-claude-hybrid` を実行してください。

---

## 5. Claude 版が変わったときのインストーラー保守

新バージョンで chunk 名や WebContentsView 変数が変わると `--apply` は安全に止まる。  
その場合の作業:

1. 新 Official の `app.asar` で次を exact 1 箇所検索する。
   - `ANTHROPIC_BASE_URL:e.apiHost` → `patchFile` / `patchFrom`
   - `WebContentsView(e),t.c(<VAR>.webContents,t.n.CLAUDE_AI_WEB),<VAR>.webContents.setMaxListeners(20),<VAR>}`  
     → `modelLabelPatchFile` / `modelLabelPatchFrom`
2. `patchVersion` を上げる（例: `2026-08-09.1`）。
3. テストと `verify:bundle` / archive を更新。
4. 配布物を切り直す。

1.26832.0 で確認済みの例:

```text
patchFile: /.vite/build/index.chunk-KnwvxAXh.js
patchFrom: ANTHROPIC_BASE_URL:e.apiHost
modelLabelPatchFile: /.vite/build/index.chunk-CHjD_WiU.js
modelLabelPatchFrom: function ti(e){return J=new a.WebContentsView(e),t.c(J.webContents,t.n.CLAUDE_AI_WEB),J.webContents.setMaxListeners(20),J}
```

---

## 6. 受け入れ条件（Definition of Done）

- [ ] 新規 install 後、日常アプリが `/Applications/Claude.app` であり `ClaudeHybridPatchVersion` を持つ
- [ ] `CFBundleDisplayName` が `Claude`
- [ ] 純正が `~/Applications/Claude Official.app` にあり、ASAR 未パッチ・Apple 署名
- [ ] `open -b com.anthropic.claudefordesktop` が Hybrid を開く（Official を開かない）
- [ ] Hybrid に `DISABLE_AUTOUPDATER=1`
- [ ] `update-claude-hybrid --check` / `--apply` / `npm run verify` が新パスで通る
- [ ] README / AGENT_HANDOFF / skill が新アップデート手順を説明している
- [ ] `prefer-claude-hybrid` が導入されている
- [ ] 旧「Claude Hybrid.app を開く」系の誘導文言が残っていない
- [ ] アンカー失敗時に fuzzy patch せず停止するテストが残っている

---

## 7. ロールバック境界

- Hybrid のロールバック: `Claude.app.before-deepseek-*`（または同等バックアップ）を `/Applications/Claude.app` へ戻す
- 純正のロールバック: `Claude Official.app.before-*` を Official パスへ戻す
- 公式の中身を「修復のために書き換える」ことはしない
- セッション・Keychain はロールバック対象外（削除しない）

---

## 8. 実装時の推奨作業順（インストーラー改修者向け）

1. config デフォルトパス変更
2. install フロー（退避 Official → 構築 Hybrid → LS 登録）
3. displayName / modelLabelPatch 変数対応
4. preflight・verify・unit/integration テスト更新
5. `prefer-claude-hybrid` 追加
6. README / AGENT_HANDOFF / skill / 完了メッセージ更新
7. 実機: クリーン（または移行）install → ランチャー確認 → Official 差し替え → `--apply` → 再確認
8. `npm run archive` で配布物再生成（秘密・セッションを含めない）

---

## 9. この指示書でやらないこと

- 公式 Claude の ASAR / 署名対象ファイルの改造
- Bundle ID の変更
- Hybrid のアプリ内自動更新の再有効化
- アンカー不一致時の曖昧一致パッチ
- API キーの配布物への同梱

---

## 10. 参考: 実機で確認済みだった症状と対処

| 症状 | 原因 | 対処 |
|------|------|------|
| ランチャーがいつも純正を開く | 同 Bundle ID + `/Applications` の純正優先 | Hybrid を `/Applications/Claude.app` に置き、Official を unregister |
| アプリ内更新が失敗する | Hybrid の autoupdate 無効 + adhoc 署名 + ShipIt が `/Applications/Claude.app` を更新しようとする | アプリ内更新を使わず §4.2 |
| ShipIt: update bundle not found | 壊れた ShipItState | state / 欠けた update.* を削除 |
| `--apply` が止まる | 新 Claude で chunk / 変数名変更 | §5 でアンカー更新後に再配布 |
