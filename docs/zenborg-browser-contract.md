# Zenborg Browser contract

Source: maintainer Opus message msg_a5edc43137761c6d34467bb370add3dcd729 in session ses_89ff8db46e2b715ac5c7f0025a4d5bf50a1e, read2026-11-06. Implementation targets upcoming1.0.11; installed1.0.10 remains unsupported for browser dispatch.

Each project phase (script, code) owns one durable browser job. Discover enabled browser-agent profiles, send zenborg_ask with one recipient/mode manual/wait false once, save runId before polling. Default poll cadence5s, bounded30min local wait; Resume continues the same run. A transport timeout during submission leaves an uncertain submitting receipt: no automatic resubmission.

Accept singular runId as well as existing single-element runIds responses. Read succeeded result text directly from run.result (string or text/output wrapper); legacy completed runs may use session messages. Validate strict JSON and phase output before narration or rendering.

NEEDS_USER_ACTION persists the existing receipt, displays Sign in to ChatGPT in Zenborg (Browser Workers), then local Resume polls the saved run. Failed/cancelled/invalid outputs do not clear run IDs or cause a second ask. Changed briefs require a new project. A definitive HARNESS_DISABLED rejection has no remote run; after upgrading Zenborg, an explicit Resume browser task action permits a first actual dispatch.

Open maintainer clarification: exact result/error wire shape and whether NEEDS_USER_ACTION resumes automatically after login or needs a supported same-run resume action. Questions posted in the same session as msg_11e294f653ce8d6187819ed85d4d11455ff6. Current code never invents a resume endpoint or starts a replacement run. Streaming and attachments are unnecessary; output must support up to2MiB HTML.

Verification artifacts are generated under .tmp and output/playwright. This PR does not claim live1.0.11 end-to-end validation or global release readiness.
