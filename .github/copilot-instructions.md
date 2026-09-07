# GitHub Copilot instructions

## Codex Desktop の外部モデル

Codex Desktop の DeepSeek / Ollama 対応を変更するときは、表示だけで成功と判断しない。次の契約を守る。

1. Codex のメインピッカーには、実際に upstream へ送信できるモデルだけを載せる。`pending`、`not enabled`、未提供 API のモデルを選択可能にしない。
2. 既定にする外部モデルは `router-config.json` で `priority: 0` とし、`mergeCatalog` はその値を保持する。生成後の JSON だけを手編集しない。
3. `codex app-server` の `model/list` を呼び、DeepSeek V4 Flash が `isDefault: true`、GPT-6 Astra が `isDefault: false` になることを確認する。カタログ上の表示順だけでは代替できない。
4. インストール時は `model = "deepseek/deepseek-v4-flash"` と `[features].external_migration = false` を原子的に設定する。
5. ローカルルーター `127.0.0.1:10100` はリモート SSH ホストから到達できない。`.codex-global-state.json` の `selected-project.type` が `remote` なら検証を失敗させ、利用者にローカルプロジェクトを選ばせる。ユーザーのリモート接続やプロジェクト履歴を勝手に削除しない。
6. Codex Desktop を再起動するときは、メインプロセスだけでなく補助プロセスの終了も確認する。終了前の補助プロセスが古い状態を再保存する可能性がある。
7. モデル切替後は、`config/batchWrite` 成功、`model/list` の `isDefault`、`thread/start` の `hostId=local`、`/v1/responses` の完了応答を同じ順序で確認する。
8. DeepSeek API キーを設定、ログ、テスト出力、コマンド引数へ書かない。Keychain の存在確認だけを行う。

## 必須検証

```bash
cd codex-router
npm test
npm run catalog
DEEPSEEK_VERIFY_SCOPE=codex npm run handoff:verify
```

手動確認では、新しいローカル会話を開き、DeepSeek V4 Flash を選択して送信前に Astra へ戻らないことを確認する。既存会話、リモートプロジェクト、API 直呼びだけの確認では完了としない。
