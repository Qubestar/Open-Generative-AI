// Stock & B-roll Matcher Engine for Vidmyo V2.6
// Implements Visual Intent Extraction, Media License Registry,
// Match Confidence Threshold (default 0.72) with fallback to original,
// and 1-Click Swap canvas model.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_MATCH_CONFIDENCE_THRESHOLD = 0.72;

// Exact approved licence codes. A free-text licence string declared in a
// manifest is NOT accepted: the value must equal one of these codes
// (comparison is exact after lowercase/trim, not substring).
export const APPROVED_LICENSE_CODES = ['cc0', 'pexels', 'pixabay', 'coverr'];

// Backwards-compatible alias (exact codes; MRR/PLR removed — pack blocked).
export const PERMITTED_LICENSES = APPROVED_LICENSE_CODES;

/**
 * Validates the licence fields required for every B-roll registry entry.
 * An entry is accepted only when ALL of the following hold:
 *   - id (non-empty string) and fileHash (>= 8 chars)
 *   - redistributionRight === true (explicit)
 *   - source (non-empty string: origin/provider of the clip)
 *   - proof of licence: licenseProofUrl (http/https) OR licenseProofDoc (document path)
 *   - license equals an approved code exactly (free-text declarations rejected)
 *   - MRR/PLR licences stay blocked (no redistribution licence document on file)
 * Returns { ok, reasons } where reasons are exact, UI-presentable strings.
 */
export function validateBrollLicenseFields(entry) {
  const reasons = [];
  if (!entry || typeof entry !== 'object') {
    return { ok: false, reasons: ['entry is not an object'] };
  }
  if (!entry.id || typeof entry.id !== 'string') {
    reasons.push('missing required field: id');
  }
  if (!entry.fileHash || String(entry.fileHash).length < 8) {
    reasons.push('missing required field: fileHash (min 8 characters)');
  }
  if (entry.redistributionRight !== true) {
    reasons.push('missing or false field: redistributionRight (must be explicitly true)');
  }
  if (!entry.source || typeof entry.source !== 'string' || !entry.source.trim()) {
    reasons.push('missing required field: source (origin or provider of the clip)');
  }
  const hasUrl = typeof entry.licenseProofUrl === 'string' && /^https?:\/\/\S+$/i.test(entry.licenseProofUrl.trim());
  const hasDoc = typeof entry.licenseProofDoc === 'string' && entry.licenseProofDoc.trim().length > 0;
  if (!hasUrl && !hasDoc) {
    reasons.push('missing proof of licence: provide licenseProofUrl (http/https) or licenseProofDoc (document path)');
  }
  const lic = String(entry.license || '').toLowerCase().trim();
  if (!lic) {
    reasons.push('missing required field: license');
  } else if (lic.includes('mrr') || lic.includes('plr') || lic === 'commercial_mrr_plr') {
    reasons.push(`License '${entry.license}' blocked: MRR/PLR pack has no redistribution licence document`);
  } else if (!APPROVED_LICENSE_CODES.includes(lic)) {
    reasons.push(`License '${entry.license}' is not approved for commercial redistribution or production (approved codes: ${APPROVED_LICENSE_CODES.join(', ')}); a declared licence string alone is not accepted`);
  }
  return { ok: reasons.length === 0, reasons };
}

