import React from 'react';
import { AbsoluteFill, Composition, Sequence } from 'remotion';
import { CardScreen } from './components';
import { SceneAI, SceneAIZoom, SceneOrganize, SceneSync } from './scenes';

const URL = 'shared-todo.abe00makoto.workers.dev';

/** SNS向け 32秒。掴み → AIで作る → 整える → みんなで消す → URL */
const XPromo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#eef2f8' }}>
    <Sequence durationInFrames={70}>
      <CardScreen
        title={<>買い物リスト、AIに任せた</>}
        sub={<>言うだけで増える。家族と同時に消える。</>}
      />
    </Sequence>

    <Sequence from={70} durationInFrames={360}>
      <SceneAI />
    </Sequence>

    <Sequence from={430} durationInFrames={151}>
      <SceneOrganize />
    </Sequence>

    <Sequence from={581} durationInFrames={279}>
      <SceneSync />
    </Sequence>

    <Sequence from={860} durationInFrames={120}>
      <CardScreen
        title={<>Shared Todo</>}
        sub={
          <>
            パスキーで登録、家族はログイン不要。
            <br />
            MCPでAIエージェントとつながります。
          </>
        }
        foot={URL}
      />
    </Sequence>
  </AbsoluteFill>
);

/** README用: AIが書き込むところを端末に寄って見せる（縦） */
const ReadmeAI: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#eef2f8' }}>
    <SceneAIZoom rate={1.9} />
  </AbsoluteFill>
);

/** README用: 2画面同期に寄る */
const ReadmeSync: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#eef2f8' }}>
    <SceneSync rate={1.15} caption={false} rect={{ x: 250, y: 0, w: 1420, h: 1065 }} />
  </AbsoluteFill>
);

/** 人に見せる用の通し 約70秒。等速寄りでじっくり */
const FullDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: '#eef2f8' }}>
    <Sequence durationInFrames={90}>
      <CardScreen
        title={<>Shared Todo</>}
        sub={<>AIエージェントと家族で共有する買い物リスト</>}
      />
    </Sequence>

    <Sequence from={90} durationInFrames={576}>
      <SceneAI rate={1} />
    </Sequence>

    <Sequence from={666} durationInFrames={348}>
      <SceneOrganize rate={1} />
    </Sequence>

    <Sequence from={1014} durationInFrames={321}>
      <SceneSync rate={1} />
    </Sequence>

    <Sequence from={1335} durationInFrames={132}>
      <CardScreen
        title={<>誰でもすぐ使えます</>}
        sub={
          <>
            作る人だけパスキーで登録。
            <br />
            共有URLを受け取った家族はログイン不要。
          </>
        }
        foot={URL}
      />
    </Sequence>
  </AbsoluteFill>
);

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="XPromo" component={XPromo} durationInFrames={980} fps={30} width={1920} height={1080} />
    <Composition id="ReadmeAI" component={ReadmeAI} durationInFrames={303} fps={30} width={640} height={960} />
    <Composition id="ReadmeSync" component={ReadmeSync} durationInFrames={279} fps={30} width={1280} height={960} />
    <Composition id="FullDemo" component={FullDemo} durationInFrames={1467} fps={30} width={1920} height={1080} />
  </>
);
