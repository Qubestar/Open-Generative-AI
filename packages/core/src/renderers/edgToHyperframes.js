// EDG → HyperFrames HTML composition converter (Vidmyo V2.6, Phase 3 item 4).
//
// Turns a validated Editing Decision Graph into a real HyperFrames project
// (index.html + assets/ + hyperframes.json + meta.json) that the pinned
// `hyperframes` CLI renders to an MP4. FFmpeg stays the default renderer;
// this path is opt-in.
//
// Rules honoured here:
//   * timing comes from ABSOLUTE frame boundaries via timebase.js — never from
//     summed, individually-rounded durations, so long timelines do not drift;
//   * media is copied into assets/ keyed by its EDG hash;
//   * every text node and attribute is HTML-escaped (captions and promo copy
//     are data, not markup);
//   * anything not explicitly supported lands in `unsupported[]` — strict mode
//     throws EDG_UNSUPPORTED with the list, permissive mode returns it. Nothing
//     is ever dropped silently.

import fs from 'node:fs';
import path from 'node:path';

import { validateEdg } from '../edg.js';
import { frameToSeconds, parseFps } from '../timebase.js';

export const EDG_UNSUPPORTED = 'EDG_UNSUPPORTED';

export class EdgUnsupportedError extends Error {
  constructor(unsupported = [], edgId = null) {
    const features = [...new Set(unsupported.map((u) => u.feature))];
    super(
      `EDG ${edgId || ''} contains ${unsupported.length} feature(s) the HyperFrames converter does not support: `
      + `${features.join(', ')}. Use renderer 'ffmpeg' for this timeline, or remove the listed features.`,
    );
    this.name = 'EdgUnsupportedError';
    this.code = EDG_UNSUPPORTED;
    this.unsupported = unsupported;
    this.edgId = edgId;
  }
}

// `cut` renders as no-op (adjacent clips), fade-like transitions map to an
// opacity crossfade. Everything else in TRANSITION_TYPES (dissolve, wipes,
// dip_to_black) needs a filter effect HyperFrames does not provide here.
const SUPPORTED_TRANSITIONS = new Set(['cut', 'fade', 'crossfade']);

// Element id assigned to each clip during the walk, so transition handling can
// find the DOM node that belongs to a given clip.
const elementIdByClip = new WeakMap();
function elementIdFor(clip) {
  return elementIdByClip.get(clip) || null;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n)) return '0';
  return String(Number(n.toFixed(9)));
}

function safeExtension(assetPath = '', assetType = '') {
  const ext = path.extname(String(assetPath || '')).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ext && ext.length <= 5) return `.${ext}`;
  if (assetType === 'video') return '.mp4';
  if (assetType === 'audio') return '.wav';
  if (assetType === 'image') return '.png';
  return '.bin';
}

