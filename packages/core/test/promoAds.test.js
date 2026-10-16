import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RendererAdapter, resolveFfmpegBinary } from '../src/rendererAdapter.js';
import {
  validateUrlForSsrf,
  resolveAndValidateUrlForSsrf,
  safeFetchPromoPage,
  createResponsivePromoEdg,
  classifyPromoIntent,
  generatePromoScript,
  PROMO_INTENT_CATEGORIES,
} from '../src/promoAds.js';

test('validateUrlForSsrf blocks loopback, private networks, and invalid protocols', () => {
  // Loopback
  assert.throws(() => validateUrlForSsrf('http://localhost:3000/api'), /Loopback address/);
  assert.throws(() => validateUrlForSsrf('http://127.0.0.1:8080/test'), /Loopback address/);
  assert.throws(() => validateUrlForSsrf('http://[::1]/'), /Loopback address/);

  // Private RFC1918
  assert.throws(() => validateUrlForSsrf('http://192.168.1.1/admin'), /Private network IP/);
  assert.throws(() => validateUrlForSsrf('http://10.0.0.5/page'), /Private network IP/);
  assert.throws(() => validateUrlForSsrf('http://172.20.0.1/status'), /Private network IP/);

  // Cloud metadata service
  assert.throws(() => validateUrlForSsrf('http://169.254.169.254/latest/meta-data/'), /metadata service/);

  // Invalid protocol
  assert.throws(() => validateUrlForSsrf('file:///etc/passwd'), /Prohibited protocol/);

  // Valid public URLs pass
  const valid = validateUrlForSsrf('https://example.com/product/123');
  assert.ok(valid.valid);
  assert.equal(valid.hostname, 'example.com');
});

test('classifyPromoIntent detects local business vs ecommerce vs saas', () => {
  const local = classifyPromoIntent({ title: 'Gabinet stomatologiczny Warszawa ul. Marszałkowska' });
  assert.equal(local.category, PROMO_INTENT_CATEGORIES.LOCAL_BUSINESS);

  const ecom = classifyPromoIntent({ title: 'Sklep obuwniczy - Dodaj do koszyka - Cena 299 zł' });
  assert.equal(ecom.category, PROMO_INTENT_CATEGORIES.ECOMMERCE_PRODUCT);

  const saas = classifyPromoIntent({ title: 'Automated Cloud Analytics Platform' });
  assert.equal(saas.category, PROMO_INTENT_CATEGORIES.DIGITAL_SAAS);

  // User override works
  const override = classifyPromoIntent({ title: 'Dentysta' }, PROMO_INTENT_CATEGORIES.DIGITAL_SAAS);
  assert.equal(override.category, PROMO_INTENT_CATEGORIES.DIGITAL_SAAS);
  assert.equal(override.isOverridden, true);
});

test('generatePromoScript incorporates verified claims and structures ad narrative', () => {
  const script = generatePromoScript({
    productName: 'Vidmyo',
    category: PROMO_INTENT_CATEGORIES.DIGITAL_SAAS,
    coreBenefit: 'automatyzację montażu wideo',
    claims: [
      { claim: '10x szybsza edycja', source: 'Internal benchmark M2 Pro', verified: true },
      { claim: '99.9% zadowolonych', source: '', verified: false },
    ],
  });

  assert.ok(script.fullText.includes('Vidmyo'));
  assert.ok(script.fullText.includes('10x szybsza edycja'));
  assert.equal(script.verifiedClaims.length, 1);
  assert.equal(script.unverifiedClaimsCount, 1);
});

test('validateUrlForSsrf blocks extended IP ranges (127.0.0.0/8, ULA, link-local, IPv4-mapped IPv6)', () => {
  // Whole 127.0.0.0/8 subnet
  assert.throws(() => validateUrlForSsrf('http://127.0.0.2:8000/'), /Loopback address/);
  assert.throws(() => validateUrlForSsrf('http://127.255.255.254/'), /Loopback address/);

  // IPv6 ULA (fc00::/7)
  assert.throws(() => validateUrlForSsrf('http://[fc00::1]/'), /Prohibited IP/);
  assert.throws(() => validateUrlForSsrf('http://[fd12:3456:789a::1]/'), /Prohibited IP/);

  // IPv6 link-local (fe80::/10)
  assert.throws(() => validateUrlForSsrf('http://[fe80::1]/'), /Prohibited IP/);

  // IPv4-mapped IPv6
  assert.throws(() => validateUrlForSsrf('http://[::ffff:127.0.0.1]/'), /Prohibited IP/);
  assert.throws(() => validateUrlForSsrf('http://[::ffff:192.168.0.1]/'), /Prohibited IP/);

  // Documentation / Carrier / Reserved
  assert.throws(() => validateUrlForSsrf('http://100.64.0.1/'), /Prohibited IP/);
  assert.throws(() => validateUrlForSsrf('http://192.0.2.1/'), /Prohibited IP/);
});

test('resolveAndValidateUrlForSsrf verifies resolved DNS addresses', async () => {
  // Mock DNS resolving to internal loopback
  const mockDnsLoopback = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => resolveAndValidateUrlForSsrf('http://attacker-controlled.com/evil', { dnsLookup: mockDnsLoopback }),
    /resolved to prohibited IP address 127\.0\.0\.1/
  );

  // Mock DNS resolving to public IP
  const mockDnsPublic = async () => [{ address: '93.184.216.34', family: 4 }];
  const res = await resolveAndValidateUrlForSsrf('http://example.com/item', { dnsLookup: mockDnsPublic });
  assert.equal(res.valid, true);
  assert.deepEqual(res.resolvedIps, ['93.184.216.34']);
});

