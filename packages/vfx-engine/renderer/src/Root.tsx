import {Composition} from 'remotion';
import {PerfectVfx} from './PerfectVfx';
import defaultSpec from './default-spec.json';

export const Root = () => {
  return (
    <Composition
      id="PerfectVfx"
      component={PerfectVfx as any}
      durationInFrames={150}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultSpec as any}
      calculateMetadata={async ({props}) => {
        const src = (props as any).source;
        return {
          width: src.width,
          height: src.height,
          fps: src.fps,
          durationInFrames: src.frameCount ?? Math.round(src.durationSec * src.fps),
        };
      }}
    />
  );
};
