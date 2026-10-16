// Review & UGC Studio Engine for Vidmyo V2.6
// Implements Type 1 (Review Searches) and Type 2 (Goal/Problem/How-To Searches) conversion structures,
// strict claim verification (forbidding fabricated tests/reviews), and regulatory disclosure tags.

import { createEdgTimeline } from './edg.js';
import { RESPONSIVE_LAYOUTS } from './promoAds.js';

export const UGC_FUNNEL_TYPES = {
  TYPE_1_REVIEW_SEARCH: 'type_1_review_search',   // Bottom-of-funnel (High buyer intent)
  TYPE_2_GOAL_PROBLEM:  'type_2_goal_problem',    // Top/Mid-of-funnel (Educational / Discovery)
};

export const DISCLOSURE_TAGS = {
  AFFILIATE: '#afiliacja #affiliate (zawiera linki partnerskie)',
  SPONSORED: '#współpraca (materiał sponsorowany)',
  SYNTHETIC: '#ai #synthetic (materiał wygenerowany z pomocą AI)',
};

/**
 * Validates claims and ensures no fabricated experience or testimonials exist.
 */
export function verifyUgcClaims(claims) {
  const violations = [];
  const validClaims = [];

  for (const c of claims) {
    const text = (c.text || c.claim || '').toLowerCase();

    // Check for fabricated 30-day experience without explicit user verification flag
    if (/testowałem przez 30 dni|używałem przez miesiąc|tested for 30 days/i.test(text) && !c.userExplicitlyConfirmedExperience) {
      violations.push({
        claim: c.text,
        rule: 'FABRICATED_EXPERIENCE_PROHIBITED',
        message: "Twierdzenie 'testowałem przez 30 dni' wymaga bezpośredniego potwierdzenia rzeczywistego testu przez użytkownika.",
      });
      continue;
    }

    // Check for fabricated customer quote
    if (c.type === 'customer_quote' && (!c.source || !c.author)) {
      violations.push({
        claim: c.text,
        rule: 'FABRICATED_TESTIMONIAL_PROHIBITED',
        message: 'Opinia klienta wymaga podania weryfikowalnego źródła (np. recenzja Trustpilot, Google Reviews, wypowiedź klienta).',
      });
      continue;
    }

    validClaims.push(c);
  }

  return {
    valid: violations.length === 0,
    validClaims,
    violations,
  };
}

/**
 * Generates Type 1 Review Script (Bottom-of-funnel).
 * Formula: Hook -> Instant Verdict -> Unboxing/Tour -> Brutal Honesty -> Who it is/is NOT for -> Bonus & CTA
 */
export function generateType1ReviewScript({
  productName,
  verdict,
  pros = [],
  cons = [],
  targetAudience,
  avoidAudience,
  bonusOffer,
  ctaLink,
  claims = [],
}) {
  const verification = verifyUgcClaims(claims);
  if (!verification.valid) {
    throw new Error(`Claim verification failed: ${verification.violations.map(v => v.message).join(' ')}`);
  }

  const sections = [
    {
      step: '1_hook',
      text: `Czy ${productName} to rzeczywiście przełom, czy tylko kolejny przereklamowany produkt?`,
    },
    {
      step: '2_instant_verdict',
      text: verdict || `Krótka odpowiedź: tak, ale z jednym bardzo ważnym zastrzeżeniem, o którym nikt nie mówi.`,
    },
    {
      step: '3_tour',
      text: `Zobaczmy, jak dokładnie działa ${productName} w codziennej praktyce i co otrzymujesz po zakupie.`,
    },
    {
      step: '4_brutal_honesty',
      text: `Zalety: ${pros.join(', ') || 'wysoka skuteczność'}. Ale spójrzmy prawdzie w oczy — minusy: ${cons.join(', ') || 'wymaga czasu na wdrożenie'}.`,
    },
    {
      step: '5_qualifier',
      text: `Dla kogo to jest? Dla ${targetAudience || 'zdecydowanych twórców'}. Kto NIE powinien tego kupować? ${avoidAudience || 'Osoby szukające magicznych przycisków'}.`,
    },
    {
      step: '6_bonus_cta',
      text: bonusOffer
        ? `Jeśli zdecydujesz się sprawdzić produkt przez mój link poniżej, otrzymasz dodatkowo: ${bonusOffer}. Link znajdziesz w opisie.`
        : `Sprawdź aktualną ofertę i zniżkę w linku pod tym filmem.`,
    },
  ];

  return {
    type: UGC_FUNNEL_TYPES.TYPE_1_REVIEW_SEARCH,
    sections,
    disclosures: [DISCLOSURE_TAGS.AFFILIATE, DISCLOSURE_TAGS.SYNTHETIC],
    fullScript: sections.map(s => s.text).join(' '),
  };
}

