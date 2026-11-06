# Animation source credits

Catalog imported 2026-11-05; numbers are stored explicitly and remain stable.

| Numbers | Collection | Attribution and use |
| --- | --- | --- |
| 1–3 | Existing Vidmyo styles | Original pipelines retained |
| 4–89 | [Futurepedia AI Style Atlas](https://www.futurepedia.io/resources/ai-style-atlas/view) | Style names, categories and source-hosted reference previews. Vidmyo technique guides are original; no demo asset is used in generated films. |
| 90–155 | [Lemo-Opuscar](https://github.com/lemomo-ai/lemo-opuscar) | LemoLab × Claude Opus 5.5. Style documentation MIT; visual demos CC BY 4.0. The linked videos are unmodified references; demo audio has separate exclusions. |
| 156–170 | [MG Styles 15](https://github.com/Vincentwei1021/mg-styles-15) | Vincentwei1021. Code, prompts and demos MIT; third-party assets keep their own terms. |

Lemo guides and MG prompts are included under their MIT license (bundled under
`packages/core/assets/animation-guides/`). The renderer adapts their visual
direction to Vidmyo's offline frame contract; external installation commands in
a guide are reference text, never commands executed by the pipeline.

Additional research supplied by Luke:

- [Editable workflow document](https://docs.google.com/document/d/1romWYhQqQ5aoRxPUj7E-KfwKTCHRTJ3u/edit)
- [Jason Zhu prompt library](https://jasonzhu.ai/en/prompts/claude-opus-5-5)
- [Claude artifact](https://claude.ai/artifact/V2ZdmTZ3o6MUYG7ffBVWkw): artifact frame was unavailable during research; no styles are claimed to have been extracted from it.
- [Charlie Hills motion graphics](https://charliehills.substack.com/p/opus-55-motion-graphics): page unavailable during research.
- Supplied YouTube URLs Ge1B-Ok1Pfk, uz_A4tERTT0 and N1eYQDVrVHs: direct reads were throttled; implementation is grounded in the readable document, original repositories and Atlas data, not claimed video transcripts.

Official voice references:

- [Clipchamp free AI voiceovers](https://clipchamp.com/en/features/ai-voice-over-generator/)
- [Clipchamp ten-minute audio](https://clipchamp.com/en/blog/text-to-speech-update/)
- [OpenAI separate ChatGPT/API billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform)

## #171 — Ink World Stories (3D + 2D)
User-supplied Drive folder: https://drive.google.com/drive/folders/11AuNQZIFQaw7pM0qjlv0-KUFQV0AgXQy . Inputs: animated-story-video.skill.zip (animated-3d-story-video/SKILL.md) and Claude 3D Animation Master Prompts.pdf. The packaged guide adapts the visual/story rulebook to Vidmyo’s offline deterministic HTML renderer; no reference-video frames or third-party code/assets are redistributed. The gallery poster is a frame of the original procedural demonstration; the local video preview is labelled as a Vidmyo-generated demonstration. The preview code is in packages/core/assets/animation-demos/ink-world-story.html, authored locally after the live ChatGPT code phase failed; it is not evidence of successful browser code generation. Original Windows handover and interactive approval flow are replaced by the user-requested automated local pipeline.
