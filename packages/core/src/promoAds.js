// Promo & Ads Studio Engine for Vidmyo V2.6
// Implements SSRF-safe URL extraction, Hybrid Intent Classification,
// 5-step Ad Script generation, Claim Verification, and 3 Responsive Layouts.

import url from 'node:url';

export const PROMO_INTENT_CATEGORIES = {
  LOCAL_BUSINESS: 'local_business',
  ECOMMERCE_PRODUCT: 'ecommerce_product',
  DIGITAL_SAAS: 'digital_saas',
};

export const RESPONSIVE_LAYOUTS = {
  VERTICAL_9_16: {
    aspect: '9:16',
    width: 1080,
    height: 1920,
    headlineY: 200,
    mediaY: 600,
    benefitsY: 1450,
  },
  SQUARE_1_1: {
    aspect: '1:1',
    width: 1080,
    height: 1080,
    headlineY: 100,
    mediaY: 350,
    benefitsY: 850,
  },
  LANDSCAPE_16_9: {
    aspect: '16:9',
    width: 1920,
    height: 1080,
    headlineY: 150,
    mediaY: 300,
    benefitsY: 850,
  },
};

import dns from 'node:dns';
import { createEdgTimeline } from './edg.js';

export function isIpAddressLiteral(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim();
  if (s.includes(':')) return true; // IPv6 literal
  const parts = s.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p) && Number(p) >= 0 && Number(p) <= 255)) {
    return true; // IPv4 literal
  }
  return false;
}

export function isBlockedIpAddress(ipStr) {
  if (!ipStr || typeof ipStr !== 'string') return false;
  const ip = ipStr.trim().toLowerCase();

  // If not an IP literal, return false (it's a domain name!)
  if (!isIpAddressLiteral(ip)) return false;

  // IPv6 checks
  if (ip.includes(':')) {
    if (ip === '::' || ip === '::1') return true; // unspecified / loopback
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // ULA fc00::/7
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // link-local fe80::/10
    if (ip.startsWith('ff')) return true; // multicast ff00::/8
    if (ip.startsWith('64:ff9b::')) return true; // NAT64

    // Check IPv4-mapped IPv6 (::ffff:192.168.1.1 or ::ffff:127.0.0.1)
    const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (v4Mapped) {
      return isBlockedIpAddress(v4Mapped[1]);
    }
    const hexMapped = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (hexMapped) {
      const b0 = parseInt(hexMapped[1], 16) >> 8;
      const b1 = parseInt(hexMapped[1], 16) & 0xff;
      const b2 = parseInt(hexMapped[2], 16) >> 8;
      const b3 = parseInt(hexMapped[2], 16) & 0xff;
      return isBlockedIpAddress(`${b0}.${b1}.${b2}.${b3}`);
    }
    return false;
  }

  // IPv4 checks
  const parts = ip.split('.').map(Number);
  const [b0, b1, b2, b3] = parts;
  if (b0 === 0) return true; // 0.0.0.0/8
  if (b0 === 10) return true; // 10.0.0.0/8
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64.0.0/10
  if (b0 === 127) return true; // 127.0.0.0/8 loopback
  if (b0 === 169 && b1 === 254) return true; // 169.254.0.0/16 link-local
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16.0.0/12
  if (b0 === 192 && b1 === 0 && b2 === 0) return true; // 192.0.0.0/24
  if (b0 === 192 && b1 === 0 && b2 === 2) return true; // 192.0.2.0/24 TEST-NET-1
  if (b0 === 192 && b1 === 168) return true; // 192.168.0.0/16
  if (b0 === 198 && b1 === 51 && b2 === 100) return true; // 198.51.100.0/24 TEST-NET-2
  if (b0 === 203 && b1 === 0 && b2 === 113) return true; // 203.0.113.0/24 TEST-NET-3
  if (b0 >= 224) return true; // 224.0.0.0/4 multicast & 240.0.0.0/4 reserved & 255.255.255.255
  return false;
}

/**
 * Validates URLs against Server-Side Request Forgery (SSRF).
 * Blocks loopback (127.0.0.0/8, ::1), IPv6 ULA (fc00::/7), link-local (fe80::/10, 169.254.0.0/16),
 * IPv4-mapped IPv6, RFC1918 private IPs, and non-http protocols.
 */
