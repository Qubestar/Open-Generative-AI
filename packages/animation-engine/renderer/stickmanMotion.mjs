// Frame-driven 2D motion: no models, randomness, or wall-clock animation.
export function characterPose(character, frame, fps, frames, speech = 0) {
  const t = Math.max(0, frame) / fps;
  const phase = [...character.id].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % 11;
  const cycle = t * Math.PI * 3;
  const walking = character.action === 'walk';
  const progress = Math.min(1, Math.max(0, frame / Math.max(1, frames - 1)));
  const talking = character.action === 'talk';
  const ease = (value) => value * value * (3 - 2 * value);
  const talkGesture = ease(Math.min(1, progress / .22)) * (1 - ease(Math.min(1, Math.max(0, (progress - .65) / .25))));
  return {
    x: character.x + (walking ? (character.endX - character.x) * ease(progress) : 0),
    bob: walking ? -Math.abs(Math.sin(cycle)) * 3 : Math.sin(t * 2.2 + phase) * 1.3,
    head: Math.sin(t * 2 + phase) * (talking ? 2.2 : 1.2) + (talking ? speech * 2 : 0),
    blink: (t + phase * .31) % 3.7 < .12,
    gaze: Math.sin(t * 1.4 + phase) * 1.6,
    mouth: talking ? Math.min(1, Math.max(0, speech)) : 0,
    leftArm: walking ? Math.sin(cycle) * 15 : talking ? -5 - talkGesture * 15 : -5,
    rightArm: walking ? -Math.sin(cycle) * 15 : character.action === 'wave' ? -130 + Math.sin(t * 7) * 18 : character.action === 'point' ? -92 + Math.sin(t * 2) * 3 : talking ? 5 - talkGesture * 48 : 5,
    leftLeg: walking ? Math.sin(cycle) * 14 : 0,
    rightLeg: walking ? -Math.sin(cycle) * 14 : 0,
  };
}