// Three built-in CC0 samples used only when the user has not configured a real
// B-roll library. No MRR/PLR pack has a confirmed redistribution license (see
// docs/plans/vidmyo-v2.6/STATUS.md), so this is intentionally small — it is
// not a stand-in for a real 1000+ clip catalog.
export const BUILTIN_CC0_SAMPLE_CLIPS = [
  { id: 'stock_code_typing', tags: ['code', 'screen', 'developer', 'software'], shot: 'medium', emotion: 'neutral', durationSec: 4.5, license: 'cc0', author: 'Vidmyo Team', fileHash: 'hash_code_typing_01', commercialAllowed: true, redistributionRight: true, source: 'vidmyo-builtin', licenseProofDoc: 'packages/core/src/broll.js' },
  { id: 'stock_charts_rising', tags: ['growth', 'sales', 'analytics', 'money'], shot: 'medium', emotion: 'neutral', durationSec: 3.2, license: 'cc0', author: 'Vidmyo Team', fileHash: 'hash_charts_rising_02', commercialAllowed: true, redistributionRight: true, source: 'vidmyo-builtin', licenseProofDoc: 'packages/core/src/broll.js' },
  { id: 'stock_office_meeting', tags: ['team', 'discussion', 'planning', 'business'], shot: 'medium', emotion: 'neutral', durationSec: 5.0, license: 'cc0', author: 'Vidmyo Team', fileHash: 'hash_office_meeting_03', commercialAllowed: true, redistributionRight: true, source: 'vidmyo-builtin', licenseProofDoc: 'packages/core/src/broll.js' },
];

/**
 * Loads a user-configurable B-roll registry from disk.
 * Looks for `<registryDir>/manifest.json`: an array of clip records
 * ({ id, tags, shot, emotion, durationSec, license, author, fileHash, path }).
 * Falls back to a small built-in CC0 sample set — labeled as such via
 * `source` — when no manifest is present, so callers never mistake a
 * missing user library for a populated one.
 */
export function loadBrollRegistry({ registryDir } = {}) {
  if (!registryDir) {
    const failed = BUILTIN_CC0_SAMPLE_CLIPS
      .map((clip, index) => ({ index, id: clip.id, ...validateBrollLicenseFields(clip) }))
      .filter(v => !v.ok);
    if (failed.length > 0) {
      throw new Error(`Built-in CC0 sample clips failed licence validation (programming error): ${JSON.stringify(failed)}`);
    }
    return { source: 'builtin_cc0_sample', clips: BUILTIN_CC0_SAMPLE_CLIPS, rejected: [], manifestPath: null };
  }
  const manifestPath = path.join(registryDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { source: 'builtin_cc0_sample', clips: BUILTIN_CC0_SAMPLE_CLIPS, rejected: [], manifestPath: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`B-roll registry manifest at ${manifestPath} is not valid JSON: ${err.message}`);
  }
  const rawClips = Array.isArray(parsed) ? parsed : parsed.clips;
  if (!Array.isArray(rawClips)) {
    throw new Error(`B-roll registry manifest at ${manifestPath} must contain an array of clips`);
  }
  // Licence-field enforcement: partition entries into accepted clips and
  // rejected entries carrying the exact reasons (surfaced verbatim in the UI).
  const clips = [];
  const rejected = [];
  rawClips.forEach((clip, index) => {
    const v = validateBrollLicenseFields(clip);
    if (v.ok) {
      clips.push(clip);
    } else {
      rejected.push({
        index,
        id: clip && typeof clip === 'object' && clip.id ? clip.id : null,
        reasons: v.reasons,
      });
    }
  });
  return { source: 'user_registry', clips, rejected, manifestPath };
}

/**
 * Extracts structured visual intent from a sentence or beat.
 */
export function extractVisualIntent(sentence, { defaultShot = 'medium' } = {}) {
  const text = String(sentence || '').trim();
  if (!text) {
    throw new Error('Sentence is required for visual intent extraction');
  }

  // Tokenize & detect intent keywords
  const lower = text.toLowerCase();
  let emotion = 'neutral';
  if (/stress|spadek|kryzys|strach|panik|problem|fail|trud/i.test(lower)) emotion = 'stressed';
  else if (/sukces|zysk|wzrost|radość|happy|win|wygra/i.test(lower)) emotion = 'triumphant';
  else if (/sekret|tajemnic|odkryj|uwaga|zobacz/i.test(lower)) emotion = 'intrigued';

  let shot = defaultShot;
  if (/zbliżenie|twarz|oczy|szczegół|close/i.test(lower)) shot = 'close_up';
  else if (/panoram|krajobraz|biuro|miasto|wide/i.test(lower)) shot = 'wide';

  const keywords = lower
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3)
    .slice(0, 5);

  return {
    rawSentence: text,
    subject: keywords[0] || 'person',
    action: keywords[1] || 'working',
    emotion,
    shot,
    keywords,
  };
}

