# Zenborg Browser contract

Source: maintainer Opus messages in session ses_89ff8db46e2b715ac5c7f0025a4d5bf50a1e, latest read2026-11-06. Installed version confirmed1.0.11.

Each project phase (script, code) owns one durable browser job. Discover enabled browser-agent profiles, send zenborg_ask with one recipient/mode manual/wait false once. Save runId before polling. If the receipt initially has null runId, atomically save sessionId plus submission message/turn identity in resolving state, then read that session until a matching response/system message exposes its runId. Never adopt an unrelated run from the session or re-ask while resolving. Default poll cadence5s, bounded30min local wait; Resume continues the same run. A transport timeout during submission leaves uncertain submitting state: inspect manually, never automatically resubmit.

Each fresh production phase uses its own MCP-routed session, clearing inherited ZENBORG_SESSION/MAIOX_SESSION from the connector process environment. This prevents diagnostic history overflowing the ChatGPT composer or crossing jobs. Explicit session IDs on saved receipts remain valid for recovery. Calls through different connector instances in one process serialize; Zenborg enforces browser maxConcurrent1 across callers.

Actual1.0.11 response: zenborg_run_status returns run.state completed and top-level answer {messageId,body,createdAt}. Parse answer.body first and accept the first fenced block regardless of language tag. Also accept announced succeeded/result variants and legacy completed session-message recovery. Validate strict JSON and script/html fields before narration or rendering.

Recovery clarification from maintainer message msg_c696b3c0882b3bbb7a4e12173fa6c7d4b3ed (2026-11-06):
- BROWSER_NOT_SENT: explicit Resume browser task may archive the terminal run and start a NEW ask.
- Legacy1.0.11 BROWSER_FAILED: only the exact confirmed diagnostic saying ChatGPT never showed the message within the deadline and the prompt was not submitted (attachment upload or send failed) is treated as confirmed not-sent. Ambiguous phrases are not sufficient.
- NEEDS_USER_ACTION: the user completes sign-in/verification in Browser Workers, then explicitly chooses Resume browser task to create a new attempt. Do not revive the old failed run.
- BROWSER_UNRESOLVED: never automatically retry; ask the user before creating a new job. Other failures/invalid results keep their run IDs and do not trigger another ask.

retryFailed reads authoritative terminal status and archives the old receipt plus recovery evidence before preparing a new attempt. Generic Resume still polls the existing run; the explicit browser-recovery control invokes this safe reset and resumes production. Changed briefs still require a new project. Definitive HARNESS_DISABLED rejection has no run and may be retried explicitly after upgrading.

Each browser message is limited to20,000 characters before submission intent is written. Code tasks use a compact rendering contract/style summary and only relevant timing fields; the complete source style guide remains packaged locally. The tested style171 code message is1,717 characters. Session isolation remains in place. Zenborg's next patch will wait for Send readiness, add typed BROWSER_NOT_SENT and trim old history; installed1.0.11 can still fail a send until that patch.


Real test evidence is recorded in docs/animations-live-test-2026-11-06.md. Full release readiness is a separate gate; this contract does not imply an installer was shipped.
