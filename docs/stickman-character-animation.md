# Stickman character animation — reference analysis and local implementation

Date: 2026-09-22. Target machine verified with sysctl: Apple M2 Pro, 16 GiB unified memory.

## Reference and what was actually inspected

Reference: https://www.facebook.com/reel/1518644970022720 (whatthefun animation), 27.433s / 823 video frames. The public download available to watch was 356×632. No account cookies were used. The transcript was not needed and Whisper was disabled.

Viewed all nine scene-selected frames across the clip, then 16-frame sequences at 8 fps for 9–11s and 14–16s, plus a 2 fps sequence covering 21–27.4s. This is a dense visual motion analysis of selected passages, not a claim that all 823 frames were individually reviewed. Reference files are retained under `.tmp/stickman-motion/reference/` for follow-up.

- 0–2s: establishes a parking garage, several male characters, and an approaching female character. Then a closer framing emphasizes the interaction.
- 2–9s: dialogue, simple facial expressions and gestures. Bodies largely hold poses between actions. Captions and the persistent title are separate visual elements.
- 9–12s: walking changes leg/arm poses and moves a character through the environment. The camera also pans and cuts; the background is not screen-locked throughout the whole reel.
- 12–16s: a new two-person conversation, mouth changes, blinking, head/body reactions and arm gestures. Around 14–16s the environment is effectively still while the characters carry most of the motion.
- 16–21s: closer conversation shots, stronger expression changes and a punch-in to faces.
- 21–27s: returns to a wider two-character composition, the concluding exchange, and both characters walking away together.

The observed result is compatible with limited 2D/cutout animation. The frames do not establish which tool or model the original creator used. A static background plus articulated 2D characters can reproduce this category of motion without video diffusion.

## Video Delta decision

Read-only audit of `/Volumes/My Lexar/AI Projects/Video Delta/HANDOFF.md`: explicitly paused 2026-07-17 for throughput. Recorded 7–9 minutes per 2-second generated shot on this same hardware; one free bracketed LTX sample took 443 seconds. These are historical measurements, not a fresh benchmark. No LTX model was started and the paused repository was not changed.

Its reusable principle is to prepare assets once and composite moving elements. Its generative motion path is unnecessary for elementary stick-figure gestures, blinking and amplitude-driven mouths. A faster NVIDIA computer may support more ambitious generation, but no new generative performance claim was measured here.

## Stickman Video Director audit

Source: https://github.com/kaomei/stickman-video-director and its `skills/directing-stickman-videos/SKILL.md`.

This is a direction/prompt skill for cloud-generated clips, not a local rigging or render engine. Useful ideas: consistent character design, concrete actions, timed visual beats, separate narration, continuity between scenes. The implementation uses these general principles; it does not install the skill or copy its templates. The repository's model/price claims were not used as verified product facts. Its proposal/approval gates concern producing a clip package, not this code audit.

## Implemented behavior

- The visible Story workspace is now **Stickman**, including Channels handoff labels. Internal `story` IDs, URLs and saved projects remain compatible.
- **Characters → Not animated / Animated**, default Not animated for existing projects.
- Not animated retains the previous complete-illustration renderer with its existing framing/transitions. It means characters are not articulated, not that every pixel of the final video is static.
- Animated requests background-only images and separate validated character descriptions. Supports 1–3 local vector characters, named shirt/skin colors, facing and expression, idle/talk/wave/point/walk actions. At most one character talks per scene.
- Mouth opening follows a 30 Hz amplitude envelope extracted locally from the final voiceover. Silence closes the mouth. This is intentionally approximate mouth movement, not phoneme lip sync or multi-speaker diarization.
- Background geometry stays fixed within the animated scene. No per-frame generative model, depth model or AI segmentation is involved. Narration and image creation retain the user's existing chosen providers.
- Both automated image generation and the existing Google Flow image queue receive the background-only instruction. Changing animation mode invalidates the scene plan, image role and output cache so a complete old illustration is not silently reused as an empty background.
- Switching mode on an existing project requires new backgrounds. Arbitrary flattened PNG characters are not automatically rigged. The current original vector cast is intentionally simpler than the reference's custom character artwork. Faithful custom character design and intricate prop interactions require additional rig assets/actions.

## Measured performance

