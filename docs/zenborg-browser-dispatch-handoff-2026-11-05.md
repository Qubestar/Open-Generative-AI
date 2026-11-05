# Zenborg browser dispatch handoff

HANDOFF FOR ZENBORG MAINTAINER — Luke requested investigation; do not treat this as authorization to edit Zenborg in the Vidmyo task.

Verified running app: /Applications/Zenborg.app, version1.0.10, port3001, PID714. It uses ~/Library/Application Support/Zenborg, not Maiox/data.

Vidmyo auth fix is implemented: prefer the installed zenborg-node-runner and staged-node MCP entry, with the matching app data directory. Read-only comparison: checkout default→HTTP401 AUTH_REQUIRED; correct installed data→HTTP200. Actual installed MCP zenborg_agents now succeeds.

Remaining browser dispatch: enabled ChatGPT Browser Architect, id agp_c691df2743ea543e1fddec221acfef7c4060, harness browser-agent/model chatgpt. zenborg_ask wait:false is rejected with Harness browser-agent is disabled. The request creates no ChatGPT message/run.

Verified source: lib/collab/policy.js DEFAULT_POLICY.harnesses lacks browser-agent. lib/collab/dispatcher.js adapterFactory has no browser-agent branch and returns null. Browser execution exists separately under loop-worker; loop availability does not prove ask availability.

Opus was consulted in this session and corrected the initial policy-only diagnosis after receiving verified source extracts. Enabling only a policy flag is insufficient and was NOT attempted.

Required owner action: provide a supported single-turn browser dispatch adapter/endpoint using the existing browser executor, wire matching policy/capability metadata, return durable run id/status/result, preserve sign-in/quota controls, and prove one prompt→one response plus cancellation/retry idempotency. Alternatively document a genuinely single-turn supported public route if one exists.

No Zenborg code, policy file, credentials, licence, or server process was modified/restarted. Vidmyo contains the auth fix and precise rejection handling; full ChatGPT→voiceover→MP4 remains blocked by this Zenborg capability gap.
