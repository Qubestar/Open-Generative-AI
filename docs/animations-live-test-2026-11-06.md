# Animations — live test, 2026-11-06

## Added style
#171 Ink World Stories (3D + 2D), adapted from the user-supplied animated-story-video.skill.zip and accompanying PDF in Drive folder11AuNQZIFQaw7pM0qjlv0-KUFQV0AgXQy. The guide preserves procedural3D scenery, flat ink characters, moving perspective camera, voice timing and visual-review rules. Vidmyo supplies the automated local render instead of the source Windows handover flow. Available in existing Animations, with a new collection filter, actual local poster/video and automatic Not needed image provider; director remains required.

## Actual installed Zenborg test
Installed version confirmed1.0.11 through Info.plist. Maintainer conversation read via installed public zenborg_session_read, not the stale-auth built-in connection.

Attempt1: ChatGPT script run_6d78ae5deb26fc8f7798bed450d1561dfec6 completed; local Kokoro narration and measured timing succeeded. Code run_b6f2c0f1ca3ef5c4a3ad1c146d256fdc0398 failed PROMPT_TOO_LARGE31510>31000 because inherited diagnostic-session history was included. Fixed Vidmyo by clearing inherited session IDs for fresh production connections. Existing receipts still retain explicit session IDs for recovery. No old job was resubmitted.

Attempt2: fresh project with isolated production sessions. ChatGPT script run_8bf0a0eb5b329e023b7f8dc4e02b32fceb57 completed; local narration5.48s and beat timing succeeded. Code run_5aa6fd42fb8f45435e0b7ed4f7b2010ea240 in session ses_7724fab491c688f1f1ce360d5e4d0290f9e9 failed BROWSER_FAILED. Exact detail: ChatGPT never showed the sent message in the conversation within3min — prompt was not submitted (attachment upload or send failed). No answer/code was returned. No automatic repeat was sent.

Full ChatGPT→code→MP4 is therefore NOT passing. The owner action is Zenborg Browser Workers send/attachment investigation, with a documented safe recovery path. Posted to maintainer conversation as msg_2b922e335e5565c1a08a1b54d399f25bd5dd. Public browser_text read for this profile returned computer disabled; did not enable it, change permissions/settings/data/source, restart Zenborg or interact with Luke’s desktop.

## Connector improvements verified
Actual1.0.11 answer.body supported, first fenced block accepted regardless of tag. Null initial runId saved in resolving state with message/turn identity; session lookup only adopts a run correlated to that exact submission. Existing/submitting/resolving receipts never silently re-ask. Default5s polling, module-wide queue, cancellation of queued jobs tested, typed failure guidance retained.

## Separate original preview
To complete the gallery independently of the external blocker, authored an original procedural3D-mesh/2D-character example in packages/core/assets/animation-demos/ink-world-story.html. Used the real generated narration from attempt2. This is explicitly NOT code produced by ChatGPT and NOT an end-to-end success. Rendered offline through the actual code renderer:720x1280,30fps,165frames,5.48s, audio=true,1,782,595bytes, exit0. Reviewed first/middle/final frames and corrected foreground occlusion and framing. Simplified scenery, lighting and depth rendering illustrate the technique; they do not reproduce all Three.js/Remotion source features. Gallery preview encoded360x640 with audio; poster extracted from the actual render.

## Local checks
Full isolated core731/731 and real-home isolation PASS; focused51/51; MCP52/52; production build exit0. UI13 checks pass including selection171, Not needed and real local video playback. Independent connector review found no blocker and requested queue/cancellation regression, which was added and passes. Graphify refreshed.

Artifacts: .tmp/ink-world-e2e and .tmp/ink-world-e2e-v2 preserve failed live attempts/receipts/logs; .tmp/ink-world-local-demo contains the separate verified render; .tmp/ink-world-final-checks.json plus output/playwright/animation-qa/verification.json record automated checks. Initial UI attempt got connection-refused because the previous isolated preview server was stopped; restarted only an owned Vidmyo preview server on loopback4325 and reran successfully. Final UI evidence is the13-check result.

No installer deployed, PR remains draft, and the previously documented global release gate is not declared green.
