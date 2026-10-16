import { GenerationAuthorizationStore, generationRequestFingerprint } from '../../packages/core/src/generationAuthorization.js';

// Approval is a trusted host callback, never a field an agent can self-approve.
export function createGenerationConsent(confirm, store = new GenerationAuthorizationStore()) {
  let reviewing = false;
  return async request => {
    if (typeof confirm !== 'function') throw new Error('Paid generation requires human confirmation in the Vidmyo desktop app. Open Vidmyo and connect its hosted MCP; no provider request was submitted.');
    const snapshot = structuredClone(request);
    const before = generationRequestFingerprint(snapshot);
    if (reviewing) throw new Error('Another paid generation is awaiting human review. Wait for that decision; no provider request was submitted.');
    reviewing = true;
    let response;
    try { response = await confirm(snapshot); }
    finally { reviewing = false; }
    if (response !== true) throw new Error('Paid generation was not approved. No provider request was submitted.');
    if (generationRequestFingerprint(snapshot) !== before || generationRequestFingerprint(request) !== before) throw new Error('Generation changed during human review. Review the request again.');
    const approval = store.issue(snapshot);
    store.consume(approval.authorizationId, request);
  };
}
