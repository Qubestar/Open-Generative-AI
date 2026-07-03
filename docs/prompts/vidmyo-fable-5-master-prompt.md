# Vidmyo — Claude Fable 5 Master Product, Architecture, and Commercialization Prompt

> Paste this entire prompt into Claude Fable 5 with the Vidmyo repository mounted as the working directory.
>
> Recommended model configuration: `effort: xhigh` for the initial audit and architecture run; `high` for later implementation phases. Enable streaming, long client timeouts, and asynchronous progress updates because this is a long-horizon task.

---

<role>
You are the principal product architect, senior full-stack/Electron engineer, AI-media pipeline engineer, developer-platform designer, and pragmatic SaaS launch strategist for Vidmyo.

Your job is to turn the existing Vidmyo repository into an implementation-ready, commercially viable product: a standalone desktop AI-media studio that can also be controlled by AI agents through a stable MCP server and CLI.

This is an existing system, not a greenfield rewrite. Preserve working capabilities, identify drift and duplication, and evolve the product through small, verifiable milestones.
</role>

<larger_intent>
Vidmyo should let ordinary creators produce images, videos, and complete narrated stories affordably, including on modest hardware such as a 16 GB Mac mini M2 Pro. Users should be able to work through the desktop UI or ask a connected agent such as Claude Code, OpenAI Codex, Gemini CLI, Hermes, or OpenCode to perform the same operations.

The first sellable wedge is the existing faceless YouTube doodle-video workflow. The broader vision is a provider-neutral AI-media operating layer that can use local models, user-supplied API keys, browser-driven Google Flow workflows, and paid cloud providers without locking the user into one vendor.

The business must be launchable quickly and sold on a recurring monthly plan, while preserving affordable bring-your-own-key and local-compute paths.
</larger_intent>

<terminology>
- Interpret “MPC” as “MCP” unless repository evidence proves otherwise.
- Interpret “Cloud Code” as “Claude Code.”
- The product name is **Vidmyo**.
- **MAIOX is a separate project. Do not merge or conflate it with Vidmyo.**
- **Video Delta is a separate local Python video-compositing/generation engine.** Vidmyo may connect to it, launch/configure it, and expose it through MCP/CLI, but should not silently absorb its source or misrepresent it as ordinary cloud text-to-video.
- “Story Studio” means the end-to-end story/video pipeline whose first production style is the existing faceless YouTube doodle workflow.
- “Google Flow workflow” means the proven authenticated Chrome Computer Use/browser workflow using Google Flow and its image/video models. Do not invent or depend on `gflow-cli` or `cua-driver`.
</terminology>

<repository_protocol>
Before proposing architecture or changing code:

1. Read `AGENTS.md` completely and obey it.
2. Read, in order:
   - `/Volumes/My Lexar/Obsidian/Omi/Omi/working-context.md`
   - the last ten entries of `/Volumes/My Lexar/Obsidian/Omi/Omi/mistakes.md`
   - today’s `/Volumes/My Lexar/Obsidian/Omi/Omi/daily-logs/YYYY-MM-DD.md`
   - `/Volumes/My Lexar/Obsidian/Omi/Omi/agent-shared/Vidmyo.md`, if present
3. If `graphify-out/GRAPH_REPORT.md` exists, read it before searching raw source.
4. If `graphify-out/wiki/index.md` exists, navigate the wiki before reading broad sets of raw files.
5. For cross-module questions, use `graphify query`, `graphify path`, or `graphify explain` where useful.
6. Before any non-trivial work, create or refresh:
   - `.tmp/context.md`
   - `.tmp/todos.md`
   - `.tmp/insights.md`
7. Check `directives/` before inventing a workflow and `execution/` before inventing a script.
8. Never read or print secret values from `.env`, credential files, keychains, or local agent authentication files. You may inspect only whether a required variable or credential is present.
9. Treat README claims as claims to verify, not automatic truth. Confirm important capabilities in current code.
10. After modifying code, run `graphify update .`. If Graphify refuses an update, do not guess force flags repeatedly; report the refusal and continue with other verification.
</repository_protocol>

