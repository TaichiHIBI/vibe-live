# ライブ文字起こし版 Vibe のセットアップ(macOS)

このリポジトリ(`live` ブランチ)は、Vibe にライブ文字起こしを足したものです。
公式配布の Vibe にはライブ機能がないため、**ソースからビルドしてインストールします**。
上から順にコマンドを実行すれば、`/Applications/vibe.app` に入って起動します。

- 対象: Apple Silicon の Mac(Intel Mac では未確認)
- 空き容量: 15 GB 程度(ビルド成果物 約11 GB + モデル 約3 GB)
- 時間: 初回ビルドは数十分かかります

設計やプロトコルの詳細は [LIVE.md](LIVE.md) を参照してください。

## 1. 必要なツールを入れる(初回のみ)

コマンドはすべて「ターミナル」アプリで実行します。
各ツールを入れたあとは、**ターミナルを一度閉じて開き直して**ください(PATH を反映させるため)。

### Xcode Command Line Tools

```bash
xcode-select --install
```

ダイアログが出たら「インストール」を押します。すでに入っている場合はエラーになりますが、問題ありません。

### Rust

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

途中の質問は Enter(既定のまま)で進めます。

### Node.js と pnpm

```bash
touch ~/.zshrc && curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
```

ターミナルを開き直してから:

```bash
nvm install 22
```

```bash
corepack enable pnpm
```

### chore(このリポジトリのタスクランナー)

```bash
curl -fsSL https://getchore.github.io/chore/install.sh | sh
```

### 確認

ターミナルを開き直して、次の5つがすべてバージョンを表示すれば準備完了です。
pnpm のダウンロード確認(`Do you want to continue? [Y/n]`)が出たら Y を押します。

```bash
cargo -V; node -v; pnpm -v; chore --version; git --version
```

`chore: command not found` と出る場合は、次を実行してからターミナルを開き直してください。

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

## 2. リポジトリを取得する(初回のみ)

```bash
git clone -b live https://github.com/TaichiHIBI/vibe-live.git ~/vibe-live
```

## 3. ビルドしてインストールする

```bash
cd ~/vibe-live && chore live-install
```

このコマンドは次の4つを順に実行します。

1. フロントエンドの依存を入れる(`chore install`)
2. ffmpeg を取得する(`chore setup`)
3. ライブ対応のサーバーを `server/` のソースからビルドして差し替える(`chore server-build`)
4. アプリをビルドし、`/Applications/vibe.app` を置き換えて起動する(`chore upgrade`)

公式版の Vibe がすでに入っている場合は置き換わります。設定と、ダウンロード済みのモデルはそのまま引き継がれます。

## 4. モデルを入れる

初回起動時に、アプリが文字起こし用モデル **Whisper large-v3**(約3 GB)のダウンロードを提案します。そのまま受け入れてください。
ライブ文字起こしも、既定でこの同じモデルを使います。

大きいモデルなので、文字起こし中は 4 GB 前後のメモリを使います。最後に使ってから5分たつと自動で解放されます(設定の「詳細設定」→「非アクティブ時にモデルを解放」で変更できます)。

### ほかのモデルを使う

アプリの設定「モデル」→「モデルをダウンロード」のリンクから開くページに、使えるモデルの一覧があります。

**モデル一覧: https://thewh1teagle.github.io/vibe/docs#models**(ブラウザの言語が日本語なら日本語で表示されます)

軽い Whisper(Tiny / Small / Medium)、large-v3 turbo、Parakeet、Nemotron などがあります。入れ方は2通りです。

- **Magic Setup**: リンクを押すと Vibe が開き、そのままダウンロードが始まります
- **直接ダウンロード**: リンクのアドレスをコピーして、設定「モデル」→「モデルライブラリ」の「モデルリンクを貼り付け」欄に貼り、Enter を押します

入れたモデルは、設定「モデル」で選ぶとファイルの文字起こしに、録音パネルの「ライブ用モデル」で選ぶとライブに使われます。

## 5. ライブ文字起こしを使う

1. ホーム画面の録音パネルで「ライブ文字起こし」をオンにします
2. マイク(または出力デバイスの音声)を選んで「ライブで文字起こし」を押します
3. 初回は macOS がマイクや画面・システムオーディオの録音の許可を求めるので、許可します。
   許可しそびれた場合は「システム設定 → プライバシーとセキュリティ」で vibe をオンにして、アプリを再起動します

「ライブ用モデル」は「ファイルの文字起こしと同じ」のままで構いません。

### Mac が非力で、ライブの表示が遅れる場合

large-v3 は、M4 Pro でも1回の処理に 0.8〜1.4 秒かかります。遅れが気になる場合は、軽い **Nemotron**(約470 MB)をライブ専用に入れます。

上の[モデル一覧](https://thewh1teagle.github.io/vibe/docs#models)にある「Nemotron 3.5 ASR Streaming 0.6B」の「Q4_K_Mをダウンロード」のリンクを、「モデルリンクを貼り付け」欄に貼って入れます。
入れたら、録音パネルの「ライブ用モデル」で Nemotron を選びます。

## 更新するとき

```bash
cd ~/vibe-live && git pull && chore live-install
```

## 注意

- **公式版へのアップデートの案内が出ても「いいえ」を選んでください。** 受け入れると公式版に置き換わり、ライブ機能が消えます。消えた場合は `chore live-install` をもう一度実行すれば戻ります。
- ビルドしたアプリは自分の Mac 用の簡易署名です。できあがった `vibe.app` を他の Mac にコピーして配るのではなく、各自がこの手順でビルドしてください。

## うまくいかないとき

- **`xcrun: error` や `linker 'cc' not found`**: 手順1の Xcode Command Line Tools が入っていません。
- **ビルドの途中でダウンロードに失敗する**: ネットワークを確認して、`chore live-install` をもう一度実行してください(途中まで済んだ分は再利用されます)。
- **ライブを始めてもすぐエラーになる**: サーバーが公式版のままの可能性があります。`chore server-build && chore upgrade` を実行してください。
- ログは `~/Library/Application Support/github.com.thewh1teagle.vibe/log_*.txt` にあります。