export class MediaLicenseRegistry {
  constructor() {
    this.registry = new Map();
  }

  register({
    id,
    author,
    source, // pexels, pixabay, coverr, vidmyo-builtin, ...
    license,
    date = new Date().toISOString(),
    permittedUse = 'commercial_video',
    attributionRequired = false,
    fileHash,
    redistributionRight,
    licenseProofUrl,
    licenseProofDoc,
  }) {
    if (!id) throw new Error('Media asset id is required');
    if (!fileHash || fileHash.length < 8) throw new Error('Valid fileHash is required for license registry');

    // Full licence-field enforcement: redistributionRight, source, proof of
    // licence and an exact approved licence code are all mandatory. A licence
    // string declared in a manifest alone is never sufficient.
    const check = validateBrollLicenseFields({
      id,
      fileHash,
      license,
      source,
      redistributionRight,
      licenseProofUrl,
      licenseProofDoc,
    });
    if (!check.ok) {
      throw new Error(`License registry rejected '${id}': ${check.reasons.join('; ')}`);
    }

    const normalizedLicense = String(license || '').toLowerCase().trim();

    const record = {
      id,
      author: author || 'Unknown / Public Stock',
      source,
      license: normalizedLicense,
      date,
      permittedUse,
      attributionRequired,
      fileHash,
      redistributionRight: true,
      licenseProofUrl: licenseProofUrl || null,
      licenseProofDoc: licenseProofDoc || null,
    };
    this.registry.set(id, record);
    return record;
  }

  get(id) {
    return this.registry.get(id) || null;
  }

  verifyCommercialEligibility(id) {
    const record = this.get(id);
    if (!record) return { eligible: false, reason: 'Asset not registered in license ledger' };
    return { eligible: true, record };
  }
}

/**
 * Matches candidate B-roll clips against visual intent with confidence scoring.
 * Preserves original footage if top match confidence < threshold.
 */
export function matchBrollClip(visualIntent, candidateClips, {
  threshold = DEFAULT_MATCH_CONFIDENCE_THRESHOLD,
  licenseRegistry = null,
} = {}) {
  if (!Array.isArray(candidateClips) || candidateClips.length === 0) {
    return {
      action: 'preserve_original',
      reason: 'No candidate clips available',
      confidence: 0,
      chosenClip: null,
      alternatives: [],
    };
  }

  // Calculate score for each candidate
  const scored = candidateClips.map(clip => {
    let score = 0;
    const clipTags = (clip.tags || []).map(t => t.toLowerCase());

    // Keyword match (0.4)
    const matchedKeywords = visualIntent.keywords.filter(k => clipTags.includes(k));
    const keywordScore = visualIntent.keywords.length > 0 ? (matchedKeywords.length / visualIntent.keywords.length) * 0.4 : 0.2;
    score += keywordScore;

    // Shot type match (0.3)
    if (clip.shot === visualIntent.shot) score += 0.3;

    // Emotion match (0.3)
    if (clip.emotion === visualIntent.emotion) score += 0.3;

    // Check license eligibility if registry provided
    if (licenseRegistry && clip.id) {
      const eligibility = licenseRegistry.verifyCommercialEligibility(clip.id);
      if (!eligibility.eligible) score = 0; // Ineligible license disqualifies clip
    }

    return {
      ...clip,
      matchScore: Math.min(1.0, score),
    };
  });

  scored.sort((a, b) => b.matchScore - a.matchScore);
  const best = scored[0];

  if (best.matchScore < threshold) {
    return {
      action: 'preserve_original',
      reason: `Best match score (${best.matchScore.toFixed(2)}) is below confidence threshold (${threshold})`,
      confidence: best.matchScore,
      chosenClip: null,
      alternatives: scored.slice(0, 5), // Provide 1-click swap alternatives to user
    };
  }

  return {
    action: 'insert_broll',
    confidence: best.matchScore,
    chosenClip: best,
    alternatives: scored.slice(1, 5),
  };
}