<known_repository_baseline>
Verify every item below against the current checkout, then label it as one of:
`working`, `partial`, `stub`, `duplicated`, `stale`, `broken`, or `not found`.

## Application and packaging

- Product metadata currently describes Vidmyo as an open-source AI image, video, cinema, and lip-sync studio.
- The repository contains both a Next.js/React monorepo surface and a Vite/Electron desktop surface.
- Desktop packaging exists through Electron Builder for macOS arm64/x64, Windows x64, Linux AppImage, and Debian packages.
- The package currently declares version 1.1.0.
- The app has historically shipped unsigned/not-notarized builds that require Gatekeeper/SmartScreen workarounds. Treat signing, notarization, update delivery, and trust as commercialization requirements.
- The root workspace currently depends on submodules/workspaces for Vibe Workflow and Open Poe AI. An isolated checkout has failed because the pinned Open-Poe-AI commit `cb12973823b15a50329ff34ed28491c73681a2ab` is unavailable. Investigate and propose a robust dependency/bootstrap correction.

## Existing user-facing studios and product surfaces

- Image Studio
- Video Studio
- Lip Sync Studio
- Cinema Studio with camera/lens controls
- Workflow Studio using a node-based workflow builder
- Agent Studio
- MCP & CLI Studio
- Local Model Manager
- A Video Delta Studio component in the shared studio package
- Settings surfaces for providers, integrations, and local models
- Upload history, generation history, downloading, pending-job persistence, and job resumption

The requested top-level product navigation should ultimately make **Image**, **Video**, and **Story** the clearest primary creation tabs. Existing specialist surfaces such as Lip Sync, Cinema, Workflows, Video Delta, Agents, and MCP/CLI should be retained but reorganized logically rather than deleted.

## Existing media capabilities

- Text-to-image and image-to-image
- Text-to-video and image-to-video
- Multi-image reference input for compatible models
- Lip sync from portrait/video plus audio
- Dynamic model-specific controls for aspect ratio, duration, resolution, quality, and other supported parameters
- Cinema prompt construction with lens, focal length, and aperture controls
- Asynchronous submit/poll patterns
- Local upload and generation history

## Provider and model layer

The code contains provider definitions or integrations for several of the following. Verify actual end-to-end support separately from mere catalog entries:

- MuAPI
- fal.ai
- OpenRouter
- OpenAI
- Anthropic
- Google/Gemini
- xAI
- HeyGen
- Runway
- Luma
- Pika
- Kling
- Recraft
- DeepSeek
- Moonshot
- Qwen/Alibaba
- SiliconFlow
- Fireworks
- Together
- Groq

The provider catalogs in `src/lib/providers.js` and `packages/studio/src/providers.js` appear to have drifted. Audit them and recommend a single source of truth.

Higgsfield is a requested provider/integration but is not proven as an implemented provider. Determine what Higgsfield officially supports at implementation time: public API, MCP, CLI, browser workflow, or affiliate/deep-link only. Do not fabricate an integration surface.

## Local inference

- A bundled `stable-diffusion.cpp`/`sd.cpp` path exists for local image generation.
- The catalog includes Z-Image Turbo, Z-Image Base, DreamShaper 8, Realistic Vision 5.1, Anything v5, and SDXL Base.
- Apple Silicon Metal acceleration is a target.
- A 16 GB Mac can run selected local models, but memory-heavy paths require guardrails. An 8 GB machine must not be encouraged to run configurations known to hang the system.
- Wan2GP exists as a bring-your-own remote server integration for Flux, Qwen Image, Wan 2.2, Hunyuan Video, and LTX Video. It is not a native Apple Silicon runtime.
- Bonsai Image Studio and ComfyUI provider bridges exist in the Electron code and should be verified.
- Local and cloud models currently share portions of the studio UI.

## Agent integration

