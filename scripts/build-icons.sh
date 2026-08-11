#!/usr/bin/env bash
# public/icon.svg から各サイズのアイコンを作る。
# アイコンの見た目を変えたら icon.svg だけ直して、このスクリプトを流し直す。
#   必要: rsvg-convert, ImageMagick
set -euo pipefail
cd "$(dirname "$0")/.."
SRC=public/icon.svg

png() { rsvg-convert -w "$1" -h "$1" "$SRC" -o "$2"; }

png 180 public/apple-touch-icon.png   # iOSのホーム画面
png 192 public/icon-192.png           # Androidのホーム画面・PWA
png 512 public/icon-512.png           # スプラッシュ・ストア表示

# Androidのマスカブルアイコン。端末側が好きな形に切り抜くので、
# 角丸をやめて全面を塗る（角丸のまま渡すと隅が透けることがある）
sed 's/rx="114"/rx="0"/' "$SRC" > /tmp/icon-maskable.svg
rsvg-convert -w 512 -h 512 /tmp/icon-maskable.svg -o public/icon-maskable-512.png

# favicon は複数サイズを1ファイルに束ねる
for s in 16 32 48; do rsvg-convert -w $s -h $s "$SRC" -o "/tmp/fav-$s.png"; done
magick /tmp/fav-16.png /tmp/fav-32.png /tmp/fav-48.png public/favicon.ico

ls -la public/*.png public/*.ico
