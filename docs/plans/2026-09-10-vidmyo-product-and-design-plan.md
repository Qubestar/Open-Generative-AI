# Vidmyo: Cleaner decision quality and unified studio redesign

Status: second implementation pass delivered in the live checkout, 2026-09-11. Cleaner reliability/review, both approved appearances, shared navigation, durable creative settings, Image→Video handoff, one-request UI approval, and canonical Image/Video catalogs are implemented. This remains a phased roadmap—not a claim that every item below has shipped. See `.tmp/vidmyo-redesign/implementation-report.md` for verification and remaining scope.

## Confirmed constraints and scope

- The user confirms the new automatic acoustic timing works. Preserve it; do not revert to Whisper-only edit boundaries or require manual timestamp adjustment in normal use.
- Improve editorial choices separately from alignment. A precisely timed bad removal is still a bad edit.
- Show visual layout options before implementing the redesign. Images are illustrative concepts, not proof of working features or finalized measurements.
- Keep Story, Cleaner, Clipper, Image, Video and Agents. Do not restore Workflows or Explore Apps.
- Preserve local/subscription-agent workflows and optional API workflows. Do not imply Codex/Claude subscriptions include paid third-party image/video generation.
- Preserve project data, reversible cuts, existing exports, user overrides, provider permissions and secure key storage. No commits, pushes or paid provider experiments in this planning phase.
- Three bounded audits/research assignments use GPT-5.6 Sol. Root handles synthesis, cross-module decisions and acceptance review.

## Delivery order

1. **Cleaner editorial reliability:** freeze a benchmark of expected Keep/Remove decisions; compare previous and current behavior; fix observed causes; retain timing regressions.
2. **Visual direction approval:** select a concept and agree on navigation, density and theme. Do not implement two unrelated design systems.
3. **Shared foundations + Cleaner review:** reusable visual tokens, project header, provider control, compact transcript and persistent preview. Integrate and test together.
4. **Image and Video:** apply the same shell and prioritize controllability, history, transparent cost and recoverable jobs before adding many model-specific switches.
5. **Story, Clipper and Agents:** migrate shared components without changing working pipelines; validate navigation and project isolation.
6. **Release gate:** realistic user tasks, accessibility checks, regression suites, packaging, local/API capability checks and permission review.

## Cleaner review interaction specification

### Layout

- Left: compact transcript/edit list; right: persistent video preview. Initial split approximately 44/56, resizable with a minimum readable transcript width.
- Right below video: transport, Original/Cleaned toggle, compact edit timeline, short output summary, collapsed **Edit brief & rules**. No permanent full rules checklist.
- Project header: project name, saved/saving state, provider, Undo/Redo, export action. Distinguish **Prepare preview** from final export.
- At smaller widths, stack preview above transcript; retain usable controls, avoid horizontal clipping. Keyboard focus must not disappear when panels change.
- Setup and review are different screens/states: the full intake questionnaire must not consume editing space after analysis.

### Compact rows

- Default row: spoken text (usually one or two lines), discreet time range, explicit Keep/Removed state and one primary toggle. Non-speech rows read **Pause**, **Cough candidate**, or **Audio to check** as warranted by evidence.
- Aim for 8–12 readable ordinary rows in a 900px-high desktop workspace, rather than large cards with repeated instructions. This is a design target to validate, not a promise that all text fits in two lines.
- Expand a selected row for **Why this cut?**, comparison take, uncertainty details and advanced timing. Do not hide removal/restore actions behind hover alone.
- Use subdued strikethrough for removed speech, but keep sufficient contrast. Color is supplemented by an icon and text. Cough labels must not imply a reliable acoustic classifier where none exists.
- Filters: **All**, **Removed**, **Needs review**; search the transcript. Show counts with unambiguous meanings.
- Related takes become an optional grouped comparison: earlier attempt, chosen complete take, concise reason. Never assume the last take is always best.
- Every interval remains restorable, including pauses and untranscribed audio. No hidden padding or deleted gap outside the review model.

### Playback synchronization

