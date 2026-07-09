# Plan: Fix the Higgsfield Cloud API 401 + verify the Higgsfield MCP connect

**For:** any implementation agent (written to be executed without prior conversation context)
**Repo:** `/Volumes/My Lexar/AI Projects/Vidmyo`, branch `feat/providers-agents-dock`
**Starting commit:** `7d77384` (wip: Higgsfield MCP buttons + API adapter, UNVERIFIED)
**Read first:** `HANDOFF.md` at the repo root (invariants), then this file. Do NOT re-read the whole history.

## Context (all of it — trust this, don't re-derive)

Vidmyo is an Electron app whose UI is a Next.js dev server: Luke launches
`~/Desktop/Start Vidmyo + Video Delta.command` → `npm run dev` on **:3210** → Electron window
at `/studio`. **Renderer changes hot-reload; anything under `electron/` needs the Vidmyo window
restarted.** Provider API keys live in the macOS keychain (`electron/lib/secrets.js`,
`getSecret(id)`), saved via the in-app Settings modal.

Two Higgsfield integrations exist as of `7d77384`:

1. **Hosted MCP** (`https://mcp.higgsfield.ai/mcp`, account OAuth, no API key) — "Connect
   Higgsfield MCP" buttons in the Agents tab call `agents:installMcp(agentId, 'higgsfield')`
   in `electron/lib/agents.js`, which runs
   `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp`
   (Codex: `codex mcp add higgsfield --transport http <url>`; others get copy-paste
   instructions). **Status: built, never executed.**
2. **Cloud API adapter** (`packages/core/src/adapters/higgsfield.js`) used by the Image tab
   (Higgsfield model option) via `electron/lib/mediaBridge.js` (`provider: 'higgsfield'`,
   keychain key id `higgsfield`). **Status: BROKEN — Luke's live test returned
   `Higgsfield submit 401: {"detail":"Invalid credentials"}`.** The adapter's wire format was
   inferred from secondhand docs: `POST https://platform.higgsfield.ai/v2/<endpoint>` with
   `Authorization: Key KEY_ID:KEY_SECRET` and body `{ params: {...} }`, polling
   `GET /v2/requests/<id>`. Some or all of that is wrong.

Luke's key is already saved in Settings under **higgsfield**. The 401 has a JSON `detail`
body, so the host is right and auth is wrong — likely the header scheme, the key format
(single key vs `ID:SECRET`), or both.

## Invariants (violating these = failed task)

- ONE app: UI lives in `components/StandaloneShell.js` + `packages/studio/src/components/*.jsx`.
  Never recreate the deleted `src/` Vite renderer.
- Keys only via keychain (`getSecret` in main process; Settings modal in renderer). Never log
  or echo key values — in probes below, read the key into a shell var and never print it.
- Provider catalog entries only in `packages/core/src/providers.js`.
- Don't touch anything under `/Volumes/My Lexar/AI Projects/Faceless YT 1/`.
- After each step: `cd packages/core && npm test` must stay green (53+ passing), and
  `node --check` every edited `electron/*.js` file.
- Commit in small steps with clear messages ending in the Co-Authored-By line used in
  `git log` (see recent commits).

## Task 1 — Establish the REAL Cloud API wire format (no guessing)

The official SDK is the ground truth. Extract it:

```bash
cd /tmp && npm pack @higgsfield/client && tar -xzf higgsfield-client-*.tgz
grep -rn "platform.higgsfield.ai\|Authorization\|hf-api\|api-key\|api_key" package/dist package/src 2>/dev/null | head -40
# Find: (a) exact base URL, (b) exact auth header name+format, (c) submit path pattern
#       (is it /v2/<endpoint>? /v1/...? no prefix?), (d) request body shape ({params:...}
#       vs {input:...} vs flat), (e) poll path + status field + result URL field.
```

If the npm package doesn't exist under that name, try `npm search higgsfield` and
`higgsfield-client`; also the Python SDK `pip download higgsfield-client` works. As a last
resort read https://github.com/higgsfield-ai/higgsfield-js source files directly.

