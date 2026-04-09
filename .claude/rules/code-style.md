# コーディング規約

- 'use strict' を全ファイル先頭に記述
- セミコロンあり
- シングルクォート
- console.log のプレフィックスに [カテゴリ] を付ける（例: [API], [upload], [status], [poll]）
- エラーハンドリングは try-catch で統一
- 非同期処理は async/await（Promise チェーン不使用）
- 日本語コメント推奨
- 変数名・関数名は英語（キャメルケース）