Existing installed Remotion 4.0.489 runtime, concurrency 2, H.264 CRF 18, 1080×1920, 30 fps; two characters plus an original still backdrop. Each measurement is a single run under current desktop load, not a hardware-wide guarantee.

| Case | Output | Wall time | Included |
| --- | --- | --- | --- |
| Initial motion sample | 6s / 180 frames | 10.09s | Renderer startup, frames, encoding |
| Longer motion sample | 30s / 900 frames | 30.42s | Renderer startup, frames, encoding |
| Actual creative bridge with audio | 7.533s video / 226 frames | 11.61s | Audio envelope, render, audio loudness normalization, output verification |

The final MP4 container is 7.6s because of AAC padding. These measurements exclude generating the background, writing the script, creating narration and first-time runtime installation. They establish that basic character animation is practical on this Mac; they do not predict AI video-generation speed or guarantee engagement gains.

Demo: `output/stickman-motion-demo.mp4`. Narration for this offline demonstration was produced by macOS Samantha; this does not change the product's selected voice provider. The end-to-end harness used a fixed plan and local supplied background, and performed real rendering/audio processing without contacting an image, text or voice API.

## Verification

- Core tests: 328/328 passed, including rig validation, deterministic motion, audio/silence envelope, legacy defaults, animation persistence, cache invalidation and the Flow-to-render path.
- Python creative director tests: 12/12 passed, including animated scene schema, public aspect/mode fields and invalid rig rejection.
- Studio build and Next production build passed. Node syntax and `git diff --check` passed.
- Browser: Stickman tab and workspace, default Not animated, switching to Animated and its explanation, and the prior 11-voice Kokoro dropdown verified.
- Actual bridge-produced MP4 verified: H.264 1080×1920 30 fps, AAC audio, full narration duration. Dense output frames inspected for independent character motion and fixed background.
- Live AI director/image-provider output quality has not been evaluated in this session; those boundaries used controlled offline inputs.

Further tuning should prioritize character design, purposeful gestures and consistent environments rather than restarting heavy Video Delta generation. Better engagement is a testable hypothesis, not an established result from this implementation.

## Studio cast and Codex Images (2026-09-22)

Keep two workflows in the existing Stickman section:

- **Not animated**: existing full-scene image workflow and camera/transition effects.
- **Animated → Studio cast**: independently rendered characters over an empty generated environment. Classic figures remain available and old projects retain their original design setting.

Studio cast adds stable hairstyles, glasses and clothing derived from cast IDs, more detailed faces and hands, shoes, restrained blinking, speech-amplitude mouth movement, and staged wave/point gestures. Idle feet stay planted. First appearance locks each actor's skin and shirt colors throughout the validated plan. The director chooses story-relevant physical actions, reactions and scene progression. This is still a procedural 2D cast, not arbitrary PNG character segmentation or a diffusion video model. It does not recreate any user-supplied character automatically. Full custom-character rigging needs separated artwork and joint/face definitions.

