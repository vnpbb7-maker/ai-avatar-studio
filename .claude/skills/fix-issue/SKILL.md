---
name: fix-issue
description: GitHubイシューを分析・修正するワークフロー
disable-model-invocation: true
allowed-tools: Read, Bash, Edit, Grep, Glob
---

# イシュー修正ワークフロー: $ARGUMENTS

1. イシュー内容を確認・理解する
2. 関連するコードを特定する（server.js / app.js / index.html）
3. 根本原因を分析する
4. 最小限の修正を実装する
5. `npm start` で動作確認
6. 修正前後のdiffを表示する
7. コミットメッセージを提案する
