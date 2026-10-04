# Windows / Linux の動作確認のお願い

「すこしタコ」を Windows と Linux の Claude Code でも遊べるようにする準備をしています。その前に、Claude Code のプラグインが Windows / Linux でどこまで動くかを知りたいので、小さな確認用プラグインを動かして、結果を送ってください。2〜3 分で終わります。

## これが調べること

確認用プラグイン `tako-check` は、次のことができるかを調べます。

- OS の見分け
- OS に最初から入っているコマンド(Windows は `curl.exe`・`certutil`・`tar.exe`、Linux は `curl`・`sha256sum`・`tar`)が動くか
- 一時フォルダにフォルダを 1 つ作って、ファイルを 1 つ書いて、消せるか
- 小さな子プロセスを起動して、その出力を受け取れるか
- 画面の横にペインが開いて、ボタンが押せるか

ゲームは入っていません。ネットワークには接続しません。作るのは、一時フォルダの中の確認用フォルダ(すぐ消します)と、ホームフォルダの `tako-check-report.txt`(結果)だけです。プラグインの中身は [`windows-check/hooks/register.js`](windows-check/hooks/register.js) の 1 ファイルです。

## 必要なもの

- Windows 10 以降、または Linux
- Claude Code 2.1.287 以降(`claude --version` で分かります。古ければ `claude update`)

## 手順

1. このリポジトリを手元に置きます。

   ```
   git clone https://github.com/TaichiAkimoto/sukoshi-tako
   ```

   git が無ければ、このページの「Code」→「Download ZIP」で取得して展開してください。

2. 確認用プラグインを付けて Claude Code を起動します。

   Windows(PowerShell かコマンドプロンプト):

   ```
   claude --plugin-dir sukoshi-tako\windows-check
   ```

   Linux:

   ```
   claude --plugin-dir sukoshi-tako/windows-check
   ```

3. 入力欄に `/tako-check` と打って Enter を押します。結果が数行出ます。

4. 画面の横にペインが開いたら、「このボタンを押してください」を 1 回押します(キーボードの 1 でも押せます)。ペインが開かなかった場合は、そのままで構いません。

5. ホームフォルダにできた `tako-check-report.txt` を送ってください(Windows は `C:\Users\<あなたの名前>\tako-check-report.txt`)。あわせて、次の 2 点を一言ずつ教えてください。

   - ペインは開きましたか。ボタンは押せましたか。
   - 使ったのはどのターミナルですか(Windows Terminal、PowerShell、VS Code のターミナル、Claude デスクトップアプリ など)。

## Claude デスクトップアプリをお使いの場合(こちらもお願いします)

いちばん知りたいのは、Claude デスクトップアプリの「Code」タブから使ったときに動くかどうかです。デスクトップアプリをお使いなら、上の手順のあとに、次も 1 回お願いします。

1. 先に、上の手順 5 でできた `tako-check-report.txt` の名前を `tako-check-report-terminal.txt` に変えます(次の結果で上書きされるため)。

2. ターミナルで次の 2 行を実行して、確認用プラグインを入れます。

   ```
   claude plugin marketplace add TaichiAkimoto/sukoshi-tako
   claude plugin install tako-check@sukoshi-tako
   ```

3. Claude デスクトップアプリを開き直して、「Code」タブで新しいセッションを始めます。セッションの種類は「Local」を選んでください(Cloud、SSH、WSL では調べられません)。

4. 入力欄に `/tako` と打つと、候補に `tako-check:tako-check` が出ます。それを選んで送ります(デスクトップアプリでは、この長い名前になります)。横にペインが開いたら、ボタンを 1 回押します。

5. ホームフォルダにできた `tako-check-report.txt` を送ってください。候補に出てこない場合や、送っても何も起きない場合は、そのことをそのまま教えてください。それも結果として役に立ちます。

終わったら、次の 2 行で確認用プラグインを外せます。

```
claude plugin uninstall tako-check
claude plugin marketplace remove sukoshi-tako
```

送り終わったら、`tako-check-report.txt` と、手順 1 で作った `sukoshi-tako` フォルダは消して構いません。

## 確認その 2: ウィンドウとキー入力(その 1 が動いた方にお願いします)

その 1 が動いたら、もう 1 つお願いします。こちらは、ゲームが実際に行うこと(小さなプログラムを取得して起動し、別のウィンドウを出す)を確かめます。3 分ほどで終わります。

確認用プラグイン `tako-window-check` は、箱を 1 つ描くだけの小さなプログラム(Windows 用は約 4MB)をこのリポジトリのリリースから取得し、SHA-256 を照合してから起動します。ゲームは入っていません。取得したプログラムは、プラグインのフォルダの中(`dist` フォルダ)に置かれます。Windows では、発行元が不明なプログラムとして警告が出るかもしれません。出た場合は、その文面を教えてください(実行を許可するかどうかはお任せします)。

1. ターミナルで次の 2 行を実行します(その 1 でマーケットプレイスを追加済みなら、1 行目は `claude plugin marketplace update sukoshi-tako` に替えてください)。

   ```
   claude plugin marketplace add TaichiAkimoto/sukoshi-tako
   claude plugin install tako-window-check@sukoshi-tako
   ```

2. Claude Code を開き直します。デスクトップアプリなら「Code」タブで新しいセッション(Local)、ターミナルなら `claude` です。

3. デスクトップアプリでは、入力欄に `/tako` と打って候補の `tako-window-check:tako-window-check` を選んで送ります。ターミナルでは `/tako-window-check` と打って Enter を押します。

4. 回る箱のウィンドウが出ます(40 秒で自動的に閉じます)。出たら、次の順に操作してください。

   1. そのウィンドウをクリックする
   2. 何かキーを 1 つ押して、離す
   3. 別のウィンドウ(Claude など)をクリックする

5. ホームフォルダにできた `tako-window-check-report.txt` を送ってください。あわせて、ウィンドウが見えたかどうか、警告が出たかどうかを一言ずつ教えてください。

外すときは `claude plugin uninstall tako-window-check` です。

## 結果に入るもの

`tako-check-report.txt` に入るのは、OS の種類、CPU の種類、Claude Code の版、各コマンドが動いたかどうか(終了コードと出力の 1 行目)、ペインが開いたか、ボタンを押した回数です。ユーザー名、ファイルの中身、会話の内容は入りません(ホームフォルダの場所は `~` に置き換えます)。送る前に中を見て、気になる行があれば消してください。

## うまくいかないとき

- `/tako-check` が「見つからない」と出る: 手順 2 のフォルダの指定が違っている可能性があります。`windows-check` フォルダの中に `hooks` フォルダがあるか確かめてください。それでも出ない場合は、その画面の文をそのまま教えてください。それも結果として役に立ちます。
- 途中でエラーが出た: 出た文をそのまま教えてください。
