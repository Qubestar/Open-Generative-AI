// Viral Retention & Dual-Hook Engine for Vidmyo V2.6
// Implements Dual-Hook system (2.5s window), R.A.I.N.Y. heuristics scoring,
// Anti-Fatigue 30-day rotation registry, downloadable asset manifest, and retention loops.

export const ROTATION_WINDOW_DAYS = 30;
export const MAX_HOOK_WINDOW_SECONDS = 2.5;

/**
 * Evaluates the script hook against the R.A.I.N.Y. framework.
 * (Relevance, Anticipation, Intrigue, Novelty, You)
 * Returns a score out of 100 with actionable feedback.
 */
export function scoreRainyHook(hookText) {
  const text = String(hookText || '').trim();
  if (!text) return { totalScore: 0, feedback: ['Hook is empty.'] };

  const lower = text.toLowerCase();
  let relevance = 10;
  let anticipation = 10;
  let intrigue = 10;
  let novelty = 10;
  let you = 10;
  const feedback = [];

  // You: Direct personal address (you, your, ciebie, twój, ci)
  if (/\b(you|your|ciebie|twoj|twój|cię|tobie|dla ciebie)\b/i.test(lower)) {
    you = 20;
  } else {
    feedback.push("Add direct address ('you' / 'twoje') to increase personal relevance.");
  }

  // Intrigue: Curiosity gap or mystery words (secret, why, truth, dlaczego, prawda, sekret)
  if (/\b(secret|why|truth|never|mistake|sekret|dlaczego|prawda|błąd|nigdy|ukryt)\b/i.test(lower)) {
    intrigue = 20;
  } else {
    feedback.push("Introduce a curiosity gap ('secret', 'why', 'biggest mistake').");
  }

  // Anticipation: Forward promise (watch until, in this video, zaraz, za chwilę)
  if (/\b(before|after|this video|wait|zaraz|za chwile|zanim|zobaczysz)\b/i.test(lower)) {
    anticipation = 20;
  }

  // Novelty: Unexpected angle, contrast, or counter-intuitive claim
  if (/\b(stop|don't|nie rób|zamiast|instead|actually|nowy|przełom)\b/i.test(lower)) {
    novelty = 20;
  }

  // Relevance: Clear topic or industry term mentioned
  if (text.length > 25 && text.length < 140) {
    relevance = 20;
  } else if (text.length >= 140) {
    feedback.push('Hook is too long (> 140 chars) for a punchy 2.5s opening.');
  }

  const totalScore = relevance + anticipation + intrigue + novelty + you;
  return {
    totalScore,
    breakdown: { relevance, anticipation, intrigue, novelty, you },
    feedback,
    isStrong: totalScore >= 75,
  };
}

/**
 * Anti-Fatigue Hook Rotation Registry.
 * Guarantees that the same visual hook clip does not appear on the same channel
 * more frequently than once every 30 days to protect from algorithmic penalties.
 */
export class HookRotationRegistry {
  constructor({ rotationDays = ROTATION_WINDOW_DAYS } = {}) {
    this.rotationDays = rotationDays;
    this.history = new Map(); // channelId -> Array<{ clipId, usedAt }>
  }

  recordUsage(channelId, clipId, usedAt = new Date().toISOString()) {
    if (!channelId || !clipId) throw new Error('channelId and clipId are required');
    if (!this.history.has(channelId)) this.history.set(channelId, []);
    this.history.get(channelId).push({ clipId, usedAt });
  }

  isClipAvailable(channelId, clipId, checkDate = new Date()) {
    const list = this.history.get(channelId) || [];
    const checkTime = new Date(checkDate).getTime();
    const windowMs = this.rotationDays * 24 * 60 * 60 * 1000;

    for (const record of list) {
      if (record.clipId === clipId) {
        const recordTime = new Date(record.usedAt).getTime();
        const diffMs = checkTime - recordTime;
        if (diffMs < windowMs && diffMs >= 0) {
          const daysRemaining = Math.ceil((windowMs - diffMs) / (24 * 60 * 60 * 1000));
          return { available: false, daysRemaining, lastUsed: record.usedAt };
        }
      }
    }

    return { available: true };
  }

  filterAvailableClips(channelId, candidateClips, checkDate = new Date()) {
    return candidateClips.filter(c => this.isClipAvailable(channelId, c.id, checkDate).available);
  }
}

/**
 * Injects retention loops and midpoint re-engagement events into the project timeline.
 * Targets 45% - 70% of total video duration.
 */
export function generateRetentionEvents(totalDurationSec) {
  if (typeof totalDurationSec !== 'number' || totalDurationSec <= 0) {
    throw new Error(`Invalid totalDurationSec: ${totalDurationSec}`);
  }

  const events = [];

  // Opening Dual-Hook (0 - 2.5s)
  events.push({
    type: 'dual_hook',
    startSec: 0,
    endSec: Math.min(MAX_HOOK_WINDOW_SECONDS, totalDurationSec * 0.1),
    description: 'Curiosity gap verbal hook paired with visual pattern interrupt.',
  });

  // Midpoint Re-engagement (at 50-60%)
  if (totalDurationSec >= 30) {
    const midpointSec = totalDurationSec * 0.55;
    events.push({
      type: 'midpoint_twist',
      startSec: Math.round(midpointSec),
      endSec: Math.round(midpointSec + 3.0),
      description: 'Midpoint narrative re-engagement: contrast, twist, or revealing the hidden mechanism.',
    });
  }

  // Open loop reminder (at 70-75%)
  if (totalDurationSec >= 60) {
    const loopSec = totalDurationSec * 0.72;
    events.push({
      type: 'retention_loop_payoff',
      startSec: Math.round(loopSec),
      endSec: Math.round(loopSec + 4.0),
      description: 'Closing the open loop established in the opening hook.',
    });
  }

  return events;
}

/**
 * Manifest definitions for downloadable Visual Hooks library (replaces bundling 5GB).
 */
export function createHooksDownloadManifest(items = []) {
  return {
    version: '1.0.0',
    totalClips: items.length,
    downloadBaseUrl: 'https://cdn.vidmyo.ai/packs/visual_hooks_v1',
    license: 'Master Resell Rights (MRR) & Private Label Rights (PLR)',
    items: items.map((item, idx) => ({
      id: item.id || `hook_${String(idx + 1).padStart(4, '0')}`,
      title: item.title || `Visual Hook ${idx + 1}`,
      durationSec: item.durationSec || 2.5,
      fileSize: item.fileSize || 1024 * 1024 * 3, // ~3 MB per clip
      hash: item.hash || 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      tags: item.tags || ['hypnotic', 'speed', 'zoom'],
    })),
  };
}
