# promo — 紹介動画

[Remotion](https://www.remotion.dev/) で作る紹介動画。素材は**本番アプリの実画面録画**で、
モックやアニメーションの再現ではない。

## 出力

| コンポジション | 用途 | サイズ |
|---|---|---|
| `XPromo` | SNS投稿用 32秒 | 1920x1080 |
| `FullDemo` | 人に見せる通し 約49秒 | 1920x1080 |
| `ReadmeAI` | READMEのGIF元（AIが書き込む） | 640x960 |
| `ReadmeSync` | READMEのGIF元（2画面同期） | 1280x720 |

```bash
pnpm install
pnpm studio                     # プレビュー（要ブラウザ）
pnpm render:x                   # out/x-promo.mp4
./make-gifs.sh                  # out/*.mp4 → ../docs/media/*.gif
```

レンダリングにブラウザが要る。このマシンには Chrome があるので、Remotion 専用ブラウザの
ダウンロードを避けるため `--browser-executable` を渡す:

```bash
npx remotion render XPromo out/x-promo.mp4 \
  --browser-executable=/home/m0a/.agent-browser/browsers/chrome-151.0.7922.47/chrome
```

## 素材の撮り方

`public/*.mp4` は使い回せるが、UIを変えたら撮り直す。手順は次のとおり。

1. **撮影台** — 仮想ディスプレイ(Xvfb)上にキオスクモードのChromeを置き、
   スマホ枠を並べたHTML(`stage.html`)を表示する。枠の中には本番アプリを iframe で読み込む。
   2枚並べると**それぞれ独立したWebSocket接続**になるので、同期の様子が演出なしで撮れる。
2. **文字を読めるように** — iframe は 394x620 の論理サイズで描画し、CSS の `transform: scale(1.5)`
   で拡大する。端末の枠だけ大きくしてもアプリの文字は大きくならないため、この方法をとる。
   スクロールバーは iframe を横に17pxはみ出させて隠す。
3. **操作** — CDP の `Input.dispatchMouseEvent` を絶対座標で送る。iframe にもそのまま届く。
   カーソルはイージングさせると人が操作しているように見える。
4. **AIの書き込み** — shared-todo の MCP を実際に叩く。画面に出るのは本物の同期結果。
5. **録画** — `ffmpeg -f x11grab -framerate 30` で仮想ディスプレイごと録る。

チェックON/OFFの「3秒その場に留まってから移動する」仕様のおかげで、3秒以内に操作を撮り切れば
行の座標がずれない。複数タップの撮影はこの性質を利用している。

撮影スクリプト一式はセッションのスクラッチ領域にあり、リポジトリには入れていない
（撮り直すときは上の手順から組み直す）。

## 編集のしかた

`src/scenes.tsx` の先頭に、素材のどの秒に何が起きたかを定数で持たせている。

```ts
const AI = { start: 10.8, end: 30.0, add1: 11.8, add2: 17.3, add3: 27.4 };
```

字幕や吹き出しの出るタイミングはこの秒数から計算するので、素材を撮り直したら
`ffmpeg -vf select='gt(scene,0.004)',showinfo` で変化時刻を拾って定数を差し替えるだけでよい。
