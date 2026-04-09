# AI Avatar Studio v3 — OmniHuman

## プロジェクト概要
画像＋音声から fal.ai OmniHuman v1.5 で全身AI動画を生成するWebアプリ。

## アーキテクチャ
- フロントエンド: Vanilla HTML/CSS/JS（フレームワークなし）
- バックエンド: Node.js（標準ライブラリのみ、Express不使用）
- AI生成: fal.ai OmniHuman v1.5（Queue API経由）
- 音声: ElevenLabs API / VOICEVOX（ローカル） / ブラウザ録音

## ファイル構成（3ファイルのみ）
- `server.js` — Node.jsプロキシサーバー。fal.ai/ElevenLabs/VOICEVOXへの中継
- `app.js` — フロントエンドロジック全体（781行）
- `index.html` — UI + CSS（483行）

## コマンド
- 起動: `npm start`（= `node server.js`）
- ポート: http://localhost:3001
- 依存: `npm install`（@fal-ai/client は package.json にあるが未使用）

## 開発ルール
- 応急処置禁止・根本修正のみ
- 3ファイル構成を維持（分割しない）
- 新しいnpm依存を追加しない
- CSSの変更は明示的に依頼された場合のみ

## API通信フロー
1. フロント → POST /api/generate → server.js
2. server.js → fal.ai Storage Upload (画像・音声)
3. server.js → POST queue.fal.run/fal-ai/bytedance/omnihuman/v1.5
4. フロント → GET /api/status/:requestId → server.js → queue.fal.run でポーリング
5. COMPLETED → 動画URL返却 → フロントでプレビュー

## 既知の問題
- app.js の関数名・変数名に旧モデル名「SadTalker」が残っている（動作に影響なし、後日リネーム）
- package.json の "main": "app.js" は誤り（server.js が正しい）