- The Electron main process contains an agent bridge that detects installed CLIs through the user’s login shell, checks coarse authentication status, launches login flows in a visible terminal, and opens an agent at a selected working directory.
- Known agent targets include Claude Code, Codex, Gemini CLI, Hermes, and OpenCode.
- The bridge can bootstrap Generative Media Skills.
- Agent credentials should remain owned by each agent. Vidmyo should not imitate or replace their OAuth flows.
- The current interaction mostly launches external Terminal sessions. The requested target is a better experience in which choices made in Vidmyo can seed a new agent session with the selected project, provider, style, aspect ratio, and workflow.

## MCP

- `mcp/server.js` already exposes a stdio MCP server named `vidmyo`.
- Existing Video Delta-facing tools include capability discovery, single-video creation, multi-shot film creation, reframing, element insertion, job polling, publishing, and publish-status discovery.
- MCP media operations are asynchronous and return job IDs.
- The MCP README identifies cloud image/video/provider tools as a later milestone.
- This existing MCP server is the seed of the product’s stable agent-facing API, not something to discard casually.

## Video Delta

- Video Delta runs separately, normally at `http://127.0.0.1:7861`.
- Vidmyo contains a thin HTTP client and a shared UI component for it.
- Existing concepts include:
  - short local clips using LTX
  - a faster composite mode
  - multi-shot films
  - aspect ratios such as 16:9, 9:16, 1:1, and 4:5
  - reframing
  - inserting an element into footage with depth-aware placement/occlusion/shadow
  - optional title, narration, captions, and crossfades
  - social publishing through n8n or native routes
- Current generations can look visually good while lacking semantic continuity, prompt fidelity, scene logic, and identity consistency. Treat this as a research/quality track with objective evaluation, not a vague prompt-tuning task.

## Existing constraints and known lessons

- During authenticated Chrome Computer Use production in Google Flow, the controlled Chrome tab must remain untouched. The user may work in Safari, Firefox, another Chrome profile, or another device.
- Generate and verify one Google Flow scene at a time unless a newly verified batch mechanism exists.
- Resolve story prompts by explicit scene/beat ID, never by assuming scene number equals text-file line number.
- Do not trust claimed batch downloads until files are actually present and visually verified.
- Do not expose API keys in logs.
- Existing localStorage key storage is insufficient for a polished paid desktop product; evaluate OS keychain-backed storage.
</known_repository_baseline>

<target_product>
Design Vidmyo as two synchronized interfaces over one capability layer:

1. **Vidmyo Desktop** — a standalone creator application for people who prefer visual controls.
2. **Vidmyo Agent Extension** — a CLI plus MCP server through which Claude Code, Codex, Gemini CLI, Hermes, OpenCode, and other compatible agents can discover and run the same workflows.

The desktop app and agent interfaces must call the same provider registry, capability schemas, job system, project manifests, artifact store, and workflow engine. Do not implement separate business logic per UI.

The user must be able to start a job in one interface and inspect or continue it in the other.
</target_product>

<primary_experiences>
## 1. Image Studio

Create or refine images through:

- local engines
- user-supplied API providers
- MuAPI/fal.ai or other configured aggregators
- Google API where supported
- authenticated Google Flow browser automation
- Higgsfield only through officially available mechanisms
- reusable workflow templates

Controls should be capability-driven rather than hard-coded:

- provider and model
- text-to-image or image-to-image/edit mode
- one or multiple reference images
- style preset
- aspect ratio and explicit pixel resolution where supported
- quality, steps, guidance, seed, number of outputs, safety/provider-specific options where legitimately supported
- cost and expected duration estimate before submission
- local/cloud/browser execution badge

## 2. Video Studio

Support:

- text-to-video
- image-to-video
- start/end-frame workflows where supported
- video-to-video/editing where supported
- local Video Delta and compatible local/remote engines
- cloud APIs and browser-driven Google Flow
- aspect ratio, resolution, duration, frame rate, motion, camera, consistency, and cost controls based on model capability
- asynchronous jobs, pause/cancel where the provider permits it, retry, provenance, and artifact history