- Highlight the row containing the actual playback source position, not merely the last clicked row.
- In Cleaned playback, convert edited time through the exact kept-range map before locating the active transcript row. Original playback uses source time directly.
- Distinguish playing row from keyboard/selection focus. Optional word highlighting uses verified word timings only.
- **Follow playback** defaults on, but manual scrolling pauses automatic scrolling; offer **Back to playhead**. Do not fight the user's attempt to review another section.
- Seeking, playback rate, source/cleaned switching and rerendering must all keep the highlight correct. Removed rows cannot become the playing row in the cleaned preview.
- After a decision change, clearly mark the existing edited media stale; rebuild or visibly prepare it. Never silently play the uncut original in place of the cleaned edit.

### Brief and decisions

- Collapsed summary: provider, cleanup preset, output framing/format. Expand to inspect/change rules; warn about the precise scope of reanalysis.
- Reanalysis must preserve confirmed user overrides where safely mapped, version the plan and show changed proposals. Ambiguous remapping is surfaced, not guessed.
- Reasons should explain useful editorial evidence, not generic confidence language: e.g. **Incomplete attempt; next take finishes the same instruction**.
- No uncalibrated AI confidence percentages in the normal UI. Separate **editorial suggestion**, **timing verified**, and **user confirmed**.

## Shared visual system

Two generated directions are being reviewed:

- **A — Studio:** dark blue-slate workspace, compact persistent module navigation, restrained periwinkle accent. Media-first, suitable for extended video work. Concept: `output/design/2026-09-10/concept-a-studio.png`.
- **B — Editorial:** cool light canvas, top module navigation, stronger document-like transcript. Reading-first alternative. Concept: `output/design/2026-09-10/concept-b-editorial.png`.

Both images were generated using the built-in image tool, not API CLI fallback. They are visual exploration assets. The people, transcript examples, times, statuses and waveform bars are illustrative, not recordings or measured results. The implementation must obey the interaction specification even where a generated image simplifies it (e.g. keep/restore labels, timeline mode, disabled export states).

Recommendation: A's dark Studio shell with B's document-like transcript density. Theme and navigation are separable choices; do not maintain two independently coded workspaces. Keep removal/restore controls explicit but stop repeating large status labels and reasons on every row.

The illustrative **Ask your agent** control in B is not a commitment to add a chat system in this slice. Only surface it if a working, permissioned agent interaction exists; otherwise link to the existing Agents module. No decorative dead controls.

Proposed baseline tokens (A, subject to choice): canvas `#111822`, surface `#1B2633`, primary text `#E8EDF3`, accent `#8D9CFF`, separate muted positive/warning/destructive colors verified for contrast. Use a small spacing scale, 6–10px control radii, consistent icon weights and visible keyboard focus. Prefer existing licensed fonts or verified open fonts over extra font dependencies.

No decorative dashboard widgets, huge hero headings, unrelated background illustrations, excessive glass/blur or animations that compete with video. The signature interaction is one synchronized playhead across transcript and preview.

## Engineering acceptance gates

- All existing acoustic alignment, complete-word boundary, exact kept-range, reversible-cut and preview-cache tests remain green.
- Benchmarks include abandoned two-word restart, full retake, unique lead-in before repeated suffix, legitimate emphasis/repetition, negation, first-better-than-last take, cough next to speech, no-change recording, long silence and unsupported/low-confidence transcript.
- No deletion of unique useful speech in the agreed release fixture set. Measure unwanted-speech retention separately; do not improve one score by keeping or cutting everything.
- Compare old/new plans with the same transcript and cached provider response to isolate deterministic regressions. A separate bounded provider evaluation needs explicit allowance; mocked tests alone cannot establish better model judgment.
- Playback/source-time mapping tests cover seeks, pauses, rate changes, omitted intervals and manual scrolling. Review flows tested at desktop and narrow widths, with keyboard only and readable contrast.
- Project switches and reruns cannot leak stale media or overwrite a newer plan. Include save errors, canceled jobs, interrupted app restart and stale preview responses.
- UI and MCP must invoke the same validated operations. New controls cannot bypass project grants, eligibility checks, provider provenance or spend confirmation.

