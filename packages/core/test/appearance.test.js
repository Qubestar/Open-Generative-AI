import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APPEARANCES, APPEARANCE_KEY, normalizeAppearance, readAppearance, saveAppearance } from '../../studio/src/appearance.mjs';
test('appearance accepts only implemented designs and defaults to Studio', () => {
  assert.equal(normalizeAppearance('light'), 'light');
  assert.equal(normalizeAppearance('aurora'), 'aurora');
  assert.deepEqual(APPEARANCES.map(item => item.label), ['Filmcraft Noir', 'Arctic Editorial', 'Graphite Aurora']);
  for (const value of [null, undefined, '', 'system', 'unexpected']) assert.equal(normalizeAppearance(value), 'dark');
});
test('appearance survives reopening without storing project data', () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k, v) => values.set(k, v) };
  assert.equal(saveAppearance(storage, 'light'), 'light');
  assert.equal(readAppearance(storage), 'light');
  assert.deepEqual([...values.keys()], [APPEARANCE_KEY]);
});
test('unavailable storage does not prevent changing appearance', () => {
  const storage = { getItem() { throw Error('blocked'); }, setItem() { throw Error('full'); } };
  assert.equal(readAppearance(storage), 'dark');
  assert.equal(saveAppearance(storage, 'light'), 'light');
});
test('all approved themes retain readable text and primary-action contrast', () => {
  const css = fs.readFileSync(new URL('../../studio/src/appearance.css', import.meta.url), 'utf8');
  const luminance = hex => {
    const [r,g,b] = hex.match(/.{2}/g).map(value => parseInt(value,16)/255)
      .map(value => value <= .04045 ? value/12.92 : ((value+.055)/1.055)**2.4);
    return .2126*r+.7152*g+.0722*b;
  };
  const contrast = (a,b) => {
    const values = [luminance(a),luminance(b)].sort((a,b)=>b-a);
    return (values[0]+.05)/(values[1]+.05);
  };
  for (const theme of APPEARANCES) {
    const block = css.match(new RegExp(`\\[data-appearance="${theme.id}"\\]\\s*\\{([^}]+)`))[1];
    const tokens = Object.fromEntries([...block.matchAll(/--vm-([\w-]+): #([\da-f]{6})/g)].map(match=>[match[1],match[2]]));
    for (const token of ['text','muted']) assert.ok(contrast(tokens[token],tokens.panel)>=4.5, `${theme.label} ${token}`);
    assert.ok(contrast(tokens['on-primary'],tokens.primary)>=4.5, `${theme.label} primary action`);
    assert.ok(contrast(tokens['on-good'],tokens.good)>=4.5, `${theme.label} approval action`);
    assert.ok(contrast(tokens['on-danger'],tokens.danger)>=4.5, `${theme.label} rejection action`);
  }
});
test('Clipper side panels use theme surfaces rather than inherited dark backgrounds', () => {
  const css = fs.readFileSync(new URL('../../studio/src/tailwind.css', import.meta.url), 'utf8');
  for (const selector of ['rep-review-list','rep-delivery']) {
    assert.match(css.match(new RegExp(`^\\.${selector} \\{([^}]+)`, 'm'))[1], /background: var\(--rep-panel\)/);
  }
});
