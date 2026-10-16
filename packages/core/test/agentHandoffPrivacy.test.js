import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sessionBrief, kickoff } = require('../../../electron/lib/agentHandoff.js');
const { getAgentPipeline } = require('../../../electron/lib/agentPipelines.js');

test('agent handoff contains task context without private recipes or credentials', () => {
  const manifest = { brief: { topic: 'Cities', hook: 'A river', token: 'PRIVATE_TOKEN', sourceSheet: { id: 'PRIVATE_SHEET' } }, script: 'Hello', scenes: [{ image: { approved: true }, prompt: 'PRIVATE_TEMPLATE' }], renders: [], voiceover: {} };
  const result = sessionBrief({ dir: '/project', manifest });
  assert.match(result.text, /Cities/);
  assert.match(result.text, /vidmyo.*MCP/);
  assert.doesNotMatch(result.text, /PRIVATE_|tts_kokoro|detect_beats|Faceless YT/);
  assert.doesNotMatch(kickoff({ dir: '/project', topic: 'Cities', briefFile: '/project/brief.md', autonomous: true }), /pipeline-codex|\.venv|finalize_video/);
  assert.equal(getAgentPipeline('codex', { agentPipelines: { codex: { dir: '/PRIVATE_RECIPE' } } }).dir, undefined);
});
