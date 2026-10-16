# Story and Animations integration follow-up

## Outcomes and sequence

1. Voicebox becomes a selectable local narration provider, with explicit existing voice/profile selection, availability feedback, cancellation, and cache invalidation when voice changes.
2. New installations can configure Google access and sign in without installing gws. Desktop OAuth client JSON can be imported through a native picker; a release-owned client can be provisioned separately. Native PKCE/state/loopback login opens the system browser. Tokens remain encrypted in main-process storage and never enter project files or agent context. Sheets/Drive access remains read-only. Existing gws and Viewer-link access remain compatible.
3. Animations shares Story's idea/Google Sheet selector. Style remains the first choice; sheet, tab and row are explicit, validated and preserved on reopen.
4. Remove private pipeline commands and machine-specific paths from user-agent handoffs. Audit public MCP summaries/errors and director payloads. Use narrow data contracts and deterministic validation, without treating a model refusal as access control.

## Delegation and file ownership

- GPT-5.6 Sol: Google host modules, Google-only IPC/preload methods, OAuth tests and Google connection guide.
- GPT-5.6 Sol: Voicebox adapter, creative host integration, core voice contract, creative-only preload methods and backend tests.
- GPT-5.6 Luna: shared creative UI/model, source validation, Google setup controls, Voicebox profile selection and UI tests.
- Next available GPT-5.6 worker: agent handoff/MCP security and focused regression tests. Creative bridge changes must coordinate with Voicebox owner.
- Root: integration review, acceptance verification, documentation and memory updates.

All workers preserve the existing dirty checkout. No real OAuth consent, voice cloning, paid generation, publishing, commits or pushes are needed for implementation verification.

## Security boundary

User topic, sheet text and local-agent output are untrusted data. Agents receive task inputs and public capability descriptions, never account tokens or private orchestration recipes. Sensitive errors must not echo credentials or private executable paths. Allowlisted output structure is enforced outside the model.

A desktop package cannot keep its shipped implementation secret from the computer owner. Fully proprietary orchestration must execute on a service controlled by Vidmyo, with authenticated capability APIs and server-side authorization. This follow-up must document that remaining boundary; it must not claim that prompt filters, encryption with client-held keys or obfuscation prevent local reverse engineering. No user content is silently moved to a new cloud service.

## Acceptance

- Google mock tests: clean install, client import validation, PKCE/state, timeout/cleanup, refresh, disconnect, no credential leakage, read-only list/tab/row calls, legacy fallback.
- Voicebox mock tests: discovered profiles, validated local endpoint, generation/audio handling, cancellation, unavailable service, selected voice caching and reopening.
- UI checks: both sections can choose Sheets; setup/connect errors visible; Voicebox selection persists and required profile validation is clear.
- Security tests: handoff excludes private recipes, provider payload excludes unrelated/private fields, malicious content cannot introduce executable capabilities.
- Existing core tests, relevant Python tests, Studio/Next builds, diff checks and Graphify update.

## External release requirement

The app owner must register/provision an actual Google Desktop OAuth client and satisfy Google's consent-screen requirements for a configuration-free public login. An import flow is a working clean-install alternative; it is not evidence that Vidmyo's public OAuth app has been registered or verified.