## 3. Story Studio

Story Studio is the flagship sellable workflow. Its first reliable template is the existing **faceless YouTube doodle video** pipeline. Architect it as a style-neutral story engine so later templates can support cinematic, collage, anime, motion-graphics, 3D, whiteboard, Google Flow/Veo, and other animation styles without rewriting orchestration.

The workflow should guide the user through:

1. project brief, topic, audience, platform, desired duration, language, and call to action
2. research/source ingestion with citations when factual content is required
3. outline and beat sheet
4. script
5. scene plan with stable scene IDs
6. style bible and character/subject consistency references
7. per-scene image prompts and negative constraints
8. image generation source selection
9. visual review and regeneration
10. animation/video source selection
11. voiceover source selection
12. music and sound effects
13. captions
14. edit/timeline assembly
15. continuity and semantic quality review
16. render, reframe, export, and optional publishing

The user must be able to select defaults globally and override them per scene.

Required source choices:

- image source: local, fal.ai, Google API, Google Flow/browser, MuAPI, Higgsfield if supported, and future provider plugins
- animation/video source: local Video Delta, Google Flow/Veo, fal.ai or other configured providers, and future plugins
- voiceover source: local TTS plus ElevenLabs initially, with a provider interface for future voices

For ElevenLabs:

- provide a clearly labeled configuration card
- store the API key securely
- include a configurable affiliate URL in the appropriate empty/unconfigured state
- clearly disclose that it is an affiliate link
- never make an affiliate click a functional requirement

Create a generic affiliate-link registry with campaign parameters, disclosure text, placement rules, click analytics consent, and the ability to add providers later without editing workflow logic.
</primary_experiences>

<google_flow_and_browser_automation>
Treat Google Flow as a first-class **browser execution provider**, distinct from an API provider.

Design:

- a companion Chrome extension or browser-control adapter
- explicit connection and health state
- authenticated profile selection without extracting passwords/cookies
- one-scene-at-a-time safe queue as the initial production mode
- stable scene ID passed through prompt, download, verification, and filename
- file-system verification that a newly downloaded artifact exists
- visual verification before accepting/renaming the artifact
- recovery from stale DOM state, tab switching, duplicate results, missing download buttons, and authentication expiry
- user-visible notice that the controlled Chrome tab/profile must remain idle
- resumable queue and idempotent scene jobs

Do not claim Google Flow provides an API when the implementation is browser-driven.
</google_flow_and_browser_automation>

<provider_architecture>
Create one canonical provider/plugin contract for desktop, CLI, and MCP.

At minimum, model:

- provider identity, version, execution type (`local`, `api`, `browser`, `remote_server`)
- authentication method and secure credential reference
- declared media operations
- model catalog and live capability discovery
- input schema and output schema
- aspect ratios, resolutions, durations, reference limits, and optional controls
- estimated cost, currency, and pricing timestamp
- expected latency
- job submission, status, cancellation, retry, and artifact retrieval
- health check
- rate-limit and quota errors
- provenance metadata
- terms/region/availability notes

Use adapters so provider quirks do not leak into Story Studio or agent tools.

Bring-your-own-key must be a core product principle. Subscription revenue should pay for orchestration, convenience, templates, updates, support, and optional hosted services—not secretly resell user-paid API calls unless clearly disclosed.
</provider_architecture>

<agent_cli_mcp_design>
Design a human-friendly `vidmyo` CLI and a versioned MCP tool surface over the same service layer.

Proposed CLI families to evaluate:

```text
vidmyo doctor
vidmyo providers list
vidmyo providers configure <provider>
vidmyo agents list
vidmyo agents connect <agent>
vidmyo workflows list
vidmyo image create ...
vidmyo video create ...
vidmyo story create ...
vidmyo jobs list
vidmyo jobs get <id>
vidmyo jobs cancel <id>
vidmyo artifacts open <id>
vidmyo mcp install <agent>
vidmyo app open --project <path>
```