export function validateUrlForSsrf(inputUrl, { dnsLookup = null, resolveDns = false } = {}) {
  let parsed;
  try {
    parsed = new url.URL(inputUrl);
  } catch {
    throw new Error(`Invalid URL format: ${inputUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Prohibited protocol: ${parsed.protocol}. Only http and https allowed.`);
  }

  const hostname = parsed.hostname.toLowerCase();
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  // Check localhost / loopback string names
  if (
    cleanHost === 'localhost' ||
    cleanHost === '0.0.0.0' ||
    cleanHost === '127.0.0.1' ||
    cleanHost === '::1' ||
    cleanHost.endsWith('.localhost') ||
    cleanHost.endsWith('.local') ||
    cleanHost.endsWith('.internal')
  ) {
    throw new Error(`SSRF blocked: Loopback address ${hostname} is forbidden.`);
  }

  // Cloud metadata endpoint hostnames
  if (cleanHost.includes('169.254.169.254') || cleanHost.includes('metadata.google.internal')) {
    throw new Error('SSRF blocked: Cloud metadata service endpoint is forbidden.');
  }

  // If host is an IP literal, validate directly
  if (isBlockedIpAddress(cleanHost)) {
    if (cleanHost.startsWith('127.')) {
      throw new Error(`SSRF blocked: Loopback address ${hostname} is forbidden.`);
    }
    if (cleanHost.startsWith('10.') || cleanHost.startsWith('192.168.') || (cleanHost.startsWith('172.') && !cleanHost.includes(':'))) {
      throw new Error(`SSRF blocked: Private network IP ${hostname}`);
    }
    throw new Error(`SSRF blocked: Prohibited IP address ${hostname}`);
  }

  // If DNS resolution requested or lookup injected, return async promise
  if (resolveDns || dnsLookup) {
    return (async () => {
      const lookupFn = dnsLookup || (async (host) => {
        try {
          return await dns.promises.lookup(host, { all: true });
        } catch (err) {
          throw new Error(`DNS resolution failed for ${host}: ${err.message}`);
        }
      });

      const addresses = await lookupFn(cleanHost);
      if (!addresses || addresses.length === 0) {
        throw new Error(`DNS resolution returned no IP addresses for ${cleanHost}`);
      }

      for (const record of addresses) {
        const ip = typeof record === 'string' ? record : record.address;
        if (isBlockedIpAddress(ip)) {
          throw new Error(`SSRF blocked: Hostname ${cleanHost} resolved to prohibited IP address ${ip}`);
        }
      }

      return {
        valid: true,
        normalizedUrl: parsed.toString(),
        hostname,
        resolvedIps: addresses.map(a => typeof a === 'string' ? a : a.address),
      };
    })();
  }

  return {
    valid: true,
    normalizedUrl: parsed.toString(),
    hostname,
  };
}

/**
 * Async DNS-resolving URL validation.
 */
export async function resolveAndValidateUrlForSsrf(inputUrl, { dnsLookup = null } = {}) {
  return validateUrlForSsrf(inputUrl, { dnsLookup, resolveDns: true });
}

/**
 * Safe HTTP crawler for extracting product metadata without prompt execution risk.
 * Enforces redirect re-checking, download size caps, and network timeouts.
 */
export async function safeFetchPromoPage(targetUrl, {
  maxRedirects = 3,
  maxSizeBytes = 1024 * 1024, // 1 MiB limit
  timeoutMs = 5000,
  fetchImpl = fetch,
  dnsLookup = null,
} = {}) {
  let currentUrl = targetUrl;
  let redirectsRemaining = maxRedirects;

  while (true) {
    await resolveAndValidateUrlForSsrf(currentUrl, { dnsLookup });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res;
    try {
      res = await fetchImpl(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'Vidmyo-Promo-Crawler/2.6 (+https://vidmyo.com)',
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new Error(`Crawler timeout after ${timeoutMs}ms for ${currentUrl}`);
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirectsRemaining <= 0) {
        throw new Error(`Crawler exceeded maximum redirects (${maxRedirects})`);
      }
      redirectsRemaining--;
      const loc = res.headers.get('location');
      if (!loc) throw new Error(`Redirect status ${res.status} missing Location header`);
      currentUrl = new url.URL(loc, currentUrl).toString();
      continue;
    }

    if (!res.ok) {
      throw new Error(`HTTP error ${res.status} ${res.statusText} fetching ${currentUrl}`);
    }

    let content = '';
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxSizeBytes) {
      throw new Error(`Crawler response exceeded size limit of ${maxSizeBytes} bytes`);
    }
    content = text;

    const titleMatch = content.match(/<title[^>]*>([^<]+)<\/title>/i);
    const metaDescMatch = content.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i) ||
                          content.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
    const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const priceMatch = content.match(/(\$|€|£|zł|PLN)\s?(\d+(?:[.,]\d{2})?)/i) ||
                       content.match(/(\d+(?:[.,]\d{2})?)\s?(zł|PLN|USD|EUR)/i);

    const features = [];
    const liMatches = content.matchAll(/<li[^>]*>([^<]+)<\/li>/gi);
    for (const m of liMatches) {
      const item = m[1].replace(/<[^>]+>/g, '').trim();
      if (item.length > 5 && item.length < 120 && features.length < 5) {
        features.push(item);
      }
    }

    return {
      url: currentUrl,
      title: titleMatch ? titleMatch[1].trim() : '',
      description: metaDescMatch ? metaDescMatch[1].trim() : '',
      h1: h1Match ? h1Match[1].trim() : '',
      price: priceMatch ? priceMatch[0].trim() : null,
      features,
      isUntrustedData: true,
    };
  }
}

/**
 * Builds an EDG timeline from a promo script positioned to one of the 3 responsive layouts.
 */
