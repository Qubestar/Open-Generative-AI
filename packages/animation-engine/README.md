# Animation engine

Original Vidmyo compositions driven by validated director JSON. Uses the app-owned Remotion runtime; no user-managed Node/Remotion setup. Local agents and OpenRouter use the shared tool-free provider boundary.

## Reference audit — 2026-09-15

The user-supplied ` Remotion Animations 2` directory contains three visual systems:

- `empire-downfall-project-pack`: editorial paper collage, photographic cutouts, marker strokes; supplied example 1920×1080, 47.3s. Its scene files are parts of one style.
- `skool-practice-kit`: documentary maps, real geography, route/camera continuity; supplied example has three scenes. The media license is personal practice only; none is redistributed.
- `MASTER GPT PROMPT — Premium Paper Stop-Motion...docx`: handcrafted paper image/video direction, locked camera, back-to-front assembly then living poster. This is a prompt specification, not a Remotion implementation.

Landscape/portrait are output formats, independent of style. Original media and third-party reference code are not included. Generated imagery determines material fidelity; the fixed renderer provides reproducible motion. Editorial collage and paper stop-motion generate a separate transparent hero plus supporting/foreground cutouts, move those layers independently, then hold the assembled paper poster with subtle motion. The director contract requires exactly one hero and at least one supporting layer. Cached layer fingerprints prevent unchanged assets from being generated again.

The documentary renderer unwraps every bundled TopoJSON polygon and route around the active camera longitude before projection, preventing antimeridian edges from becoming horizontal streaks.

World geography: world-atlas 2.0.2 countries-110m.json, ISC, https://github.com/topojson/world-atlas. Its notice is retained in `THIRD_PARTY.md`. The atlas is derived from public-domain Natural Earth data. Map labels and route endpoints come from the selected director; approximate low-resolution boundaries are not suitable for navigation.

Reference UI: https://www.youtube.com/watch?v=2el_3pwqxyI at 1:40–3:40: brief, duration, style, preview and persistent workspace history.

## Stickman character animation

The former Story workspace offers optional local articulated stick figures over a still background. The `animated` mode consumes validated `scene.characters` and a voice amplitude envelope, while `static` preserves the previous illustration treatment. See [reference analysis, limitations and measured M2 Pro timings](../../docs/stickman-character-animation.md). No video diffusion or Video Delta service is needed for this mode.
