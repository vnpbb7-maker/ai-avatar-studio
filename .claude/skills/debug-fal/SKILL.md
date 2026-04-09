---
name: debug-fal
description: fal.ai OmniHuman v1.5 の生成エラーをデバッグする。動画生成が失敗したとき、APIレスポンスエラーが発生したときに使用。
allowed-tools: Read, Bash, Edit, Grep
---

# fal.ai エラーデバッグ手順

## ステップ1: エラーログ確認
1. `npm start` でサーバー起動
2. ブラウザで http://localhost:3001 にアクセスして生成実行
3. server.js のコンソール出力から以下を確認:
   - [API] ファイルアップロードの成否
   - [API] OmniHuman Queue送信の HTTP ステータスとレスポンスbody
   - [status] ポーリングの HTTP ステータスとレスポンスbody

## ステップ2: API仕様照合
1. fal.ai公式ドキュメントを確認: https://fal.ai/models/fal-ai/bytedance/omnihuman/v1.5/api
2. server.js L241-247 の omniInput オブジェクトのフィールド名を仕様と比較
3. 差分があれば修正

## ステップ3: 修正と検証
1. server.js のみを修正（最小限の変更）
2. `npm start` で再起動
3. 720p・マイク録音で生成テスト
4. コンソールログで Queue 送信成功（200）→ ポーリング → COMPLETED を確認

## よくある原因
- omniInput のフィールド名が旧バージョンのまま
- resolution の値形式が変わった
- ホスト名が queue.fal.run → fal.run に変更された
- turbo_mode が廃止された
