#!/usr/bin/env bash
# README に貼る GIF を out/*.mp4 から作る。パレット生成してから変換するとにじまない。
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p ../docs/media

gif() {
  local src=$1 dst=$2 fps=$3 width=$4
  ffmpeg -v error -i "$src" -vf "fps=$fps,scale=$width:-1:flags=lanczos,palettegen=stats_mode=diff" -y /tmp/pal.png
  ffmpeg -v error -i "$src" -i /tmp/pal.png \
    -lavfi "fps=$fps,scale=$width:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" -y "$dst"
  echo "$(du -h "$dst" | cut -f1)  $dst"
}

gif out/readme-ai.mp4   ../docs/media/ai.gif   14 460
gif out/readme-sync.mp4 ../docs/media/sync.gif 14 900
