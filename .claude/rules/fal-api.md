---
paths:
  - "server.js"
---

# fal.ai API 仕様・制約

## ホスト名
- ストレージアップロード: rest.fal.ai
- Queue送信: queue.fal.run
- 認証ヘッダー: `Authorization: Key {api_key}`

## OmniHuman v1.5 エンドポイント
- モデルパス: fal-ai/bytedance/omnihuman/v1.5
- Queue POST: https://queue.fal.run/fal-ai/bytedance/omnihuman/v1.5

## 必須確認事項（エラー発生時）
1. リクエストパラメータ名が最新API仕様と一致しているか
2. resolution の有効値（720p/1080pなのか数値なのか）
3. turbo_mode が現行バージョンで有効なパラメータか
4. image_url / audio_url のフィールド名が正しいか
5. queue.fal.run がまだ有効か（fal.run に統合されていないか）

## エラー対応早見表
| HTTP | 意味 | 対応 |
|------|------|------|
| 400 | パラメータ名/値が不正 | omniInput のフィールド名を最新仕様に合わせる |
| 401 | 認証エラー | Authorization ヘッダー形式を確認 |
| 404 | エンドポイントURLが違う | モデルパス・ホスト名を確認 |
| 422 | 必須パラメータ不足 | API仕様で必須項目を再確認 |

## アップロードフロー
1. POST rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3
2. PUT {upload_url} にファイルバイナリ送信
3. file_url を取得して Queue 送信時に使用