function htmlForScript(value) {
  // Prevent `</script>` (or any `<`) from terminating the inline script.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Convert a validated EDG into a HyperFrames composition project.
 *
 * @param {object} edg validated Editing Decision Graph
 * @param {object} opts
 * @param {string} opts.projectDir directory to create (index.html + assets/)
 * @param {string} [opts.aspect] optional check — must match edg.canvas.aspect
 * @param {boolean} [opts.strict=true] throw EdgUnsupportedError instead of
 *        returning the `unsupported` list
 * @param {boolean} [opts.copyAssets=true] copy referenced media by hash
 * @returns {{
 *   projectDir: string, indexPath: string, html: string,
 *   width: number, height: number, fps: number,
 *   totalFrames: number, durationSec: number,
 *   elementCount: number, assets: Array, unsupported: Array, notes: Array
 * }}
 */
export function convertEdgToComposition(edg, {
  projectDir,
  aspect = null,
  strict = true,
  copyAssets = true,
} = {}) {
  if (!projectDir) throw new Error('convertEdgToComposition requires a projectDir');
  validateEdg(edg);

  const canvasAspect = edg.canvas.aspect;
  if (aspect && aspect !== canvasAspect) {
    throw new Error(`Requested aspect ${aspect} does not match EDG canvas aspect ${canvasAspect}`);
  }

  const fpsValue = parseFps(edg.timebase.fps);
  const width = edg.canvas.width;
  const height = edg.canvas.height;

  const unsupported = [];
  const notes = [
    'video clips render muted; audio comes from audio-track clips, mirroring the FFmpeg renderer which maps only audio-track inputs',
  ];
  const elements = [];
  const mediaShim = [];
  const captionShim = [];

  // Absolute frame boundaries — never a running sum of rounded durations.
  let maxEndFrame = 0;
  for (const track of (edg.tracks || [])) {
    for (const clip of (track.clips || [])) {
      if (Number.isFinite(clip.timelineEndFrame)) maxEndFrame = Math.max(maxEndFrame, clip.timelineEndFrame);
    }
  }
  const totalFrames = Number.isFinite(edg.totalTimelineFrames) && edg.totalTimelineFrames > 0
    ? edg.totalTimelineFrames
    : maxEndFrame;
  const durationSec = frameToSeconds(totalFrames, fpsValue);

  fs.mkdirSync(path.join(projectDir, 'assets'), { recursive: true });

  const copiedAssets = new Map(); // assetId -> assets-relative path
  const copyAsset = (asset) => {
    if (copiedAssets.has(asset.id)) return copiedAssets.get(asset.id);
    if (!fs.existsSync(asset.path)) return null;
    const name = `${String(asset.hash).slice(0, 16)}${safeExtension(asset.path, asset.type)}`;
    if (!copyAssets) {
      copiedAssets.set(asset.id, asset.path);
      return asset.path;
    }
    const dest = path.join(projectDir, 'assets', name);
    if (!fs.existsSync(dest)) fs.copyFileSync(asset.path, dest);
    const rel = `assets/${name}`;
    copiedAssets.set(asset.id, rel);
    return rel;
  };

  let elementSeq = 0;
  let trackIndex = 0;

  const resolveClipWindow = (clip) => {
    const startSec = frameToSeconds(clip.timelineStartFrame || 0, fpsValue);
    const endSec = frameToSeconds(clip.timelineEndFrame || clip.timelineStartFrame || 0, fpsValue);
    return { startSec, endSec: Math.max(startSec, endSec) };
  };

  for (const track of (edg.tracks || [])) {
    const currentTrackIndex = trackIndex++;
    const trackType = track.type;

    if (!['video', 'overlay', 'audio', 'caption'].includes(trackType)) {
      unsupported.push({ feature: `track-type:${trackType}`, trackId: track.id });
      continue;
    }

    for (const clip of (track.clips || [])) {
      const { startSec, endSec } = resolveClipWindow(clip);
      const duration = Math.max(0, endSec - startSec);
      const id = `el_${elementSeq++}`;
      elementIdByClip.set(clip, id);

      if (trackType === 'caption') {
        if (!clip.text) {
          unsupported.push({ feature: 'caption-without-text', trackId: track.id, clipId: clip.id });
          continue;
        }
        const transform = clip.transform || {};
        if (transform.zoom != null || transform.rotate != null) {
          unsupported.push({ feature: 'caption-transform', trackId: track.id, clipId: clip.id, detail: JSON.stringify(transform) });
        }
        const centeredX = transform.x == null || Number(transform.x) === width / 2;
        if (!centeredX) {
          unsupported.push({ feature: 'caption-transform-x', trackId: track.id, clipId: clip.id, detail: `x=${transform.x}` });
        }
        const topStyle = Number.isFinite(Number(transform.y))
          ? `top:${Math.round(Number(transform.y))}px;`
          : 'bottom:100px;';
        elements.push(
          `<div id="${id}" class="caption clip" data-start="${fmtSeconds(startSec)}" data-duration="${fmtSeconds(duration)}" `
          + `data-track-index="${currentTrackIndex}" style="z-index:${100 + currentTrackIndex};${topStyle}">${escapeHtml(clip.text)}</div>`,
        );
        captionShim.push({ id, start: startSec, end: endSec });
        continue;
      }

      if (trackType === 'audio') {
        const asset = edg.assets[clip.assetId];
        if (!asset || !clip.assetId) {
          unsupported.push({ feature: 'audio-clip-without-asset', trackId: track.id, clipId: clip.id });
          continue;
        }
        if (asset.type !== 'audio') {
          unsupported.push({ feature: `audio-asset-type:${asset.type}`, trackId: track.id, clipId: clip.id, detail: 'audio clips must reference an audio asset' });
          continue;
        }
        const rel = copyAsset(asset);
        if (!rel) {
          unsupported.push({ feature: 'asset-file-missing', trackId: track.id, clipId: clip.id, detail: asset.path });
          continue;
        }
        const volume = Number.isFinite(Number(clip.volume)) ? Math.max(0, Math.min(3.98, Number(clip.volume))) : 1;
        elements.push(
          `<audio id="${id}" class="clip" src="${escapeHtml(rel)}" data-start="${fmtSeconds(startSec)}" `
          + `data-duration="${fmtSeconds(duration)}" data-volume="${fmtSeconds(volume)}" data-track-index="${currentTrackIndex}"></audio>`,
        );
        if (clip.gainDb != null) {
          unsupported.push({ feature: 'audio-gain-db', trackId: track.id, clipId: clip.id, detail: `gainDb=${clip.gainDb}` });
        }
        continue;
      }

      // video + overlay tracks both carry visual media
      const asset = edg.assets[clip.assetId];
      if (!clip.assetId || !asset) {
        unsupported.push({
          feature: clip.type ? `overlay-effect:${clip.type}` : 'media-clip-without-asset',
          trackId: track.id,
          clipId: clip.id,
          detail: 'no asset reference — the effect is not representable in this HTML composition',
        });
        continue;
      }
      if (!['image', 'video'].includes(asset.type)) {
        unsupported.push({ feature: `asset-type:${asset.type}`, trackId: track.id, clipId: clip.id });
        continue;
      }
      const rel = copyAsset(asset);
      if (!rel) {
        unsupported.push({ feature: 'asset-file-missing', trackId: track.id, clipId: clip.id, detail: asset.path });
        continue;
      }

      const transform = clip.transform || {};
      const unsupportedTransformKeys = Object.keys(transform).filter((k) => !['zoom'].includes(k));
      if (unsupportedTransformKeys.length) {
        unsupported.push({
          feature: `transform:${unsupportedTransformKeys.sort().join(',')}`,
          trackId: track.id,
          clipId: clip.id,
        });
      }
      const zoom = Number.isFinite(Number(transform.zoom)) && Number(transform.zoom) > 0
        ? Number(transform.zoom)
        : null;

      const mediaStart = Number.isFinite(clip.sourceStartFrame)
        ? frameToSeconds(clip.sourceStartFrame, fpsValue)
        : 0;

      const attrs = [
        'class="hf-media clip"',
        `data-start="${fmtSeconds(startSec)}"`,
        `data-duration="${fmtSeconds(duration)}"`,
        `data-track-index="${currentTrackIndex}"`,
        `style="z-index:${currentTrackIndex + 1};"`,
      ];
      let markup;
      if (asset.type === 'image') {
        markup = `<img id="${id}" ${attrs.join(' ')} src="${escapeHtml(rel)}" alt="" />`;
      } else {
        attrs.push(`data-media-start="${fmtSeconds(mediaStart)}"`);
        // Video is muted on purpose: the FFmpeg reference renderer maps only
        // audio-TRACK inputs, so audio must come from the audio clips above —
        // otherwise the two pipelines would differ in the mux.
        attrs.push('data-has-audio="false"');
        markup = `<video id="${id}" ${attrs.join(' ')} src="${escapeHtml(rel)}" muted playsinline></video>`;
      }
      elements.push(markup);
      mediaShim.push({ id, start: startSec, end: endSec, zoom, fadeIn: 0 });
    }
  }

  // Transitions → opacity crossfade on the incoming clip.
  const clipIndex = new Map();
  for (const track of (edg.tracks || [])) {
    const ordered = [...(track.clips || [])].sort((a, b) => (a.timelineStartFrame || 0) - (b.timelineStartFrame || 0));
    ordered.forEach((clip, i) => clipIndex.set(clip.id, { clip, track, ordered, position: i }));
  }
  for (const transition of (edg.transitions || [])) {
    const type = String(transition.type || 'cut');
    if (!SUPPORTED_TRANSITIONS.has(type)) {
      unsupported.push({ feature: `transition:${type}`, clipId: transition.afterClipId || null });
      continue;
    }
    if (type === 'cut') continue;

    const found = clipIndex.get(transition.afterClipId);
    if (!found) {
      unsupported.push({ feature: 'transition-target-missing', clipId: transition.afterClipId || null });
      continue;
    }
    const next = found.ordered[found.position + 1];
    if (!next) {
      unsupported.push({ feature: 'transition-without-following-clip', clipId: transition.afterClipId });
      continue;
    }
    const target = mediaShim.find((m) => m.id === elementIdFor(next.clip));
    if (!target) {
      unsupported.push({ feature: 'transition-target-not-media', clipId: next.id });
      continue;
    }
    const fadeFrames = Number.isFinite(Number(transition.durationFrames)) ? Number(transition.durationFrames) : 0;
    target.fadeIn = Math.max(target.fadeIn, frameToSeconds(fadeFrames, fpsValue));
  }

  const html = renderHtml({
    width,
    height,
    durationSec,
    elements,
    mediaShim,
    captionShim,
  });

  fs.writeFileSync(path.join(projectDir, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(projectDir, 'hyperframes.json'), `${JSON.stringify({
    $schema: 'https://hyperframes.heygen.com/schema/hyperframes.json',
    paths: { blocks: 'compositions', components: 'compositions/components', assets: 'assets' },
    media: { autoProxy: false },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(projectDir, 'meta.json'), `${JSON.stringify({
    id: `vidmyo-edg-${String(edg.id).replace(/[^a-zA-Z0-9_-]/g, '')}`,
    name: edg.title || 'Vidmyo EDG composition',
  }, null, 2)}\n`, 'utf8');

  const result = {
    projectDir: path.resolve(projectDir),
    indexPath: path.join(path.resolve(projectDir), 'index.html'),
    html,
    width,
    height,
    fps: fpsValue,
    totalFrames,
    durationSec,
    elementCount: elements.length,
    assets: [...copiedAssets.entries()].map(([assetId, rel]) => ({ assetId, rel })),
    unsupported,
    notes,
    captionCount: captionShim.length,
    mediaCount: mediaShim.length,
  };

  if (strict && unsupported.length > 0) {
    throw new EdgUnsupportedError(unsupported, edg.id);
  }
  return result;
}

function renderHtml({ width, height, durationSec, elements, mediaShim, captionShim }) {
  const shimData = {
    media: mediaShim.map((m) => ({ id: m.id, start: m.start, end: m.end, zoom: m.zoom, fadeIn: m.fadeIn })),
    captions: captionShim.map((c) => ({ id: c.id, start: c.start, end: c.end })),
  };
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Vidmyo EDG composition</title>
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; background: #000; }
      #root { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
      .hf-media { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
      .caption { position: absolute; left: 0; right: 0; text-align: center; color: #fff;
        font-family: Helvetica, Arial, sans-serif; font-size: 36px; font-weight: 400;
        line-height: 1.2; opacity: 0; text-shadow: 1px 1px 2px rgba(0,0,0,0.8); }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${fmtSeconds(durationSec)}" data-width="${width}" data-height="${height}">
${elements.map((el) => `      ${el}`).join('\n')}
    </div>
    <script>
      (function () {
        var DUR = ${fmtSeconds(durationSec)};
        var DATA = ${htmlForScript(shimData)};
        function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }
        function applyFrame(t) {
          var m = DATA.media, i, el, p;
          for (i = 0; i < m.length; i++) {
            el = document.getElementById(m[i].id);
            if (!el) continue;
            if (m[i].zoom && m[i].zoom > 1) {
              p = m[i].end > m[i].start ? clamp01((t - m[i].start) / (m[i].end - m[i].start)) : 0;
              el.style.transformOrigin = 'center';
              el.style.transform = 'scale(' + (1 + (m[i].zoom - 1) * p) + ')';
            }
            if (m[i].fadeIn > 0) {
              el.style.opacity = (t < m[i].start || t > m[i].end) ? '0' : String(clamp01((t - m[i].start) / m[i].fadeIn));
            }
          }
          var c = DATA.captions;
          for (i = 0; i < c.length; i++) {
            el = document.getElementById(c[i].id);
            if (!el) continue;
            el.style.opacity = (t >= c[i].start && t <= c[i].end) ? '1' : '0';
          }
        }
        var tl = {
          _t: 0,
          duration: function () { return DUR; },
          pause: function () { return this; },
          timeScale: function () { return 1; },
          seek: function (t) { this._t = Number(t) || 0; applyFrame(this._t); return this; },
          totalTime: function (t) {
            if (t === undefined) return this._t;
            this._t = Number(t) || 0; applyFrame(this._t); return this;
          },
          progress: function (p) {
            if (p === undefined) return DUR ? this._t / DUR : 0;
            this._t = (Number(p) || 0) * DUR; applyFrame(this._t); return this;
          }
        };
        window.__timelines = window.__timelines || {};
        window.__timelines['main'] = tl;
        applyFrame(0);
      })();
    </script>
  </body>
</html>
`;
}