Then confirm auth cheaply WITHOUT burning a generation (expect 401 vs 404/405 differences —
404/2xx on a bogus id means auth passed). Key is in the keychain; fetch it in Node via
Electron is awkward from a script, so ask Luke to export it for one command OR read
`~/Library/Application Support/vidmyo/secure-keys.json` is ENCRYPTED — do not try. Simplest:
ask Luke to run, replacing `$HF` (he knows the key; do not echo it):

```bash
for H in "Authorization: Key $HF" "Authorization: Bearer $HF" "hf-api-key: $HF"; do
  printf '%s -> ' "${H%%:*} ${H#*: }" | sed 's/ .*:.*/ [redacted]/'
  curl -s -o /dev/null -w '%{http_code}\n' -H "$H" https://platform.higgsfield.ai/v2/requests/00000000-0000-0000-0000-000000000000
done
```

(Adjust the path to whatever the SDK showed.) The variant returning non-401 wins.

## Task 2 — Fix `packages/core/src/adapters/higgsfield.js`

Update to the verified format: base URL, header, submit path, body shape, poll path,
status values, result-URL field (`findMediaUrl` already tolerates several shapes — trim it
to the real one plus one fallback). Remove the "⚠ VERIFY" header comment and replace it with
"Verified against @higgsfield/client vX.Y on 2026-07-__".

If the API turns out to use a single API key (not `ID:SECRET`), also update:
- the `description` of the `higgsfield` entry in `packages/core/src/providers.js`
  (currently says "Key format: KEY_ID:KEY_SECRET"),
- the error hint in `electron/lib/mediaBridge.js` ("format KEY_ID:KEY_SECRET").

Add a unit test in `packages/core/test/` mirroring `run.test.js`'s fake-fetch pattern for
the fal adapter: fake submit → poll pending → completed → media bytes; plus a 401 case
asserting the error text includes the response body. Suite must pass.

## Task 3 — Live verification (needs Luke, ONE paid/subscription generation)

1. Tell Luke to restart the Vidmyo window (launcher) — main-process files changed.
2. Image tab → model "Higgsfield · Flux Pro Kontext Max" → short prompt → Generate.
3. PASS = image renders inline + file in `~/.vidmyo/artifacts/`. If it fails, the bridge
   surfaces the provider's error verbatim — iterate on the adapter, not the UI.
4. On pass, remove the "(beta — verify)" suffix from the Higgsfield option label in
   `packages/studio/src/components/CloudImageStudio.jsx`.

## Task 4 — Verify the Higgsfield MCP connect (needs Luke)

1. After the same restart: Agents tab → Claude Code → **Connect Higgsfield MCP**.
   Expect the green note. Under the hood it ran
   `claude mcp add --transport http --scope user higgsfield https://mcp.higgsfield.ai/mcp`.
2. Verify registration: `claude mcp list` in a terminal should show `higgsfield`.
3. Luke opens a new Claude Code session → first Higgsfield tool use triggers the browser
   OAuth (sign in with his Higgsfield account) → ask Claude to e.g. list Higgsfield models.
4. Codex path: click Connect Higgsfield MCP on Codex; if `codex mcp add --transport http`
   isn't a real Codex flag (likely — verify with `codex mcp add --help`), fix
   `electron/lib/agents.js` to Codex's actual syntax or fall back to the manual card.
5. Optional polish: hide/disable the Higgsfield button for `hermes`/`opencode` unless their
   configs support remote http MCP servers — check quickly; manual instructions are fine.

## Task 5 — Wrap up

- Commits: one for the adapter fix (+test), one for any MCP command fixes, one for docs.
- Update `HANDOFF.md`: mark the Higgsfield API as verified (or precisely what failed),
  note the MCP verification result.
- Append one summary line each to
  `/Volumes/My Lexar/Obsidian/Omi/Omi/daily-logs/<today>.md` and
  `/Volumes/My Lexar/Obsidian/Omi/Omi/agent-shared/vidmyo.md`.

## Acceptance criteria

1. Image tab generates a real image via Higgsfield with Luke's stored key (artifact on disk).
2. `claude mcp list` shows `higgsfield`; a Claude Code session can call a Higgsfield tool
   after OAuth.
3. Core suite green; `node --check` green on all edited electron files.
4. No key value ever printed/logged; no files under Faceless YT 1 touched.
