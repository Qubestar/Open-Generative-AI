# Vidmyo capability hub

Vidmyo should own stable video capabilities, not expose third-party agent skills as its product surface.

## One capability, three entry points

Each feature is implemented once behind a versioned local contract:

1. **Vidmyo UI** collects choices, previews evidence, and keeps approval with the user.
2. **Vidmyo MCP** lets the agent in the Agents panel read bounded evidence and submit the same structured decisions.
3. **Provider adapter** lets the UI request decisions from an installed subscription agent or an explicitly configured API.

Deterministic work—media inspection, transcription, boundary detection, rendering, validation, and recovery—stays inside Vidmyo. The AI receives only the evidence and schema needed for the judgment step. Credentials never enter project artifacts.

## How to adopt another skill

Treat a skill as a product and implementation reference:

1. Audit its license, dependencies, hidden costs, supported inputs, and failure behavior.
2. Extract the useful user decisions and the smallest AI judgment contract.
3. Rebuild or adapt deterministic execution behind a Vidmyo-owned versioned schema.
4. Add reversible review and local evidence before any irreversible or paid step.
5. Expose the capability through both UI and MCP; do not distribute the original skill or prompt to users.
6. Test the provider boundary with mocks and the media boundary with real local fixtures.

MIT/Apache/BSD components can usually be integrated with their required notices. Copyleft, source-available, token-gated, or unclear licenses need a separate decision before code reuse.

## Effort guide

- **Low effort:** a new provider adapter for an existing structured capability.
- **Medium effort:** a new UI over an existing deterministic engine and contract.
- **High effort:** a new media capability that needs timing, recovery, preview, and quality validation.

The expensive part is making media edits reliable, not connecting another model. Once a capability contract exists, adding compatible agents and APIs is comparatively small work.

## Cleaner v1

Cleaner is the first complete example of this pattern:

- local inspection and faster-whisper transcription;
- waveform speech blocks with a safe transcript fallback;
- conservative retake/false-start decisions from a selected installed agent or OpenRouter in the UI;
- current-agent decisions through MCP without spawning a nested agent;
- reversible segment review;
- local FFmpeg MP4 export only after review;
- no publishing or automatic upload.
