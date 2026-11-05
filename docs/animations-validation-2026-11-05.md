> Aktualizacja: błąd uwierzytelnienia został naprawiony. Aktualna diagnoza i blokada browser dispatch: [raport](zenborg-investigation-2026-11-05.md). Poniższy zapis zachowuje wcześniejszy stan weryfikacji.

# Animations validation — 2026-11-05

Implemented locally in the existing Animations workspace: 170 stable numbered styles
(3 original + Atlas86/Lemo66/MG15), source-linked example playback, search/filter,
code-style Not needed images, Agnes removed from image option lists, narration-first
code renderer, GUI Zenborg Browser connector and ten MCP animation tools.

## Evidence

- Final optimized Next.js production build: exit 0. See ../.tmp/animations-build.json.
- Full isolated core suite before final receipt hardening: 722 passed, 0 failed,
  0 skipped; home-isolation guard PASS. See ../.tmp/animations-final-core-full.log.
- Final focused regression suite after receipt/lock hardening: 44 passed; all MCP
  tests: 52 passed. See ../.tmp/animations-qa/unit.json and unit.log.
- New Python coder contract: 3 tests passed, no live provider called.
- Real Chrome/FFmpeg render with actual local Kokoro narration: 7.1s, 640×360,
  H.264 with audio; 86 frames at 12fps; three differing preview frames; zero
  attempted network requests reached the local probe server. See
  ../.tmp/animations-render-smoke/verification.json and animation.mp4.
- Automated browser UI: seven checks pass, desktop/mobile screenshots in
  ../output/playwright/animation-qa/. Independent W2 first-user review: no open
  findings, ../output/playwright/firstuser-animations/findings.json.
- Changed-file gitleaks scan: exit0, 205 files, zero findings. Report redacted.
- Graphify AST update: exit0; 3786 nodes, 7969 edges. No semantic/API extraction.

The render smoke uses an original deterministic tree animation fixture. It proves
rendering, audio muxing, seeking and sandbox boundaries; it does not claim 170
complete provider-generated films or a live browser-agent generation run.

## Explicit limits / release gate

Zenborg status was checked read-only through the actual connector; the request is
currently rejected. Browser-agent generation is implemented but not verified live.
Reconnect Vidmyo/agent access in Zenborg Settings before a live test. No credentials
were copied or edited, no browser model turn or paid provider generation was made.

The repository-wide QA release gate is RED (qa_ship exit1). K2 found no configured
typecheck, historical gitleaks timed out, SAST errors in unchanged Dockerfile and
afterPack.js, and npm audit reported existing dependency vulnerabilities. The gate
also lacks its standardized W1/W2 artifacts, mutation/rollback evidence and a clean
committed build. Independent review and custom sandbox/UI evidence above are
recorded honestly, not substituted into qa/runs/ to make the gate green.

No signed installer was produced or installed. Existing installed Vidmyo was not
restarted. The isolated preview runs at http://localhost:4325/studio/animations
(PID recorded in ../.tmp/animations-next-pid.json). Original dirty Open-Poe-AI
submodule was preserved.

The new path outputs a local MP4. Existing desktop Publish is mock-only; production
social publishing is not implemented by this change. ChatGPT subscription is not
assumed to include unlimited API TTS. Clipchamp remains an external option.

See [pipeline contract](animations-code-pipeline.md) and
[source credits](animation-sources.md).
