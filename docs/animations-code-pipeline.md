# Animations: narrated films from code

The existing **Animations** workspace now contains 170 stable numbered styles.
Styles 1–3 keep the original image/Remotion pipelines. Styles 4–170 use a separate
HTML-frame renderer. Existing project IDs and pipeline contracts remain readable.

1. Select a style by number/name and compare its source-linked example.
2. Enter an idea or select the existing Google Sheets/channel-planning brief.
3. Choose a connected director, voice and review stops.
4. Vidmyo writes narration, creates the voiceover, measures its speech intervals,
   generates self-contained animation code against those intervals, then renders
   and masters a local MP4. Code styles automatically use **Not needed** for images.

Code generation uses the selected signed-in local CLI, OpenRouter account, or
Zenborg Browser. Rendering does not call a text-to-video model. Subscription and
browser-plan limits still apply; this feature does not promise unlimited access.
English Kokoro is local. Voicebox uses installed local voice profiles. ElevenLabs
uses the existing approval and paid-account boundary. Clipchamp remains an external
option; this implementation does not automate Clipchamp or extract ChatGPT Voice.

## Zenborg Browser in the desktop UI

Choose **Zenborg Browser**, refresh the connection, select a browser-agent profile,
and create the project. Vidmyo talks to the installed Zenborg MCP connector, not
the browser directly. It autodetects the development sibling or installed app;
**Locate Zenborg** selects `zenborg-mcp.js` if needed. No credential is copied into
the project or browser animation. Sign-in, human verification and quotas are
handled in Zenborg. A rejected MCP connection must be reconnected in Zenborg Settings.

Dispatch receipts preserve session/run IDs before polling. Resume reuses a known
run; uncertain submissions are never resubmitted automatically. **Retry failed
browser task** permits a new attempt only after checking that the old run is
terminal. Stopping local production does not cancel a remote browser task.

## Agent/MCP workflow

`animations_styles` → `animations_create` → `animations_set_script` →
`animations_prepare` → poll `animations_get_job` → `animations_code_task` →
`animations_submit_code` → `animations_render` → poll `animations_get_job`.

The calling agent writes the script and HTML itself; MCP does not launch another
LLM or spend image/API credits. Preparation uses installed English Kokoro and
Whisper tools. For another language use the desktop Voicebox/ElevenLabs path.
Planned topics can come from the existing Sheets/channel tools and be passed as
the topic/details to `animations_create`.

## Renderer boundary

Generated HTML implements `window.renderFrame(timeSeconds)`. It runs in a new
headless Chrome process inside an opaque-origin iframe with sandboxed scripts.
A trusted CSP is inserted before untrusted HTML. Network/file requests are
blocked; remote libraries, downloads, host filesystem access and audio inside the
frame are unsupported. Draw inline Canvas/SVG/CSS/WebGL; use inline assets.
FFmpeg adds narration outside the frame and masters to −14 LUFS / −1.5 dBTP.
FFprobe verifies dimensions, duration and required audio before completion.
Three frame previews and measured JSON evidence are saved under `artifacts/`.

Processes use the shared heavy-work governor and process-tree cancellation.
A per-project owner/nonce lock prevents desktop/MCP writers from overlapping;
dead process owners are recoverable. Narration and code are retained after render
failure. Render output is written to a temporary MP4 and promoted after verification.

## Publishing boundary

This change produces a local MP4. It does not turn the existing Publisher's
loopback mock transport into production social publishing. The current app has
no complete production upload action in the desktop bridge. Automatic YouTube,
Instagram or TikTok publishing needs configured destinations, real upload
adapters and their own verified completion/retry behavior before it can be offered
as a working pipeline. Do not label a mock upload as a published film.

## Reference collections and licenses

See [animation-sources.md](animation-sources.md). Reference previews remain on
their original hosts, display attribution and are never merged into generated
films. Atlas guides are original Vidmyo technique notes, not copied prompt text.

Verification artifacts are generated under `.tmp/animations-*`. No production
publishing or paid generation is needed for the isolated test suite.