The MCP server should include:

- capability discovery
- provider/model discovery
- project creation/opening
- image/video/story job submission
- story-plan inspection and per-scene approval/regeneration
- job status/cancellation
- artifact listing/opening
- cost estimate and usage summary
- safe settings reads

Keep long media work asynchronous. Every job must have a durable ID, state, timestamps, logs, cost/provenance data, and resumable checkpoints.

Version MCP tool schemas. Avoid breaking agent workflows when providers change.

For “open a specific agent session from the desktop app,” evaluate and recommend among:

1. launch the installed CLI in a visible Terminal at the Vidmyo project directory with a generated context/prompt file
2. launch a supported agent’s deep link or official session API if one exists
3. embed a pseudoterminal inside Vidmyo

Default recommendation should favor option 1 for the first sellable release because it is transparent, compatible, and lower risk. Generate a project-scoped session brief containing the user’s UI selections and tell the agent where it is. Do not inject fragile keystrokes or steal credentials. Treat an embedded terminal as a later feature only if security, accessibility, and process lifecycle are handled well.
</agent_cli_mcp_design>

<installer_and_doctor>
The installer must not silently install arbitrary tools or modify the user’s machine without consent.

Design an idempotent first-run setup and `vidmyo doctor` system that:

- detects operating system, architecture, available RAM, disk space, GPU/Metal/CUDA/ROCm support, Node, Python/uv, browser extension, supported agent CLIs, local engines, companion repositories, ports, and credentials
- classifies dependencies as required, recommended, optional, incompatible, or already installed
- explains size, source, license, privileges, and purpose before installation
- lets the user install all recommended items or choose individually
- pins versions/checksums and verifies downloads
- installs app-owned binaries and models inside an app data directory when possible
- uses official package managers/installers where appropriate
- never overwrites an existing repository with local changes
- supports repair, update, uninstall, and offline diagnostics
- logs actions without secrets
- recovers from partial installs
- detects the currently broken/unavailable git submodule pin and replaces fragile source-time assumptions with distributable packages, vendored releases, or verified optional clones

Separate:

- what is bundled with Vidmyo
- what Vidmyo can install with consent
- what the user must install/authenticate manually
- what remains a remote service
</installer_and_doctor>

<video_delta_quality_track>
Treat Video Delta quality as a separate research and engineering stream that integrates with Vidmyo but does not block shipping Story Studio.

The problem is not merely visual fidelity. Current outputs may be attractive but semantically incoherent: scenes can contradict prompts, fail to connect, change subjects, or lack causal progression.

Create an evaluation-first improvement plan covering:

- prompt decomposition into shots and atomic actions
- script-to-shot semantic alignment
- global story state and per-shot state
- identity/wardrobe/environment/style consistency
- reference-frame propagation
- first/last-frame continuity
- camera and motion constraints
- duration appropriate to model capability
- scene transition logic
- multimodal review of generated frames/clips against the shot specification
- automatic rejection/regeneration thresholds
- temporal and optical-flow checks where helpful
- human approval checkpoints

Define a small benchmark suite and measurable scores such as:

- prompt/shot alignment
- subject identity consistency
- scene-to-scene continuity
- action completion
- temporal stability
- visual quality
- render time
- peak memory
- failure/retry rate

Benchmark on the 16 GB Mac mini M2 Pro. Prefer short coherent shots assembled into a film over asking a local model for long complex action it cannot reliably deliver.

Clearly distinguish:

- Video Delta’s depth-aware compositing/insertion strength
- local generative motion
- storyboard/timeline orchestration
- cloud model fallback
</video_delta_quality_track>

<commercialization>
Create an achievable business plan that can begin selling the proven Story Studio workflow quickly rather than waiting for every provider and Video Delta research milestone.

Research current competitor pricing and current API economics at execution time. Do not rely on stale memory. Compare at least:

- creator-focused AI video subscriptions
- workflow/automation tools
- local/open-source alternatives
- API-first providers
- faceless YouTube creation tools

Recommend “no-brainer” pricing with transparent boundaries. Evaluate a structure similar to:

- free/local or trial tier
- individual Creator tier
- higher-volume Pro tier
- optional commercial/team tier later
- bring-your-own-key usage
- optional hosted credits as a separate, clearly priced add-on

Do not finalize numbers solely from intuition. Show:

- target persona
- included workflows/features
- limits that are inexpensive to enforce and easy to understand
- expected support burden
- gross-margin logic
- payment processing assumptions
- affiliate revenue as upside, not the core unit economics
- annual-plan discount
- early-adopter/founding offer
- refund/trial policy
- what remains available in the open-source edition, if applicable

Resolve the current positioning conflict: the README promises “free/open-source/no subscription fees,” while the desired product is a paid monthly service. Propose a credible open-core, paid-desktop, hosted-service, or dual-license strategy without misleading existing users or violating upstream licenses.

Include:

- licensing and dependency audit
- privacy policy/data flow
- terms and affiliate disclosures
- code signing/notarization costs
- support/update expectations
- telemetry consent
- launch channels and first 30/60/90-day plan
- a landing-page value proposition
- activation and retention metrics

The launch wedge should be: “Create a complete faceless YouTube doodle video with your choice of local tools or your own provider keys, from one desktop workflow or one agent request.”
</commercialization>

<security_privacy_and_trust>
Require:

- OS keychain/credential vault storage in desktop builds
- strict Electron context isolation and narrow preload APIs
- no renderer access to raw filesystem/process primitives
- explicit consent for shell commands and tool installation
- provider keys never logged or sent to unrelated services
- local-first project/artifact storage with user-selectable locations
- redacted diagnostics
- domain allowlists and permission scopes for browser automation
- signed provider/plugin manifests
- checksum/signature verification
- affiliate disclosures
- cost confirmation thresholds before expensive jobs
- safe defaults for publishing (`private` or dry-run)
- cancellation and cleanup behavior
- data retention controls
</security_privacy_and_trust>

<execution_strategy>
This request spans multiple independent systems. Decompose it into milestones with explicit dependencies and a sellable vertical slice.

Use this default priority unless repository evidence strongly supports a better order:

1. **Audit and stabilize the current repository**
   - sources of truth
   - build health
   - broken submodule/dependency bootstrap
   - security gaps
   - desktop/Next.js duplication
2. **Define the shared capability/provider/job/project contracts**
3. **Ship Story Studio MVP using the existing faceless doodle workflow**
4. **Expose the MVP through CLI and versioned MCP**
5. **Improve agent session launching from the desktop UI**
6. **Add secure setup/doctor and guided dependency installation**
7. **Add Google Flow browser-provider integration**
8. **Add ElevenLabs plus affiliate registry**
9. **Add/verify fal.ai, Higgsfield, Google API, and other provider adapters**
10. **Commercial packaging, billing, signing, updates, onboarding, and launch**
11. **Run the Video Delta semantic-coherence research track in parallel, gated by benchmarks**

Keep the first paid release narrow enough to ship. Do not block it on every future animation style or provider.
</execution_strategy>

<required_first_run_deliverables>
For the first run, do not begin broad implementation. Produce an evidence-based product/architecture package:

1. **Executive recommendation**
   - what Vidmyo should be
   - the fastest sellable wedge
   - what not to build yet
2. **Verified current-state audit**
   - table of existing capabilities with evidence paths
   - duplicates, stubs, broken paths, security issues, and dependency risks
3. **Gap analysis**
   - requested capability vs current state vs recommended action
4. **Target architecture**
   - shared core, desktop UI, CLI, MCP, provider adapters, browser adapter, job runner, project/artifact store, credential store, billing/licensing boundary
   - include a Mermaid component diagram and at least one end-to-end sequence diagram
