import test from 'node:test';
import assert from 'node:assert/strict';
import { publicMcpError } from '../lib/tools.js';

test('public errors preserve actionable categories without raw secrets or commands', () => {
  for (const message of ['Command failed: /private/pipeline.py --token PRIVATE_TOKEN', 'missing /private/recipe.py', 'access_token=PRIVATE_TOKEN']) {
    assert.doesNotMatch(publicMcpError(new Error(message)), /PRIVATE_TOKEN|\/private/);
  }
  assert.match(publicMcpError(new Error('Paid generation was not approved.')), /not approved/);
});