The [Stickman Video Director](https://github.com/kaomei/stickman-video-director) informed the approach to identity continuity, consistent art direction, concrete actions, clear visual progression and uncluttered caption space. Its cloud-video prompt workflow is not a local animation engine. No external character designs or source code were copied; its fixed ten-second scene format and retention claims were not adopted.

### Image sources

Google Flow queue/extension and existing image APIs remain available. **Codex Images · ChatGPT plan** is a separate creative-pipeline source; legacy Story API source catalogs are unchanged. It works for static illustrations and animated backgrounds. It requires an installed Codex CLI, ChatGPT sign-in and the native `image_generation` feature. The native tool currently uses GPT Image 2. No API key is required, and there is no automatic paid API fallback.

The executor uses an isolated asset directory, ignores unrelated user configuration, runs with workspace-write sandboxing, removes OPENAI_API_KEY, checks the saved PNG, and caches by image fingerprint. If a request was started but no valid image was saved, production stops rather than spending allowance again automatically. Check `images/codex/<fingerprint>/request.json` and the CLI result before deliberately clearing a failed request marker to retry. A completed PNG can be recovered without another submission. Do not clear a marker while production is active.

**Subscription limits:** OpenAI's [native image-generation documentation](https://learn.chatgpt.com/docs/image-generation) identifies GPT Image 2 and says image generation consumes the same general Codex limits, on average 3–5× faster than similar turns without images. The [Codex pricing documentation](https://learn.chatgpt.com/docs/pricing#image-generation-usage-limits) explains included limits and credits. The ChatGPT Pro marketing claim about unlimited image creation must not be presented as unlimited automated Codex image generation. Buying Pro is not required simply to expose this source; availability depends on the user's actual Codex plan, remaining limits and account.

### Verification

- A real signed-in Codex CLI 0.149.1 native generation produced a 941×1672 PNG without an image API key or Flow extension. This was a single generation, not a sustained throughput benchmark.
- New demo: `output/stickman-studio-demo.mp4`. Native-generated cafe background plus Studio cast and existing local narration. The background has a realistic treatment; final production should ask the selected provider for illustration styling matching the cast.
- Real creative-bridge render: 7.512 seconds of narration, 226 frames at 1080×1920/30fps, 12.919 seconds for render/audio mastering/output validation on the M2 Pro. Image generation is excluded from that measurement.
- Automated checks cover source isolation, API-key removal, isolated command execution, asset reuse, uncertain-submission protection, cast continuity and old/new design persistence. Actual native CLI availability can still vary by account/version.

User decision: Google Flow remains the default and the alternative for every image when native Codex access/allowance is unavailable. Switching the image source preserves the existing script and narration, invalidates image assets and exports the original Flow queue; it does not silently switch to a paid API.

### Art direction revision: stick arms
Studio cast now uses simple dark line arms and three-stroke hands, retaining the upgraded faces and clothing. This intentionally minimal treatment follows user feedback on the thick-arm sample. Updated preview: `output/stickman-studio-stick-arms-demo.mp4`. Renderer cache version 4 forces existing projects to render the revised design.

### Reference-aligned limbs (2026-09-22)
Rechecked the retained frame grids of the Facebook reel, especially the walking and dialogue shots. Visible character styling: large expressive heads, simple filled shirt/dress silhouettes, narrow dark line arms **and legs**, minimal hands, and short foot marks. Animation is limited pose changes, walking, mouth/expression changes, and occasional scene camera movement. The frames do not identify the original software or rigging method. Studio cast now uses matched thin line arms and legs with short foot strokes; filled trousers and sneakers were removed. Renderer cache version 5 refreshes prior Studio cast renders. `output/stickman-reference-limbs-demo.mp4` shows the revision. The existing cafe background remains from the prior sample; its visual style differs from the illustrated reference backdrop.

### Three-beat story and Kokoro sample (2026-09-22)
The initial single-scene demo understated the available direction. `output/stickman-cafe-story-kokoro.mp4` now shows three timed scenes: wave, short conversation with one talking actor, and a restrained walk together. Stable cast IDs preserve hair/clothes/skin across scene cuts; the identity hash now yields visibly different hairstyles/accessories for the sample actors. Eyes glance subtly, talking triggers one staged hand gesture and speech-reactive head movement, and walking uses a smaller stride. All rendered from the existing cafe background, not a new image generation.

This sample uses real local Kokoro `af_heart` narration (8.075 seconds); the final project's voiceover WAV matches the generated Kokoro WAV byte-for-byte. Previous benchmark demos used a macOS Samantha placeholder. Actual projects continue to use the voice selected in Stickman, including Kokoro, Voicebox, or ElevenLabs where configured. A single narrator's amplitude still cannot identify which on-screen actor is speaking; director action selection chooses the actor and mouth opening follows the mixed narration envelope. True character dialogue/speaker turns need per-speaker audio timing.

The local Kokoro environment was installed for this check. `scripts/setup_env.sh` was fixed to quote the venv path when using `uv`, because this project lives under `/Volumes/My Lexar/...`; the original unquoted path failed immediately. The revised setup completed and verified its modules. The 8.075-second 1080×1920/30 fps 243-frame sample rendered/mastered/validated in 13.81 seconds on the M2 Pro after TTS generation and background creation.

The reference still has stronger custom drawings, story-specific poses, facial acting and background/style cohesion. Those are artwork/director constraints, not proof of a hardware speed limit. This local procedural rig is an improved baseline, not the upper bound for character animation on this Mac.
