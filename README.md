# AI アバタースタジオ v3

画像＋音声からAI全身動画を生成するWebツール。  
fal.ai の **OmniHuman v1.5** で全身アニメーション（顔＋体＋ジェスチャー）を生成します。

## 機能

- 📸 画像アップロード（自動圧縮）
- 🎤 3つの音声入力方式
  - **ElevenLabs** — 高品質AIボイス
  - **VOICEVOX** — 日本語ローカルTTS
  - **マイク録音** — ブラウザ内録音
- 🎬 OmniHuman v1.5 による全身動画生成
- 📥 生成動画のプレビュー＆ダウンロード

## 必要なもの

- **Node.js** 18+
- **fal.ai APIキー** — [fal.ai](https://fal.ai) で取得
- **ElevenLabs APIキー**（任意）— [elevenlabs.io](https://elevenlabs.io) で取得
- **VOICEVOX**（任意）— ローカル起動でポート50021

## セットアップ

```bash
npm install
npm start
```

ブラウザで http://localhost:3001 を開き、APIキーを設定して使用開始。

## ファイル構成

| ファイル | 内容 |
|----------|------|
| `server.js` | Node.jsプロキシサーバー（fal.ai / ElevenLabs / VOICEVOX） |
| `app.js` | フロントエンドロジック |
| `index.html` | UI（HTML + CSS） |

## 技術スタック

- フロントエンド: Vanilla HTML/CSS/JS
- バックエンド: Node.js (標準ライブラリのみ)
- AI生成: fal.ai OmniHuman v1.5
- 音声: ElevenLabs / VOICEVOX