## Research findings and task assignments

Reports distinguish code-confirmed defects, documented competitor features, anecdotal user feedback and proposed Vidmyo design decisions. Source audits are not live-provider tests. No numerical prevalence or popularity claims are inferred from forum threads.

### Cleaner: observed cause of the reported decision regression

The GPT-5.6 Sol audit compared prior/current test-project artifacts and current source. It did not run an AI provider or modify the project.

**The model still proposes the same four repeated-take removals. The application applies fewer of them.** Current speech segments 1, 2, 5 and 7 have `proposed=cut`; segments 1/2/5 are applied KEEP due to uncertainty gating, and segment 7 is CUT after explicit review. Prior plan had four speech cuts/eight total applied cuts; the inspected current plan has one speech cut and one pause cut. These are point-in-time artifact observations, not product-wide quality statistics.

Observed mechanisms:

1. `cleaner.py:326–337` converts a proposed removal into applied KEEP whenever any warning overlaps the segment. Six whole-region acoustic warnings consequently suppress otherwise-correct duplicate suggestions.
2. `cleaner_transcribe.py:154–163` currently represents an alignment rejection as a warning over the whole speech region. It does not preserve a typed, localized reason identifying the particular word/boundary that failed.
3. `cleaner_align.py:89–93` assigns inter-word gaps to editing boundaries; `cleaner_transcribe.py:171–177` stretches the first word back to the VAD envelope. `quality_warnings():91–99` then evaluates that padded edit interval as if it were the acoustic word duration. In the accepted closing phrase, the first **And** is acoustically 27.766–27.906, but the expanded interval becomes 26.666–28.186 and falsely fails the 1-second rule.
4. `review_plan()` propagates warnings to adjacent joins; the inspected current plan has 20/24 unreviewed uncertain rows. Warning granularity increases review burden beyond the doubtful audio.
5. Reanalysis produces a new plan and resets prior explicit choices, including two audio-event removals and a gap removal in this case.
6. `summary.proposed_cuts` counts applied cuts, not semantic proposals. The UI therefore obscures the distinction already present in the data.

Do **not** roll back acoustic alignment, lower safety thresholds blindly, automatically apply all doubtful cuts, or spend more on the AI provider to solve this deterministic regression.

#### P0 implementation slices

**Q1 — Freeze the comparison.** Add actual-shaped fixtures with four duplicate pairs, separate proposed/applied/review states and existing user overrides. Preserve the 29.146 closing-join regression. No private recording needs to enter the repository.

**Q2a — Separate representations.** Retain acoustic start/end/confidence independently from padded edit envelopes. Quality checks consume acoustic evidence, not the extra audio allocated for safe cuts. Bump `ALIGNMENT_VERSION`; test regeneration once and cache reuse afterward.

**Q2b — Localize failures.** Return structured failure kind and affected words/boundaries from the aligner. Preserve reliable boundaries elsewhere in the phrase where evidence supports them. If an entire phrase is genuinely unalignable, retain that uncertainty; do not invent precise boundaries merely to make warnings disappear.

**Q2c — Preserve the recommendation.** Keep semantic proposal, applied disposition and review status separate in model/API/UI. Show **Suggested removals** separately from **Applied removals**. Uncertain timing must not erase the editorial recommendation; unsafe audio cuts remain blocked until automatically repaired or explicitly resolved. Do not make a doubtful cut appear accepted merely by changing an initialization default.

**Q2d — Preserve user intent.** Reanalysis versions the old plan and reconciles explicit overrides using stable identities plus source/text/category evidence. Ambiguous mapping becomes an explicit conflict; do not silently transfer a choice to different speech or silently discard it. Recompute unreviewed AI defaults.

**Q2e — Evaluate judgment last.** Re-run the benchmark on the corrected decision layer. Only then change take-selection prompts/scoring if mistakes remain. Improve detection of abandoned phrases and complete intended delivery without deleting legitimate emphasis or unique content. The present artifact comparison does not justify blaming the provider prompt.

