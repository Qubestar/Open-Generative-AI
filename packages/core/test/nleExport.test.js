import { test } from 'node:test';
import assert from 'node:assert/strict';
import { exportToFcpxml, exportToPremiereXml } from '../src/nleExport.js';
import { createEmptyEdg } from '../src/edg.js';

test('exportToFcpxml generates valid FCPXML 1.9 document', () => {
  const edg = createEmptyEdg({ title: 'Test FCPXML' });
  edg.assets['asset_1'] = { id: 'asset_1', path: '/media/camera.mp4', hash: '12345678', type: 'video' };
  edg.tracks[0].clips.push({
    id: 'clip_1',
    assetId: 'asset_1',
    timelineStartFrame: 0,
    timelineEndFrame: 90,
    sourceStartFrame: 0,
    sourceEndFrame: 90,
  });

  const xml = exportToFcpxml(edg);
  assert.match(xml, /<!DOCTYPE fcpxml>/);
  assert.match(xml, /<fcpxml version="1.9">/);
  assert.match(xml, /<asset id="r1" name="asset_1"/);
  assert.match(xml, /<asset-clip name="clip_1"/);
});

test('exportToPremiereXml generates valid Premiere / FCP7 XML document', () => {
  const edg = createEmptyEdg({ title: 'Test Premiere' });
  edg.assets['asset_1'] = { id: 'asset_1', path: '/media/camera.mp4', hash: '12345678', type: 'video' };
  edg.tracks[0].clips.push({
    id: 'clip_1',
    assetId: 'asset_1',
    timelineStartFrame: 0,
    timelineEndFrame: 90,
  });

  const xml = exportToPremiereXml(edg);
  assert.match(xml, /<!DOCTYPE xmeml>/);
  assert.match(xml, /<xmeml version="4">/);
  assert.match(xml, /<clipitem id="clipitem-1">/);
  assert.match(xml, /<pathurl>file:\/\/\/media\/camera.mp4<\/pathurl>/);
});