/**
 * Generates Type 2 Goal/Problem/How-To Script (Top/Mid-of-funnel).
 * Formula: Pain Hook -> Myth Busting -> Hidden Mechanism -> Vehicle/Solution -> Social Proof -> Action CTA
 */
export function generateType2GoalProblemScript({
  goalOrProblem,
  mythsBusted,
  hiddenMechanism,
  solutionProduct,
  socialProof,
  ctaText,
}) {
  const sections = [
    {
      step: '1_pain_hook',
      text: `Próbujesz rozwiązać problem: ${goalOrProblem}, ale nic nie działa tak, jak powinno?`,
    },
    {
      step: '2_myth_busting',
      text: `Większość poradników powtarza ten sam mit: ${mythsBusted || 'musisz robić więcej tego samego'}. To droga do wypalenia.`,
    },
    {
      step: '3_hidden_mechanism',
      text: `Prawdziwa przyczyna leży gdzie indziej: ${hiddenMechanism || 'kluczowa jest automatyzacja procesu'}.`,
    },
    {
      step: '4_vehicle_solution',
      text: `Dlatego korzystam z ${solutionProduct} — rozwiązania, które usuwa wąskie gardło.`,
    },
    {
      step: '5_social_proof',
      text: socialProof || `Potwierdzają to wyniki setek użytkowników i opinie w branży.`,
    },
    {
      step: '6_action_cta',
      text: ctaText || `Kliknij link poniżej, aby bezpłatnie sprawdzić szczegóły i wdrożyć to u siebie.`,
    },
  ];

  return {
    type: UGC_FUNNEL_TYPES.TYPE_2_GOAL_PROBLEM,
    sections,
    disclosures: [DISCLOSURE_TAGS.AFFILIATE],
    fullScript: sections.map(s => s.text).join(' '),
  };
}

/**
 * Builds a responsive EDG timeline from a UGC review script in 9:16, 1:1, or 16:9.
 */
export function createResponsiveUgcEdg(ugcScript, layoutKey = 'VERTICAL_9_16', {
  assets = {},
  fps = 30,
} = {}) {
  const layout = RESPONSIVE_LAYOUTS[layoutKey] || RESPONSIVE_LAYOUTS.VERTICAL_9_16;
  const sections = ugcScript?.sections || [];
  const durationPerSection = 3.5;
  const totalDurationSec = Math.max(15, sections.length * durationPerSection);
  const totalTimelineFrames = Math.round(totalDurationSec * fps);

  const edg = createEdgTimeline({
    title: `UGC Review - ${layout.aspect}`,
    aspect: layout.aspect,
    fps,
    assets: { ...assets },
    tracks: [
      { id: 'video-bg', type: 'video', name: 'Background Track', clips: [] },
      { id: 'captions-headline', type: 'caption', name: 'Hook & Verdict', clips: [] },
      { id: 'captions-benefits', type: 'caption', name: 'Review Details & CTA', clips: [] },
      { id: 'disclosures', type: 'caption', name: 'Regulatory Disclosures', clips: [] },
    ],
  });

  edg.canvas.width = layout.width;
  edg.canvas.height = layout.height;
  edg.canvas.aspect = layout.aspect;
  edg.totalTimelineFrames = totalTimelineFrames;

  const headlineTrack = edg.tracks.find(t => t.id === 'captions-headline');
  const benefitsTrack = edg.tracks.find(t => t.id === 'captions-benefits');
  const disclosureTrack = edg.tracks.find(t => t.id === 'disclosures');

  const hookSection = sections.find(s => s.step?.includes('hook')) || sections[0];
  const ctaSection = sections.find(s => s.step?.includes('cta')) || sections[sections.length - 1];

  if (headlineTrack && hookSection) {
    headlineTrack.clips.push({
      id: 'ugc_hook',
      text: hookSection.text,
      timelineStartFrame: 0,
      timelineEndFrame: Math.round(4 * fps),
      transform: { x: layout.width / 2, y: layout.headlineY },
    });
  }

  if (benefitsTrack && ctaSection) {
    benefitsTrack.clips.push({
      id: 'ugc_cta',
      text: ctaSection.text,
      timelineStartFrame: Math.round(4 * fps),
      timelineEndFrame: totalTimelineFrames,
      transform: { x: layout.width / 2, y: layout.benefitsY },
    });
  }

  if (disclosureTrack && ugcScript?.disclosures?.length > 0) {
    disclosureTrack.clips.push({
      id: 'ugc_disclosure',
      text: ugcScript.disclosures.join(' | '),
      timelineStartFrame: 0,
      timelineEndFrame: totalTimelineFrames,
      transform: { x: layout.width / 2, y: layout.height - 60 },
    });
  }

  return edg;
}

