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

/** 左側に出す「AIへの指示」の吹き出し */
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
        left: 110,
        top,
        opacity,
        transform: `translateY(${translateY}px)`,
        maxWidth: 620,
      }}
    >
      <div
        style={{
          background: COLOR.accent,
          color: '#fff',
          fontFamily: FONT,
          fontSize: 38,
          fontWeight: 500,
          lineHeight: 1.45,
          padding: '22px 30px',
          borderRadius: '22px 22px 22px 6px',
          boxShadow: '0 14px 34px rgba(26, 115, 232, 0.32)',
        }}
      >
        {children}
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
