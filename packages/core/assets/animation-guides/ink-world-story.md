# Ink World Stories — adapted Vidmyo style guide

Source: user-provided animated-3d-story-video/SKILL.md and Claude 3D Animation Master Prompts.pdf, Drive folder11AuNQZIFQaw7pM0qjlv0-KUFQV0AgXQy. Original skill SHA256: 70771a4c7b68edf9b2b0ce5c5edb1d9dd0fe3f298177488cc5fb716c41f78a6e.

## Visual contract
Real procedural 3D spaces with perspective, foreground, midground and background. Build detailed rooms, buildings and props from geometry; never flat sky-ground strips or cardboard side-on facades. Draw ink edges in #351f22, thinner on props than characters. Painted flat colours, subtle three-band cel shading, warm upper-left key, soft fill and contact shadows. Fog or softly simplified distant detail; avoid glossy photorealism.

Flat characters stand within this 3D world: large round pale head, half-lidded eyes, tiny smile, fringe hair, collar, tie, pear-shaped two-tone torso, thin tapered limbs, dark hands. Stable base proportions; variants use palette, hats or glasses. Idle breathing, blinks, nods and purposeful gestures. Feet remain grounded. Characters turn toward camera without becoming edge-on. Medium framing keeps figures40–60% of frame height.

Camera travels in every shot with depth/parallax: slow push, crane or sideways track. Smooth ease-in/out and resting endpoints; avoid clipping faces or geometry. Use scene geometry in3D with a real perspective camera; raw WebGL is supported by the host. No Three.js/Remotion CDN/import is available in the offline renderer. If using Canvas2D, project actual3D vertices/triangles through a perspective camera with depth sorting and lighting; never substitute flat scrolling illustrations.

Labels belong to the world, e.g. painted signs or crates, not floating captions. Every beat shows a physical cause and effect synchronized to narration. Location transitions may dip to cream over0.4s. Keep outlines, proportions and palettes consistent.

## Narration and story
For typical40–60s stories use9–12 shots with immediate physical hook, escalation (but/then), conflict, a later You see pivot, So consequence and concise payoff. Plain words, no intro/outro or CTA. Short requested films condense this arc; respect requested duration. Nonfiction facts need verification; fictional briefs must stay clearly fictional. Actual generated voice timing takes precedence over estimated3.35 words/s.

## Vidmyo execution
Return the exact JSON schema requested by the host: script phase {script}, code phase {html}. The host produces narration first, passes measured duration/beats, calls window.renderFrame(t) deterministically, and renders locally. All geometry, textures, fonts and assets are procedural/inline; no external URLs, packages, downloads, clocks or animation loops. Design each pose and camera from supplied t, supporting seeking out of order. The host supplies all sound.

Check sample frames for obstructed/cropped faces, black openings, floating props, outline flicker, intersecting geometry, incorrect labels and camera clipping. Stills and the final rendered film must be reviewed; report limitations honestly.

This adaptation integrates the source visual method into Vidmyo's existing offline HTML renderer. It does not install the original Windows render.bat workflow or claim reference-video analysis that was not performed.
