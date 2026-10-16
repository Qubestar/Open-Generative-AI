function byteView(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (Array.isArray(bytes)) return Uint8Array.from(bytes);
  return null;
}

export function imageReadResultToHandoff({ artifact, prompt = '', jobId = '', collection = '' } = {}, readResult = {}) {
  const bytes = byteView(readResult?.bytes);
  const mime = typeof readResult?.mime === 'string' ? readResult.mime : '';
  if (!readResult?.ok || typeof artifact !== 'string' || !artifact || !mime.startsWith('image/') || !bytes) {
    throw new Error(readResult?.error || 'Could not prepare this image for Video');
  }

  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  }
  return {
    sourceImage: { path: artifact, dataUrl: `data:${mime};base64,${btoa(chunks.join(''))}` },
    prompt: typeof prompt === 'string' ? prompt : '',
    sourceImageJobId: typeof jobId === 'string' ? jobId : '',
    collection: typeof collection === 'string' ? collection : '',
  };
}

export function videoStateFromImageHandoff(handoff, defaultModel) {
  if (!handoff?.sourceImage?.path || !handoff.sourceImage.dataUrl?.startsWith('data:image/')) return null;
  return {
    animate: true,
    sourceImage: { ...handoff.sourceImage },
    prompt: typeof handoff.prompt === 'string' ? handoff.prompt : '',
    model: defaultModel,
    customModel: '',
    sourceImageJobId: typeof handoff.sourceImageJobId === 'string' ? handoff.sourceImageJobId : '',
    collection: typeof handoff.collection === 'string' ? handoff.collection : '',
  };
}
