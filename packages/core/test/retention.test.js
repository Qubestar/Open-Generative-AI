import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreRainyHook,
  HookRotationRegistry,
  generateRetentionEvents,
  createHooksDownloadManifest,
} from '../src/retention.js';

test('scoreRainyHook scores opening hook and provides actionable suggestions', () => {
  const weakHook = scoreRainyHook('Video about marketing');
  assert.ok(weakHook.totalScore < 60);
  assert.equal(weakHook.isStrong, false);
  assert.ok(weakHook.feedback.length > 0);

  const strongHook = scoreRainyHook('Stop wasting your money on ads! In this video, discover the secret mistake you make.');
  assert.ok(strongHook.totalScore >= 75);
  assert.equal(strongHook.isStrong, true);
});

test('HookRotationRegistry enforces 30-day anti-fatigue window', () => {
  const registry = new HookRotationRegistry({ rotationDays: 30 });
  const channel = 'channel_alpha';
  const clip = 'hook_flame_zoom';

  // Initially available
  assert.ok(registry.isClipAvailable(channel, clip).available);

  // Record usage on day 0
  const day0 = new Date('2026-08-01T12:00:00Z');
  registry.recordUsage(channel, clip, day0.toISOString());

  // Check on day 15 (should be unavailable)
  const day15 = new Date('2026-08-16T12:00:00Z');
  const check15 = registry.isClipAvailable(channel, clip, day15);
  assert.equal(check15.available, false);
  assert.equal(check15.daysRemaining, 15);

  // Check on day 31 (window expired, available again)
  const day31 = new Date('2026-09-02T12:00:00Z');
  const check31 = registry.isClipAvailable(channel, clip, day31);
  assert.equal(check31.available, true);
});

test('generateRetentionEvents injects dual-hook, midpoint twist, and retention loops', () => {
  const events = generateRetentionEvents(120); // 2 minute video
  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'dual_hook');
  assert.equal(events[1].type, 'midpoint_twist');
  assert.equal(events[2].type, 'retention_loop_payoff');
});

test('createHooksDownloadManifest provides modular pack metadata', () => {
  const manifest = createHooksDownloadManifest([
    { id: 'h1', title: 'Speed Zoom' },
    { id: 'h2', title: 'Crash Glitch' },
  ]);
  assert.equal(manifest.totalClips, 2);
  assert.equal(manifest.items[0].id, 'h1');
  assert.ok(manifest.downloadBaseUrl);
});
