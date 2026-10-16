import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  ChannelPlannerValidationError,
  planChannelIdeas,
  validateChannelPlan,
  validateChannelPlannerRequest,
} from '../index.js';

const require = createRequire(import.meta.url);
const { createChannelPlanner } = require('../../../electron/lib/channelPlanner.js');

function request(count = 10) {
  return {
    count,
    strategy: {
      language: 'English',
      audience: 'Curious adults who enjoy clear explanations',
      positioning: 'Practical science stories without jargon',
      pillars: ['Everyday science', 'Space mysteries', 'Human behaviour'],
      cadence: 'Weekly',
      subjectsToAvoid: ['Medical advice'],
    },
    defaults: { kind: 'story', style: 'doodle-v1' },
    referenceChannels: [{
      name: 'Public reference',
      recurringTopics: ['Explainers'],
      titlePatterns: ['Question-led'],
      hookTypes: ['Counterintuitive fact'],
      formats: ['Long-form'],
      standoutTopics: ['Space'],
    }],
  };
}

function ideas(count = 10) {
  const pillars = ['Everyday science', 'Space mysteries', 'Human behaviour'];
  return Array.from({ length: count }, (_, index) => ({
    title: `Original idea ${index + 1}`,
    hook: `A useful hook ${index + 1}.`,
    angle: `A distinct angle ${index + 1} that teaches something useful.`,
    pillar: pillars[index % pillars.length],
    kind: index % 2 ? 'animation' : 'story',
    style: 'doodle-v1',
    priority: 100 - index,
  }));
}

test('planner accepts only the customer planning contract', () => {
  const normalized = validateChannelPlannerRequest(request());
  assert.equal(normalized.strategy.pillars.length, 3);
  assert.equal(normalized.referenceChannels[0].name, 'Public reference');

  const unsafe = request();
  unsafe.providerKey = 'PRIVATE_KEY';
  assert.throws(() => validateChannelPlannerRequest(unsafe), ChannelPlannerValidationError);

  const rawReference = request();
  rawReference.referenceChannels[0].rawApiPayload = { accessToken: 'PRIVATE_KEY' };
  assert.throws(() => validateChannelPlannerRequest(rawReference), /not allowed/);
});

test('planner produces a deterministic, pillar-balanced local fallback', async () => {
  const one = await planChannelIdeas(request());
  const two = await planChannelIdeas(request());
  assert.deepEqual(one, two);
  assert.equal(one.source, 'fallback');
  assert.deepEqual(one.warnings, ['director_not_configured']);
  assert.equal(one.ideas.length, 10);
  assert.deepEqual(new Set(one.ideas.map(idea => idea.pillar)), new Set(request().strategy.pillars));
  assert.equal(one.ideas[0].kind, 'story');
  assert.equal(one.ideas[0].style, 'doodle-v1');
  assert.equal(one.ideas[0].priority, 100);
});

test('planner validates agent JSON, preserves diversity, and keeps prompts out of results', async () => {
  let directorInput;
  const result = await planChannelIdeas(request(), {
    director: async input => {
      directorInput = input;
      return JSON.stringify({ ideas: ideas() });
    },
  });
  assert.equal(result.source, 'director');
  assert.deepEqual(result.warnings, []);
  assert.equal(result.ideas.length, 10);
  assert.match(directorInput.prompt, /Customer brief/);
  assert.match(directorInput.prompt, /Practical science stories without jargon/);
  assert.doesNotMatch(directorInput.prompt, /pipeline-codex|PRIVATE_KEY|FAL_KEY|AGNES_API_KEY/i);
  assert.doesNotMatch(JSON.stringify(result), /Customer brief|pipeline-codex|PRIVATE_KEY/i);
  assert.deepEqual(Object.keys(result.ideas[0]).sort(), ['angle', 'hook', 'kind', 'pillar', 'priority', 'style', 'title']);
});

test('malformed, duplicate, or one-pillar director results fail closed to the deterministic slate', async () => {
  const duplicate = ideas();
  duplicate[1] = { ...duplicate[0], hook: 'A different hook cannot make the title new.' };
  assert.throws(() => validateChannelPlan({ ideas: duplicate }, request()), /duplicate/);

  const onePillar = ideas().map(idea => ({ ...idea, pillar: 'Everyday science' }));
  assert.throws(() => validateChannelPlan({ ideas: onePillar }, request()), /cover at least/);

  const result = await planChannelIdeas(request(), {
    director: async () => '```json\n{"ideas": []}\n``` PRIVATE_DIRECTOR_ERROR',
  });
  assert.equal(result.source, 'fallback');
  assert.deepEqual(result.warnings, ['director_unavailable_or_invalid']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DIRECTOR_ERROR/);
});

test('Electron adapter uses an injected structured local-agent director when available', async () => {
  let call;
  const planner = createChannelPlanner({
    agents: {
      runStructured: async payload => {
        call = payload;
        return { ideas: ideas() };
      },
    },
    agentPipelines: {
      getAgentPipeline: agentId => agentId === 'codex' ? { label: 'Codex', available: true } : null,
    },
  });
  const result = await planner.plan(request(), { agentId: 'codex' });
  assert.equal(result.source, 'director');
  assert.equal(call.agentId, 'codex');
  assert.deepEqual(call.pipeline, { label: 'Codex', available: true });
  assert.match(call.prompt, /Customer brief/);
  assert.doesNotMatch(JSON.stringify(result), /Customer brief/);
});
