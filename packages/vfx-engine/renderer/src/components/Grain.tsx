import {AbsoluteFill, useCurrentFrame} from 'remotion';

const NOISE_SVG =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='128' height='128'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/></filter><rect width='128' height='128' filter='url(%23n)' opacity='0.55'/></svg>";

// Subtle animated film grain. Deterministic: position derives from the frame.
export const Grain = ({opacity = 0.06}: {opacity?: number}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill
      style={{
        pointerEvents: 'none',
        opacity,
        mixBlendMode: 'overlay',
        backgroundImage: `url("${NOISE_SVG}")`,
        backgroundRepeat: 'repeat',
        backgroundPosition: `${(frame * 7) % 128}px ${(frame * 13) % 128}px`,
      }}
    />
  );
};