Each slice must include a failing-before/passing-after regression. Q2a/Q2b share transcription ownership; Q2c/Q2d share plan ownership and should be integrated serially to avoid conflicting migrations.

### Image and Video: source-verified gaps and proposed priorities

The active screens are CloudImageStudio/CloudVideoStudio, not the richer inactive legacy studios. Current active capabilities include fal/Agnes BYOK, basic prompt/model/aspect controls, one-image I2V, local artifacts/recent results and durable jobs. Several displayed endpoints remain explicitly unverified. No paid endpoint was exercised.

| Priority | Observed gap | Proposed user-visible improvement |
|---|---|---|
| P0 | Settings exposes providers that the active generation screens cannot use; UI/core model catalogs drift; local backend setup text points to a missing settings area | One truthful capability registry. Show only available compatible actions; explain setup or unsupported controls. Never silently route to a billable fallback. |
| P0 | Jobs are durable, but active video UI awaits a long operation and does not use available progress events; cancellation/resume are not consistently exposed | Shared job drawer with actual status, elapsed time, cancel, safe resume and clear retry meaning. Resume a stored handle; do not resubmit a paid job after a polling failure. |
| P0 | Paid tools warn in text but lack a consistent preflight/budget/approval contract | Before execution: selected model, input files leaving device, estimated cost or 'unknown', maximum authorized spend and explicit approval. UI and agent/MCP obey the same gate. |
| P1 | Reference/edit/variation workflows exist in competitors but not the active surface beyond one-image video input | Start with one reference, supported variations, side-by-side comparison, reuse settings and Image→Video handoff. First/last frames and extend only where the chosen model supports them. |
| P1 | Recent results are not a useful creative version history; some input media is embedded as base64 in durable job JSON | Project collections, favorites and lineage; source path/hash rather than duplicated raw media; redacted model/request/settings provenance and clear local/remote retention. |

Relevant code: `components/StandaloneShell.js`, `packages/core/src/generation.js`, `packages/core/src/jobs.js`, `packages/core/src/adapters/fal.js`, `electron/lib/mediaBridge.js`, `electron/lib/wan2gpProvider.js`, `electron/preload.js`, `packages/studio/src/components/SettingsModal.jsx`.

Documented competitor features informing the creative slice:

- [Runway image references](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References): reference-led iteration rather than starting from a prompt every time.
- [Adobe unified generation/editing](https://helpx.adobe.com/firefly/web/unified-generation-and-editing-experience/generate-and-edit-content.html): editing/history and first/last-frame workflows.
- [Leonardo image guidance](https://intercom.help/leonardo-ai/en/articles/8497988-image-guidance): reference controls.
- [Krea video workflow](https://www.krea.ai/features/ai-video-generator): extend/merge and parallel generation capabilities.
- [fal pricing API documentation](https://fal.ai/docs/documentation/model-apis/pricing): use retrieved pricing where supported, not stale hardcoded claims.
- [fal payload/retention documentation](https://fal.ai/docs/documentation/model-apis/inference/payloads): storage controls need explicit handling; a no-store request does not mean all uploaded input copies have been deleted.

Directional complaint evidence (not representative statistics): [Runway credits/prompt-adherence thread](https://www.reddit.com/r/runwayml/comments/1oexaj5/so_frustrated_with_runway/), [Leonardo failure/debugging thread](https://www.reddit.com/r/leonardoai/comments/1ejqyqp), and [Adobe community notice about recurring generation errors](https://community.adobe.com/announcements-402/what-s-causing-the-something-went-wrong-error-in-firefly-1560391). These support prioritizing controllability and recoverable jobs over simply listing more models.

Agnes terms/pricing/retention remain insufficiently verified in this audit. Do not market commercial-rights/privacy guarantees for that route without checking its actual terms. Likewise, vendor model capabilities and licenses must be checked per adapter; using a familiar brand name is not a compatibility guarantee.

Defer masked canvas editing, motion brushes, V2V, model training, broad new provider adapters and cross-model batch generation until the foundations are reliable. They may be valuable, but they are separate products/risks, not cosmetic options to add wholesale.

### Editor UX: targeted evidence and implications

The delegated UX researcher hit a usage limit without delivering its report. Root completed a bounded documentation/user-feedback check instead; this is not an exhaustive competitive study or hands-on benchmark. Sources checked 2026-09-10.

| Evidence | What is documented / reported | Vidmyo implication |
|---|---|---|
| [Descript: Edit like a doc](https://help.descript.com/hc/en-us/articles/10164808475149-Inline-notes) | Transcript edits correspond to media; removal is reversible; non-speech notes and correction are separate concepts | Make spoken text the main review surface, preserve restore, and distinguish text correction from media removal. Avoid copying a confusing mode system. |
| [Descript: editor View controls](https://help.descript.com/hc/en-us/articles/10164575118989-Auto-scrolling) | Panels and visual editing aids are configurable; filler/alignment error markings are supported | Collapse secondary controls and make following playback controllable. Keep uncertainty localized and legible. |
| [Gling: text-based cleanup](https://www.gling.ai/save-time) | Vendor documents automatic bad-take, silence and filler cleanup with transcript editing | Automate the first useful pass; review should verify suggestions, not force users to construct every cut. Vendor claims are not evidence of perfect accuracy. |
| [CapCut: transcript editing](https://www.capcut.com/resource/edit-video-with-text) | Documents keyword search, transcript/media editing and showing/hiding removed text | Searchable compact rows, removed filter and synchronized media navigation. Do not equate text edits with synthesized replacement speech. |
| [Descript user workflow feedback, March 2026](https://www.reddit.com/r/Descript/comments/1rpu85m/love_descript_but_here_are_a_few_workflow_things/) | One experienced user praises editing time saved while asking for stronger waveform shortcuts and templates | Keep a compact timeline and keyboard workflow alongside text. Treat the time-saving claim as that user's experience, not a Vidmyo promise. |
| [Descript performance discussion, June 2026](https://www.reddit.com/r/Descript/comments/1txdv5z/tips_for_speeding_up_descript/) | Some users report long delays after actions; others do not experience the issue | Test actual response time and long recordings. Visible save/job states matter; do not claim the competitor is universally slow. |
| [Older Descript workflow review, November 2023](https://www.reddit.com/r/Descript/comments/17z5bkh/an_honest_review_of_descript_and_why_i_cancelled/) | Praises transcript/filler editing but reports over-tight cuts, confusing workflow and timeline position jumps | Preserve complete words, selection and scroll position. This is historical anecdotal feedback, not proof the current product retains those defects. |

Research synthesis: retain text-first editing and automation, but prioritize trust, reversibility, predictable playback, readable density and responsiveness. Do not interpret a small feedback sample as a measured ranking of what all creators want. Riverside-specific claims and comprehensive current competitor screenshots were not verified in this timeboxed pass.

## Model-aware execution plan

| Work package | Execution model | Scope / output | Prerequisite and verification |
|---|---|---|---|
| R1: Cleaner decision audit | GPT-5.6 Sol, high | Read-only trace, actual artifacts, regression hypotheses | Complete; no provider inference or data changes |
| R2: Editor UX research | GPT-5.6 Sol, medium | Documented patterns plus labeled user praise/complaints | Agent hit usage limit; root completed bounded source check, limitations recorded |
| R3: Image/Video gap audit | GPT-5.6 Sol, medium | Existing/missing matrix and bounded feature priorities | Complete; source-verified rather than live-provider-tested |
| Q1: Editorial benchmark fixtures | GPT-5.6 Sol, high | Golden Keep/Remove examples, changed-intent/negation cases, old/new comparison harness | Audit reviewed; distinguish timing, text and editorial metrics |
| Q2: Deterministic decision corrections | GPT-5.6 Sol, high | Minimal engine fixes proven by Q1; explicit proposal vs applied state | Root approves contract; retain alignment and all reversible intervals |
| D1: Theme tokens and shared controls | GPT-5.6 Sol, medium | Scoped token layer, buttons, fields, project/provider header, focus states | User selects visual direction; no provider/business-logic changes |
| D2: Cleaner two-pane review | GPT-5.6 Sol, high | Compact rows, disclosure details, persistent preview, brief placement | D1 complete; one owner for CleanerReview/CleanerStudio/CSS integration |
| D3: Playback highlighting + tests | GPT-5.6 Sol, high | Source/edited timeline map, playing row, follow toggle, seek/rate coverage | Can write isolated pure helpers/tests alongside D2; coordinate before shared-file edits |
| G1: Image/Video job UX | GPT-5.6 Sol, high | Selected small backlog from gap audit, job recovery and reproducibility first | Capability/provider contract approved; no paid generation in tests |
| T1: Accessibility/regression QA | GPT-5.6 Sol, medium | Keyboard, narrow window, provider error, stale media and project-switch tests | Mocked provider paths + local media; no accidental purchase/upload |
| Final architecture and integration | Root/Astra | Scope decisions, conflicting findings, permission/cost boundary, acceptance review | Does not redo every Sol task; inspects evidence and risky seams |

Use bounded tasks with explicit files, expected output and test commands. Never give multiple agents concurrent ownership of the same stylesheet or component. Parallelize research, pure tests and independent modules; integrate one mutating owner at a time. Escalate to the root for unclear contracts or a failed hypothesis, not ordinary JSX/CSS/test work. Model choice reduces cost but does not substitute for verification.

No time/cost saving percentage is claimed. Generation/model costs depend on runtime and account limits; task progress should report concrete results and usage only where measured.

## Common Image/Video workspace specification

- Reuse the chosen module navigation and project header, not another nested navigation system.
- Left inspector: prompt plus references first; model/provider and only compatible aspect/duration/quality controls second. Collapse advanced options and retain their saved values visibly in a summary.
- Main workspace: selected asset at useful size; variations/history in a compact strip or grid. A clear compare mode must not require opening several separate windows.
- Generation action shows local versus cloud execution and cost readiness. An unknown cost is not displayed as free. Subscription-agent availability and generation-provider availability are separate states.
- Persistent jobs drawer survives tab/project changes. Running/queued/completed/failed/canceled states use words and icons; show provider progress only when real. Never animate a made-up percentage to hide a stuck request.
- Image actions: reuse settings, use as reference, create variations and send to Video, restricted to verified supported routes. Unsupported actions explain why instead of failing after submission.
- Video actions: choose start frame, optional supported end frame, duration/aspect, reference/extension where supported; saved source/settings lineage enables repeatable iteration.
- History entries expose selected model, prompt/settings, date and status. Detailed cost/privacy/provenance lives in an expandable inspector, not in every thumbnail.
- Agent panel uses the same job IDs, capabilities and permission decisions. Agents must not access a more permissive execution route than UI users.

## Shipping criteria beyond screenshots

The generated concepts only establish direction. Before calling the redesign complete, demonstrate these tasks in the app:

1. A new user opens an existing Cleaner project, finds one removed take, restores it, previews the resulting edit and exports without typing a timestamp.
2. During cleaned playback, the text highlight follows the audible section; scrolling away does not immediately jump the user back.
3. A clean recording can correctly produce no removals, while a recording with clear retakes does not become 'keep everything' because of unrelated acoustic uncertainty.
4. A user can see which agent decides cuts and whether a generation action needs a different API provider, before spending anything.
5. A generation interrupted by app restart resumes from its existing job rather than charging for a duplicate submission.
6. A user can reuse a generated image as a video reference without downloading/re-uploading it manually, where the selected provider supports that operation and egress is disclosed.
7. All six main modules share coherent controls and navigation; no hidden legacy setup route is required to complete a visible action.

Until these workflows are verified, report the work as a prototype or partial implementation, not 'perfect' or production-ready.
# Launch scope correction — 2026-09-14

User decision: Video Delta local AI video generation is parked and excluded from Vidmyo’s upcoming release. Do not revive it as part of this plan or block release on making it work on target machines. Future reconsideration is undecided. Existing legacy references/tools require release-surface cleanup, not renewed engine development. Ordinary local transcription, cutting, captions, framing and export are distinct and remain in scope. Prioritize release essentials; waveform visualization is not automatically a launch blocker.
