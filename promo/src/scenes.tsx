import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useVideoConfig } from 'remotion';
import { Caption, Prompt, PromptLabel } from './components';

/**
 * 素材はすべて 1920x1080 の実画面録画（撮影台に本番アプリを iframe で読み込んで録画したもの）。
 * 元動画の時刻(秒) → frames(30fps) は SRC() で書く。
 *
 * cut-ai.mp4 の出来事:  追加 11.8 / 17.3 / 27.4、並べ替え 41.9、色分け 49.4
 * cut-sync.mp4 の出来事: 4人分のチェック 3.5〜6.5、下へ移動 6.5〜13.5
 */
export const SRC = (sec: number) => Math.round(sec * 30);

const AI = { start: 10.8, end: 30.0, add1: 11.8, add2: 17.3, add3: 27.4 };
const ORG = { start: 40.9, end: 52.5, color: 49.4 };
const SYNC = { start: 3.2, end: 14.0 };

/** 素材の一部を切り出して画面いっぱいに使う（README用の小さい画面向け） */
export type Rect = { x: number; y: number; w: number; h: number };

const Video: React.FC<{ src: string; from: number; to: number; rate: number; rect?: Rect }> = ({
  src,
  from,
  to,
  rate,
  rect,
}) => {
  const video = (
    <OffthreadVideo
      src={staticFile(src)}
      trimBefore={from}
      trimAfter={to}
      playbackRate={rate}
      muted
      style={
        rect
          ? { position: 'absolute', width: 1920, height: 1080, left: -rect.x, top: -rect.y }
          : { width: '100%', height: '100%', objectFit: 'cover' }
      }
    />
  );
  if (!rect) return video;
  return <Zoomed rect={rect}>{video}</Zoomed>;
};

/** rect の範囲が composition いっぱいになるよう拡大する */
const Zoomed: React.FC<{ rect: Rect; children: React.ReactNode }> = ({ rect, children }) => {
  const { width, height } = useVideoConfig();
  const scale = Math.max(width / rect.w, height / rect.h);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: (width - rect.w * scale) / 2,
          top: (height - rect.h * scale) / 2,
          width: rect.w,
          height: rect.h,
          overflow: 'hidden',
          transformOrigin: '0 0',
          transform: `scale(${scale})`,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** 素材上の時刻(秒) → そのシーン内でのフレーム番号 */
const at = (sec: number, start: number, rate: number, lead = 0) =>
  Math.max(0, Math.round((sec - start) * (30 / rate)) - lead);

/** AIに言うだけで項目が増えていくシーン */
export const SceneAI: React.FC<{ rate?: number }> = ({ rate = 1.6 }) => (
  <AbsoluteFill>
    <Video src="cut-ai.mp4" from={SRC(AI.start)} to={SRC(AI.end)} rate={rate} />
    <PromptLabel top={250} delay={2}>
      AIに話しかけるだけ
    </PromptLabel>
    <Prompt top={294} delay={at(AI.add1, AI.start, rate, 22)}>
      牛乳ない、卵もない
    </Prompt>
    <Prompt top={452} delay={at(AI.add2, AI.start, rate, 22)}>
      あと洗剤とトイレットペーパーも
    </Prompt>
    <Prompt top={610} delay={at(AI.add3, AI.start, rate, 22)}>
      今夜カレーだから材料も入れといて
    </Prompt>
  </AbsoluteFill>
);

/** 並べ替え・色分けのシーン */
export const SceneOrganize: React.FC<{ rate?: number }> = ({ rate = 2.3 }) => (
  <AbsoluteFill>
    <Video src="cut-ai.mp4" from={SRC(ORG.start)} to={SRC(ORG.end)} rate={rate} />
    <PromptLabel top={264} delay={2}>
      買う前にひと声
    </PromptLabel>
    <Prompt top={308} delay={4}>
      スーパーの売り場順に並べ替えて
    </Prompt>
    <Prompt top={466} delay={at(ORG.color, ORG.start, rate, 20)}>
      野菜・肉・日用品で色分けして
    </Prompt>
    <Sequence from={at(ORG.color, ORG.start, rate) + 8}>
      <Caption>売り場を行ったり来たりしない買い物リストになる</Caption>
    </Sequence>
  </AbsoluteFill>
);

/** 2画面リアルタイム同期のシーン */
export const SceneSync: React.FC<{ rate?: number; caption?: boolean; rect?: Rect }> = ({
  rate = 1.35,
  caption = true,
  rect,
}) => {
  const half = Math.round(4.4 * (30 / rate));
  return (
    <AbsoluteFill>
      <Video src="cut-sync.mp4" from={SRC(SYNC.start)} to={SRC(SYNC.end)} rate={rate} rect={rect} />
      {caption ? (
        <>
          <Sequence durationInFrames={half}>
            <Caption delay={4}>スーパーでは手分けして、同時に買える</Caption>
          </Sequence>
          <Sequence from={half}>
            <Caption>カゴに入れた瞬間、相手のリストからも消える</Caption>
          </Sequence>
        </>
      ) : null}
    </AbsoluteFill>
  );
};

/** README用: soloカットの端末だけに寄る */
export const SceneAIZoom: React.FC<{ rate?: number }> = ({ rate = 1.9 }) => (
  <AbsoluteFill>
    <Video
      src="cut-ai.mp4"
      from={SRC(AI.start)}
      to={SRC(AI.end)}
      rate={rate}
      rect={{ x: 1090, y: 55, w: 640, h: 990 }}
    />
  </AbsoluteFill>
);
