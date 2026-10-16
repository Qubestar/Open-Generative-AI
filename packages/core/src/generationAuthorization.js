import crypto from 'node:crypto';

const canonicalize = value => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => [key, canonicalize(value[key])]));
  }
  return value;
};

export function generationRequestFingerprint({ kind, provider, model, params = {} } = {}) {
  if (!['image', 'video'].includes(kind)) throw new Error('unsupported media generation kind');
  if (!['fal', 'agnes'].includes(provider)) throw new Error('unsupported media generation provider');
  if (!String(model || '').trim()) throw new Error('model endpoint id is required');
  const body = JSON.stringify(canonicalize({ kind, provider, model, params }));
  return crypto.createHash('sha256').update(body).digest('hex');
}

export class GenerationAuthorizationStore {
  constructor({ ttlMs = 120000, now = () => Date.now(), randomId = () => crypto.randomUUID() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.randomId = randomId;
    this.pending = new Map();
  }

  issue(request) {
    const authorizationId = this.randomId();
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(authorizationId, { fingerprint: generationRequestFingerprint(request), expiresAt });
    return { authorizationId, expiresAt };
  }

  consume(authorizationId, request) {
    const saved = this.pending.get(authorizationId);
    this.pending.delete(authorizationId);
    if (!saved) throw new Error('Approve this provider request before generating.');
    if (saved.expiresAt < this.now()) throw new Error('Provider approval expired. Review and approve this request again.');
    if (saved.fingerprint !== generationRequestFingerprint(request)) {
      throw new Error('The generation settings changed after approval. Review and approve this request again.');
    }
    return true;
  }
}