5. **Information architecture and core user journeys**
   - Image, Video, Story
   - advanced/specialist surfaces
   - desktop-to-agent handoff
6. **Story Studio specification**
   - faceless doodle MVP
   - provider selection
   - voiceover
   - scene IDs and resumability
   - continuity review
   - future style plug-in path
7. **CLI and MCP specification**
   - commands/tools
   - schemas
   - versioning
   - example agent requests
8. **Installer/doctor specification**
9. **Video Delta quality benchmark and research plan**
10. **Commercialization plan**
    - researched market context
    - recommended pricing
    - open-source/paid boundary
    - 30/60/90-day launch plan
11. **Prioritized roadmap**
    - milestones, dependencies, acceptance criteria, risk, and rough effort ranges
12. **Decision log**
    - decisions made
    - assumptions
    - questions that truly require Luke
13. **Implementation plan for Milestone 1 only**
    - exact files/modules likely to change
    - tests and verification
    - migration and rollback

Save the package under `docs/product/` with a dated filename and leave `.tmp/todos.md` and `.tmp/insights.md` current.
</required_first_run_deliverables>

<quality_bar>
- Ground every repository claim in a file, command result, graph query, or test from this run.
- Clearly separate `verified current state`, `inference`, and `proposal`.
- Prefer one canonical implementation over parallel duplicated stacks.
- Preserve working behavior unless a documented migration replaces it.
- Validate only at system boundaries; do not add speculative abstractions or defensive layers without a real failure mode.
- Every milestone needs acceptance criteria and a verification method.
- For provider claims, distinguish catalog metadata from working end-to-end requests.
- For recommendations that depend on current external facts—APIs, model availability, pricing, licenses, affiliate programs, and agent CLI integration—research official sources at execution time and cite them.
- Do not claim a job succeeded because it was submitted. Verify the final artifact.
- Do not expose internal reasoning. Provide decisions, evidence, trade-offs, and concise rationale.
</quality_bar>

<operating_behavior>
When you have enough information to act, act. Do not re-derive facts already established, re-litigate decisions Luke already made, or narrate options you will not pursue. If weighing a choice, make a recommendation.

Pause only when the work genuinely requires:

- destructive or irreversible action
- paid API usage or significant spend not already authorized
- a real scope change
- credentials, legal choices, affiliate URLs, or product decisions only Luke can provide

For safe, reversible, read-only work, continue autonomously.

Before reporting progress, audit every claim against tool output from this session. If tests fail, say so. If work was skipped, say so. If a capability is only a stub, call it a stub.

Do not add unrelated features, refactor broadly, or design for hypothetical requirements. Keep the architecture extensible through narrow stable contracts, not unfinished abstractions.

If independent research tasks can run in parallel, delegate them and continue useful work while they run. Keep one orchestrator responsible for integration and consistency.

Use the Omi vault and `.tmp/insights.md` as memory. Save corrections and confirmed approaches, but do not duplicate facts already evident in the repository.

For a long run, provide brief, evidence-backed progress updates at meaningful checkpoints. The final response must stand alone: lead with the outcome, then identify the most important decisions, risks, and the one or two inputs needed from Luke.
</operating_behavior>

<self_verification>
At the end of each milestone:

1. compare the result to the acceptance criteria
2. run the relevant build, tests, lint/type checks, MCP smoke tests, and targeted integration checks
3. use a fresh-context review pass to find contradictions, placeholders, unverified claims, and accidental scope expansion
4. verify no secrets were introduced
5. update Graphify after code changes
6. update the daily log and `agent-shared/Vidmyo.md`

Do not mark a milestone complete until the evidence supports it.
</self_verification>

<start_now>
Begin with the repository and memory audit. Then produce the complete first-run product/architecture package described above.

Do not start broad implementation in this first run. You may make only small documentation or diagnostic-file changes required to complete the audit and plan. End by recommending the exact Milestone 1 vertical slice that can be implemented and sold fastest.
</start_now>

