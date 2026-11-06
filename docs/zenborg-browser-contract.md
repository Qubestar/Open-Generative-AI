# Zenborg Browser contract

Source: maintainer Opus messages in session ses_89ff8db46e2b715ac5c7f0025a4d5bf50a1e, latest read2026-11-06. Installed version confirmed1.0.11.

Each project phase (script, code) owns one durable browser job. Discover enabled browser-agent profiles, send zenborg_ask with one recipient/mode manual/wait false once. Save runId before polling. If the receipt initially has null runId, atomically save sessionId plus submission message/turn identity in resolving state, then read that session until a matching response/system message exposes its runId. Never adopt an unrelated run from the session or re-ask while resolving. Default poll cadence5s, bounded30min local wait; Resume continues the same run. A transport timeout during submission leaves uncertain submitting state: inspect manually, never automatically resubmit.

Each fresh production phase uses its own MCP-routed session, clearing inherited ZENBORG_SESSION/MAIOX_SESSION from the connector process environment. This prevents diagnostic history overflowing the ChatGPT composer or crossing jobs. Explicit session IDs on saved receipts remain valid for recovery. Calls through different connector instances in one process serialize; Zenborg enforces browser maxConcurrent1 across callers.

Actual1.0.11 response: zenborg_run_status returns run.state completed and top-level answer {messageId,body,createdAt}. Parse answer.body first and accept the first fenced block regardless of language tag. Also accept announced succeeded/result variants and legacy completed session-message recovery. Validate strict JSON and script/html fields before narration or rendering.

NEEDS_USER_ACTION persists the receipt and displays Sign in to ChatGPT in Zenborg (Browser Workers); Resume polls the same run. Failed/cancelled/invalid results do not erase run IDs. BROWSER_QUOTA, MODEL_UNAVAILABLE, BROWSER_UNAVAILABLE, TIMEOUT, CANCELLED and BROWSER_UNRESOLVED have actionable guidance; unresolved sending requires user review before a new job. PROMPT_TOO_LARGE asks for a new shorter job. Changed briefs require a new project. A definitive HARNESS_DISABLED rejection has no remote run; explicit Resume browser task after upgrading allows the first actual dispatch.

Still to clarify with maintainer: whether terminal NEEDS_USER_ACTION reactivates automatically after browser sign-in or needs a supported same-run resume action. Current code never invents an endpoint or starts a replacement run. Streaming/attachments are unnecessary. Code size2MiB is Vidmyo’s local validation ceiling; actual browser/Zenborg prompt and output limits still apply.

Real test evidence is recorded in docs/animations-live-test-2026-11-06.md. Full release readiness is a separate gate; this contract does not imply an installer was shipped.
