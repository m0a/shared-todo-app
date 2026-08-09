import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLOR, FONT } from './theme';

/** 下からふわっと出る共通アニメ。テンポ重視で短め */
function usePop(delay = 0) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 200, mass: 0.5 } });
  return { opacity: s, translateY: interpolate(s, [0, 1], [26, 0]) };
}

/** 画面下部の字幕。白いカードに乗せて素材の上でも読めるようにする */
export const Caption: React.FC<{
  children: React.ReactNode;
  delay?: number;
  align?: 'center' | 'left';
  bottom?: number;
}> = ({ children, delay = 0, align = 'center', bottom = 76 }) => {
  const { opacity, translateY } = usePop(delay);
  return (
    <AbsoluteFill
      style={{
        justifyContent: 'flex-end',
        alignItems: align === 'center' ? 'center' : 'flex-start',
        padding: `0 90px ${bottom}px`,
      }}
    >
      <div
        style={{
          opacity,
          transform: `translateY(${translateY}px)`,
          background: COLOR.card,
          color: COLOR.text,
          fontFamily: FONT,
          fontSize: 46,
          fontWeight: 600,
          lineHeight: 1.35,
          letterSpacing: '0.01em',
          padding: '22px 40px',
          borderRadius: 20,
          boxShadow: '0 18px 44px rgba(22, 40, 72, 0.18)',
          maxWidth: 1180,
          textAlign: align,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** 左側に出す「AIへの指示」の吹き出し。左下にしっぽを付けて会話らしく見せる */
export const Prompt: React.FC<{ children: React.ReactNode; delay?: number; top: number }> = ({
  children,
  delay = 0,
  top,
}) => {
  const { opacity, translateY } = usePop(delay);
  return (
    <div
      style={{
        position: 'absolute',
        left: 128,
        top,
        opacity,
        transform: `translateY(${translateY}px)`,
        maxWidth: 740,
        filter: 'drop-shadow(0 14px 30px rgba(26, 115, 232, 0.30))',
      }}
    >
      <div
        style={{
          position: 'relative',
          display: 'inline-block',
          background: COLOR.accent,
          color: '#fff',
          fontFamily: FONT,
          fontSize: 38,
          fontWeight: 500,
          lineHeight: 1.45,
          padding: '22px 32px',
          borderRadius: '26px 26px 26px 6px',
        }}
      >
        {children}
        {/* しっぽ。吹き出しの左下から下向きに伸ばす */}
        <svg
          width="26"
          height="28"
          viewBox="0 0 26 28"
          style={{ position: 'absolute', left: -24, bottom: 0, display: 'block' }}
        >
          <path d="M26 28 L26 0 C26 15 17 25 0 28 Z" fill={COLOR.accent} />
        </svg>
      </div>
    </div>
  );
};

/** 吹き出しの上に出す話者ラベル */
export const PromptLabel: React.FC<{ delay?: number; top: number; children: React.ReactNode }> = ({
  delay = 0,
  top,
  children,
}) => {
  const { opacity } = usePop(delay);
  return (
    <div
      style={{
        position: 'absolute',
        left: 112,
        top,
        opacity,
        fontFamily: FONT,
        fontSize: 26,
        fontWeight: 600,
        color: COLOR.sub,
        letterSpacing: '0.08em',
      }}
    >
      {children}
    </div>
  );
};

/** 撮影台での端末の中心X（1920x1080の素材内） */
export const PHONE_CENTER = { left: 597, right: 1322 };

/** タップした場所に出す波紋。どの行を触ったかを示す */
export const TapRipple: React.FC<{ x: number; y: number }> = ({ x, y }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = interpolate(frame, [0, 0.5 * fps], [0, 1], { extrapolateRight: 'clamp' });
  const size = 40 + t * 120;
  return (
    <div
      style={{
        position: 'absolute',
        left: x - size / 2,
        top: y - size / 2,
        width: size,
        height: size,
        borderRadius: '50%',
        border: `5px solid ${COLOR.accent}`,
        opacity: interpolate(t, [0, 1], [0.85, 0]),
      }}
    />
  );
};

/**
 * 端末の上に出す名前。素材側では名前を消してあり、ここで描いている。
 * その人が操作した瞬間だけ青いピルになるので、どちらが動かしたのかが分かる。
 */
export const PhoneLabel: React.FC<{
  centerX: number;
  name: string;
  who: string;
  /** その人がタップしたフレーム番号（シーン先頭からの絶対フレーム） */
  taps: number[];
  activeFrames: number;
}> = ({ centerX, name, who, taps, activeFrames }) => {
  const frame = useCurrentFrame();
  const hit = taps.find((f) => frame >= f && frame < f + activeFrames);
  const active = hit !== undefined;
  const since = active ? frame - (hit as number) : 0;
  const pop = active ? interpolate(since, [0, 5], [0.92, 1], { extrapolateRight: 'clamp' }) : 1;
  return (
    <div
      style={{
        position: 'absolute',
        left: centerX,
        top: 26,
        transform: `translateX(-50%) scale(${pop})`,
        fontFamily: FONT,
        fontSize: active ? 34 : 30,
        fontWeight: active ? 600 : 500,
        whiteSpace: 'nowrap',
        padding: active ? '12px 30px' : '10px 20px',
        borderRadius: 999,
        background: active ? COLOR.accent : 'transparent',
        color: active ? '#fff' : COLOR.text,
        boxShadow: active ? '0 12px 30px rgba(26, 115, 232, 0.35)' : 'none',
      }}
    >
      {active ? `${who}がチェック` : name}
    </div>
  );
};

/** 冒頭・締めのカード */
export const CardScreen: React.FC<{
  title: React.ReactNode;
  sub?: React.ReactNode;
  foot?: React.ReactNode;
}> = ({ title, sub, foot }) => {
  const t = usePop(0);
  const s = usePop(8);
  const f = usePop(16);
  return (
    <AbsoluteFill
      style={{
        background: `radial-gradient(120% 100% at 50% 0%, #ffffff 0%, ${COLOR.bg} 55%, #e2e8f2 100%)`,
        justifyContent: 'center',
        alignItems: 'center',
        fontFamily: FONT,
        textAlign: 'center',
        padding: 100,
      }}
    >
      <div
        style={{
          opacity: t.opacity,
          transform: `translateY(${t.translateY}px)`,
          fontSize: 88,
          fontWeight: 700,
          color: COLOR.text,
          lineHeight: 1.3,
          letterSpacing: '0.01em',
        }}
      >
        {title}
      </div>
      {sub ? (
        <div
          style={{
            opacity: s.opacity,
            transform: `translateY(${s.translateY}px)`,
            marginTop: 34,
            fontSize: 42,
            fontWeight: 500,
            color: COLOR.sub,
            lineHeight: 1.5,
          }}
        >
          {sub}
        </div>
      ) : null}
      {foot ? (
        <div
          style={{
            opacity: f.opacity,
            transform: `translateY(${f.translateY}px)`,
            marginTop: 56,
            fontSize: 40,
            fontWeight: 600,
            color: COLOR.accent,
            padding: '18px 40px',
            background: '#fff',
            borderRadius: 999,
            boxShadow: '0 16px 40px rgba(22, 40, 72, 0.14)',
          }}
        >
          {foot}
        </div>
      ) : null}
    </AbsoluteFill>
  );
};
