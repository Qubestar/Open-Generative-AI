// Browser-safe catalog shared by the Studio UI and the Node production engine.
// Keep this module data-only: client components import it directly.
export const ANIMATION_STYLES = Object.freeze([
  Object.freeze({
    id: 'editorial-collage',
    name: 'Editorial collage',
    eyebrow: 'Documentary',
    description: 'Paper textures, photographic cutouts, red marker accents and animated headlines.',
    accent: '#e66547',
    motion: 'Layered paper base, independently moving photo cutouts, offset red silhouettes, foreground anchors, editorial type, and animated chart strokes.',
  }),
  Object.freeze({
    id: 'documentary-map',
    name: 'Documentary maps',
    eyebrow: 'Places & journeys',
    description: 'Real geography, highlighted locations and continuous camera moves that follow the story.',
    accent: '#63b7b4',
    motion: 'Real geographic map, navy ocean, muted land, illuminated locations, animated routes, and continuous camera moves between places.',
  }),
  Object.freeze({
    id: 'paper-stop-motion',
    name: 'Paper stop-motion',
    eyebrow: 'Handcrafted',
    description: 'Dimensional cardstock scenes that assemble in layers and gently come to life.',
    accent: '#d5a45e',
    motion: 'Locked camera. Thick layered cardstock with visible edges and shadow gaps. One hero and at most three supporting objects assemble back-to-front, followed by a subtle living-poster hold.',
  }),
]);

export function animationStyle(id) {
  const style = ANIMATION_STYLES.find((candidate) => candidate.id === id);
  if (!style) throw new Error('Choose an animation style.');
  return style;
}
