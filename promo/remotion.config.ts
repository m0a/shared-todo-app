import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);
// このマシンにある Chrome を使う（Remotion専用ブラウザのDLを避ける）
Config.setChromiumOpenGlRenderer('angle-egl');