test('safeFetchPromoPage crawls with size limits, timeout, and redirect re-checks', async () => {
  // Test redirect to internal loopback is caught
  const mockFetchRedirect = async (url) => {
    if (url === 'https://good-domain.com/landing') {
      return {
        status: 302,
        headers: { get: (h) => (h.toLowerCase() === 'location' ? 'http://127.0.0.1:8080/internal' : null) },
      };
    }
    return { ok: true, text: async () => '<html></html>' };
  };

  const mockDns = async (host) => {
    if (host === 'good-domain.com') return [{ address: '93.184.216.34', family: 4 }];
    return [{ address: '127.0.0.1', family: 4 }];
  };

  await assert.rejects(
    () => safeFetchPromoPage('https://good-domain.com/landing', { fetchImpl: mockFetchRedirect, dnsLookup: mockDns }),
    /Loopback address|Prohibited IP/
  );

  // Test size limit cap
  const mockFetchBig = async () => ({
    ok: true,
    status: 200,
    text: async () => 'x'.repeat(2048),
  });
  await assert.rejects(
    () => safeFetchPromoPage('https://good-domain.com/big', {
      maxSizeBytes: 1024,
      fetchImpl: mockFetchBig,
      dnsLookup: mockDns,
    }),
    /exceeded size limit/
  );

  // Test successful crawl and safe parsing
  const mockFetchSuccess = async () => ({
    ok: true,
    status: 200,
    text: async () => `
      <!DOCTYPE html>
      <html>
        <head><title>Super Software - Automated AI Tools</title><meta name="description" content="Save 10 hours weekly."></head>
        <body>
          <h1>Super Software V2</h1>
          <div>Cena: 199 zł / miesięcznie</div>
          <ul>
            <li>Automatyczny montaż wideo bez limitów</li>
            <li>Ponad 1000 gotowych szablonów hooków</li>
            <li>Wbudowany edytor napisów i obcinacz ciszy</li>
          </ul>
        </body>
      </html>
    `,
  });

  const parsed = await safeFetchPromoPage('https://good-domain.com/product', {
    fetchImpl: mockFetchSuccess,
    dnsLookup: mockDns,
  });

  assert.equal(parsed.title, 'Super Software - Automated AI Tools');
  assert.equal(parsed.description, 'Save 10 hours weekly.');
  assert.equal(parsed.h1, 'Super Software V2');
  assert.ok(parsed.price.includes('199 zł'));
  assert.equal(parsed.features.length, 3);
  assert.equal(parsed.isUntrustedData, true);
});

test('createResponsivePromoEdg builds valid EDG timelines for all 3 responsive layouts', () => {
  const script = {
    hook: 'Nie trać czasu na ręczny montaż!',
    cta: 'Kliknij i wypróbuj bezpłatnie.',
  };

  for (const layoutKey of ['VERTICAL_9_16', 'SQUARE_1_1', 'LANDSCAPE_16_9']) {
    const edg = createResponsivePromoEdg(script, layoutKey, { durationSec: 10, fps: 30 });
    assert.ok(edg);
    assert.equal(edg.totalTimelineFrames, 300);
    assert.ok(edg.canvas.width > 0);
    assert.ok(edg.canvas.height > 0);

    const headlineTrack = edg.tracks.find(t => t.id === 'captions-headline');
    const benefitsTrack = edg.tracks.find(t => t.id === 'captions-benefits');
    assert.equal(headlineTrack.clips[0].text, 'Nie trać czasu na ręczny montaż!');
    assert.equal(benefitsTrack.clips[0].text, 'Kliknij i wypróbuj bezpłatnie.');
  }
});

test('RendererAdapter renders real Promo MP4 exports in all 3 responsive formats', async () => {
  let ffmpegPath;
  try {
    ffmpegPath = resolveFfmpegBinary();
  } catch {
    // If ffmpeg binary is not available, skip live render
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidmyo_promo_render_test_'));
  const adapter = new RendererAdapter({ ffmpegPath });

  const script = {
    hook: 'Oszczędź 10 godzin tygodniowo!',
    cta: 'Sprawdź Vidmyo Studio już teraz!',
  };

  const expectedDimensions = {
    VERTICAL_9_16: { width: 1080, height: 1920 },
    SQUARE_1_1: { width: 1080, height: 1080 },
    LANDSCAPE_16_9: { width: 1920, height: 1080 },
  };

  for (const layoutKey of ['VERTICAL_9_16', 'SQUARE_1_1', 'LANDSCAPE_16_9']) {
    // Render short 1-second clip (30 frames) for speed
    const edg = createResponsivePromoEdg(script, layoutKey, { durationSec: 1, fps: 30 });
    const exportFile = path.join(tmpDir, `promo_${layoutKey}.mp4`);

    const result = await adapter.renderExport(edg, exportFile, {
      renderer: 'ffmpeg',
      execute: true,
      isPreview: false,
    });

    assert.equal(result.status, 'done');
    assert.ok(fs.existsSync(exportFile));
    assert.ok(fs.statSync(exportFile).size > 1000);

    const probe = adapter.probeMedia(exportFile);
    assert.ok(probe.streams && probe.streams.length >= 1);
    const videoStream = probe.streams.find(s => s.codec_type === 'video');
    assert.ok(videoStream, `No video stream found for ${layoutKey}`);
    assert.equal(videoStream.width, expectedDimensions[layoutKey].width);
    assert.equal(videoStream.height, expectedDimensions[layoutKey].height);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

