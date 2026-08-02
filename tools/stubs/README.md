# テスト用スタブ

`@minecraft/server` と `@minecraft/server-ui` の**最小限の偽実装**です。
`package.json` の `devDependencies` から `file:` 参照されているので、
`npm install` するとこのディレクトリが `node_modules/@minecraft/*` にリンクされます。

これがある理由は、`npm run check` と `npm run simulate` が
アドオンのスクリプトを**実際に import して実行する**ためです。
Minecraftを起動しなくても、次のような事故をコミット前に検出できます。

- 存在しない名前を import している
- export を書き忘れている
- モジュール読み込み時に例外を投げるコードを書いてしまった

## 注意

**スタブが通ることは、ゲーム内で動くことの保証ではありません。**
ここにあるのは呼び出しを受け流すだけの空実装で、本物のAPIの挙動は再現していません。
実機での確認は必ず行ってください。

本物のAPIは Mojang が公開しているものを使ってください。
TypeScriptの型定義が必要なら `npm i -D @minecraft/server` で本物を入れられますが、
その場合はこのスタブとリンク先が衝突するので `devDependencies` の `file:` 参照を外してください。