export function createResponsivePromoEdg(script, layoutKey = 'VERTICAL_9_16', {
  assets = {},
  durationSec = 15,
  fps = 30,
} = {}) {
  const layout = RESPONSIVE_LAYOUTS[layoutKey];
  if (!layout) throw new Error(`Unknown responsive layout key: ${layoutKey}`);

  const totalTimelineFrames = Math.round(durationSec * fps);

  const edg = createEdgTimeline({
    title: `Promo Ad - ${layout.aspect}`,
    aspect: layout.aspect,
    fps,
    assets: {
      ...assets,
    },
    tracks: [
      { id: 'video-bg', type: 'video', name: 'Background Video/Color', clips: [] },
      { id: 'overlay-product', type: 'overlay', name: 'Product Focus', clips: [] },
      { id: 'captions-headline', type: 'caption', name: 'Headline & Hook', clips: [] },
      { id: 'captions-benefits', type: 'caption', name: 'Benefits & CTA', clips: [] },
    ],
  });

  edg.canvas.width = layout.width;
  edg.canvas.height = layout.height;
  edg.canvas.aspect = layout.aspect;
  edg.totalTimelineFrames = totalTimelineFrames;

  const headlineTrack = edg.tracks.find(t => t.id === 'captions-headline');
  const benefitsTrack = edg.tracks.find(t => t.id === 'captions-benefits');

  const headlineText = script?.scriptParts?.hook || script?.hook || 'Specjalna Oferta';
  const ctaText = script?.scriptParts?.cta || script?.cta || 'Sprawdź Szczegóły!';

  const splitFrame = Math.max(1, Math.min(Math.round(5 * fps), Math.floor(totalTimelineFrames / 2)));

  if (headlineTrack) {
    headlineTrack.clips.push({
      id: 'clip_headline_01',
      text: headlineText,
      timelineStartFrame: 0,
      timelineEndFrame: splitFrame,
      transform: { x: layout.width / 2, y: layout.headlineY },
    });
  }

  if (benefitsTrack) {
    benefitsTrack.clips.push({
      id: 'clip_cta_01',
      text: ctaText,
      timelineStartFrame: splitFrame,
      timelineEndFrame: totalTimelineFrames,
      transform: { x: layout.width / 2, y: layout.benefitsY },
    });
  }

  return edg;
}

/**
 * Classifies offer intent based on extracted structured metadata.
 * Supports manual override.
 */
export function classifyPromoIntent(pageMetadata, userOverride = null) {
  if (userOverride && Object.values(PROMO_INTENT_CATEGORIES).includes(userOverride)) {
    return { category: userOverride, isOverridden: true };
  }

  const text = `${pageMetadata.title || ''} ${pageMetadata.description || ''} ${pageMetadata.h1 || ''}`.toLowerCase();

  // Local Business detection
  if (/warszawa|kraków|wrocław|poznan|dentysta|stomatolog|mechanik|gabinet|salon|lekarz|godziny otwarcia|ul\.|lokalizacja/i.test(text)) {
    return { category: PROMO_INTENT_CATEGORIES.LOCAL_BUSINESS, isOverridden: false };
  }

  // E-Commerce detection
  if (/koszyk|dodaj do koszyka|cena|zł|pln|\$|dostawa|wysyłka|sklep|produkt|rozmiar/i.test(text)) {
    return { category: PROMO_INTENT_CATEGORIES.ECOMMERCE_PRODUCT, isOverridden: false };
  }

  // Default to Digital / SaaS
  return { category: PROMO_INTENT_CATEGORIES.DIGITAL_SAAS, isOverridden: false };
}

/**
 * Generates structured 5-part advertising script with verified claim evidence.
 * Formula: Hook -> Problem -> Solution -> Offer -> CTA
 */
export function generatePromoScript({
  productName,
  category,
  coreBenefit,
  claims = [], // [{ claim, source, verified: boolean }]
  targetAudience = 'customers',
  ctaText = 'Sprawdź teraz w linku',
}) {
  if (!productName || !category) {
    throw new Error('productName and category are required to generate promo script');
  }

  // Validate that unverified claims are flagged
  const verifiedClaims = claims.filter(c => c.verified && c.source);
  const unverifiedClaims = claims.filter(c => !c.verified || !c.source);

  const scriptParts = {
    hook: `Szukasz sprawdzonego sposobu na ${coreBenefit || 'lepsze rezultaty'}? Zobacz to.`,
    problem: `Większość rozwiązań dla ${targetAudience} kosztuje za dużo i zabiera masę czasu.`,
    solution: `Oto ${productName} — nowoczesne narzędzie stworzone dokładnie po to.`,
    offer: verifiedClaims.length > 0
      ? `Potwierdzone dane: ${verifiedClaims.map(c => `${c.claim} (źródło: ${c.source})`).join(', ')}.`
      : `Zaprojektowane, by oszczędzać czas i dostarczać powtarzalne wyniki każdego dnia.`,
    cta: `${ctaText}!`,
  };

  return {
    category,
    scriptParts,
    verifiedClaims,
    unverifiedClaimsCount: unverifiedClaims.length,
    fullText: `${scriptParts.hook} ${scriptParts.problem} ${scriptParts.solution} ${scriptParts.offer} ${scriptParts.cta}`,
  };
}
