# sukoshi-tako(すこしタコ)

Claude が作業している間、ターミナルの横で「すこしタコ」が遊べる Claude Code プラグインです。作業が終わるか、Claude があなたを必要としたら、すぐに元の画面へ戻します。

「すこしタコ」は、体を塗って景色に溶け込む 3D のかくれんぼです。このプラグインでは全世界モードが遊べます。世界のどこかの誰かが隠れた場所を探しに行くか、自分が隠れて誰かに探してもらいます。相手と同じ時間に遊ぶ必要はありません。

A Claude Code plugin that lets you play "Sukoshi Tako", a 3D camouflage hide-and-seek, in a pane beside the transcript while Claude works, and hands you back when it is done or needs you.

## 入れ方

1. プラグインを入れます。

   ```
   /plugin install sukoshi-tako --marketplace TaichiAkimoto/sukoshi-tako
   ```

2. オンにします。

   ```
   /tako
   ```

   初回だけ、ゲーム本体(約 7 MB)を取得します。

オフにするには `/tako off` です。

## Windows / Linux 対応の準備

Windows と Linux でも遊べるようにする準備をしています。まだゲームは動きません。Windows か Linux で Claude Code を使っていて、動作確認(2〜3 分、ゲームなし)を手伝ってくださる方は [WINDOWS-CHECK.md](WINDOWS-CHECK.md) を見てください。

## 必要なもの

- macOS(ゲーム本体は Apple silicon と Intel の両方に対応。動作を確かめたのは macOS 27 の Apple silicon だけです)
- [Ghostty](https://ghostty.org) か [kitty](https://sw.kovidgoyal.net/kitty/)。ゲームの絵を出せるのは、この 2 つのターミナルだけです
- Claude Code 2.1.287 以降

Claude Code のテーマ(`/theme`)とターミナルの配色は、明るいもの同士か暗いもの同士で揃えてください。食い違っていると、ペインの文字が背景と同じ色になって読めません。

## 動き方

- `/tako` を打つと、ペインが開いてメニューが出ます。
- オンの間は、Claude が 2 秒以上作業するとペインが開きます。作業が終わると 3 秒数えて閉じます。
- 権限の確認や質問が出たら、すぐに閉じます。答えると、また開きます。
- 自分でペインを閉じたら、その作業の間は開きません。
- ターミナルが狭くて自動で開けないときは、入力欄の上に出るボタン(1 を押す)で開けます。

## 操作

絵をクリックすると、キーがゲームに届きます。Esc で入力欄に戻ります。

| キー | 探す | 隠れる |
| :- | :- | :- |
| 十字キー / W A S D | 移動 | 移動 |
| ドラッグ / I J K L | 狙う | 右ドラッグか I J K L で視点 |
| クリック / Space | 撃つ(押し続けで連射) | 左ドラッグで体を塗る |
| 1 | — | 色を拾う(次のクリックで拾う) |
| 2 | — | ブラシを替える |
| 3 | — | ポーズを替える |
| 4 | — | うつす(景色の色で塗る)のオン・オフ |
| 5 | — | 全身に景色をうつす |
| Q / E | — | 体の向き |
| R / F | 上 / 下 | 上 / 下 |
| C | 背後へ戻す | 背後へ戻す |
| V | カメラの距離 | — |
| Enter | さがし終わり | ここに隠れる |

ターミナルはキーを離したことを知らせないので、キーは自動リピートが止まるまで押されている扱いになります。

## 何に接続するか

- ゲーム本体の取得: このリポジトリの Releases から `curl` で取得します。プラグインに書かれた SHA-256 と一致したときだけ展開して実行します。
- 遊んでいる間: すこしタコのサーバー(Cloudflare Workers)に HTTPS で接続します。送るのは、匿名の識別子(この Mac で作った乱数)、遊んだコース、隠れた位置と塗った模様、見つけた相手、遊び方の計測(どの場面を通ったか)です。
- 名前、メールアドレス、Claude との会話、作業中のプロジェクトの内容は送りません。
- 匿名の識別子は `~/Library/Application Support/sukoshi-tako/` に保存します。このフォルダを消すと、別の人として始まります。

## 公開している範囲

このリポジトリにあるのは、プラグイン(JavaScript と設定)だけです。ゲーム本体はビルド済みの実行ファイルとして配っていて、ソースコードは公開していません。

## ライセンスとクレジット

- プラグイン(このリポジトリのファイル): MIT。`LICENSE` を見てください。
- ゲーム本体(配布している実行ファイルとその中の素材): 再配布や改変の許可は付けていません。
- キャラクターの 3D モデル: CC-BY-4.0。作者と出典は `CREDITS.md` にあります。
- 家具の 3D モデル: CC0。
- GLTFKit2: MIT。
- 仕組みは [intermission](https://github.com/jarrodwatts/intermission)(Claude の作業中に Doom を遊ぶプラグイン)を参考にしました。
