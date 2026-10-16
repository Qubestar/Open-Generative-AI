// Non-destructive NLE Export Engine for Vidmyo V2.6
// Generates Apple Final Cut Pro / DaVinci Resolve (.fcpxml)
// and Adobe Premiere Pro XML (.xml) interchange formats.

import { rationalToNumber, frameToSeconds } from './timebase.js';

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates Final Cut Pro X / DaVinci Resolve FCPXML (v1.9)
 */
export function exportToFcpxml(edg, { projectName = 'Vidmyo Edit' } = {}) {
  const fps = rationalToNumber(edg.timebase.fps);
  const frameRateFraction = `${edg.timebase.fps.num}/${edg.timebase.fps.den}s`;
  const totalFrames = edg.totalTimelineFrames || 0;
  const totalDurationSec = frameToSeconds(totalFrames, edg.timebase.fps);

  const assetEntries = Object.entries(edg.assets || {});
  const assetXmlList = assetEntries.map(([id, a], idx) => {
    return `    <asset id="r${idx + 1}" name="${escapeXml(id)}" src="file://${escapeXml(a.path)}" />`;
  }).join('\n');

  const videoTrack = edg.tracks.find(t => t.type === 'video');
  const clips = videoTrack?.clips || [];

  const spineClipsXml = clips.map((clip, idx) => {
    const assetIdx = assetEntries.findIndex(([id]) => id === clip.assetId);
    const ref = assetIdx >= 0 ? `r${assetIdx + 1}` : 'r1';
    const durSec = frameToSeconds(clip.timelineEndFrame - clip.timelineStartFrame, edg.timebase.fps);
    const startSec = frameToSeconds(clip.sourceStartFrame || 0, edg.timebase.fps);
    const offsetSec = frameToSeconds(clip.timelineStartFrame, edg.timebase.fps);

    return `          <asset-clip name="${escapeXml(clip.id)}" ref="${ref}" offset="${offsetSec.toFixed(3)}s" duration="${durSec.toFixed(3)}s" start="${startSec.toFixed(3)}s" />`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.9">
  <resources>
    <format id="r0" name="FFVideoFormatRateUndefined" frameDuration="${frameRateFraction}" width="${edg.canvas.width}" height="${edg.canvas.height}" />
${assetXmlList}
  </resources>
  <library>
    <event name="Vidmyo Export">
      <project name="${escapeXml(projectName)}">
        <sequence format="r0" duration="${totalDurationSec.toFixed(3)}s">
          <spine>
${spineClipsXml}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

/**
 * Generates Adobe Premiere Pro XML (Final Cut Pro 7 XML Interchange format)
 */
export function exportToPremiereXml(edg, { sequenceName = 'Vidmyo Sequence' } = {}) {
  const fps = Math.round(rationalToNumber(edg.timebase.fps));
  const videoTrack = edg.tracks.find(t => t.type === 'video');
  const clips = videoTrack?.clips || [];

  const trackClipsXml = clips.map((clip, idx) => {
    const asset = edg.assets[clip.assetId];
    const inPoint = clip.sourceStartFrame || 0;
    const outPoint = clip.sourceEndFrame || (clip.timelineEndFrame - clip.timelineStartFrame);

    return `          <clipitem id="clipitem-${idx + 1}">
            <name>${escapeXml(clip.id)}</name>
            <duration>${clip.timelineEndFrame - clip.timelineStartFrame}</duration>
            <rate>
              <timebase>${fps}</timebase>
              <ntsc>FALSE</ntsc>
            </rate>
            <start>${clip.timelineStartFrame}</start>
            <end>${clip.timelineEndFrame}</end>
            <in>${inPoint}</in>
            <out>${outPoint}</out>
            <file id="file-${idx + 1}">
              <name>${escapeXml(clip.assetId || 'media')}</name>
              <pathurl>file://${escapeXml(asset?.path || '')}</pathurl>
              <rate>
                <timebase>${fps}</timebase>
                <ntsc>FALSE</ntsc>
              </rate>
            </file>
          </clipitem>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
  <sequence>
    <name>${escapeXml(sequenceName)}</name>
    <rate>
      <timebase>${fps}</timebase>
      <ntsc>FALSE</ntsc>
    </rate>
    <media>
      <video>
        <format>
          <samplecharacteristics>
            <width>${edg.canvas.width}</width>
            <height>${edg.canvas.height}</height>
          </samplecharacteristics>
        </format>
        <track>
${trackClipsXml}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>
`;
}
