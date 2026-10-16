// Channel Planner — validates a customer-owned strategy and turns it into a
// reviewable 10/20 idea slate. This module deliberately has no provider,
// filesystem, Electron, or logging dependency: callers supply a director when
// they have an approved local-agent integration, otherwise the stable fallback
// is used.

export const CHANNEL_PLANNER_COUNTS = Object.freeze([10, 20]);
export const CHANNEL_PLANNER_KINDS = Object.freeze(['story', 'animation']);

const MAX_STRING = 500;
const MAX_LONG_STRING = 2_000;
const MAX_PILLARS = 12;
const MAX_REFERENCES = 5;
const MAX_LIST_ITEMS = 20;
const IDEA_KEYS = Object.freeze(['title', 'hook', 'angle', 'pillar', 'kind', 'style', 'priority']);
const REQUEST_KEYS = Object.freeze(['count', 'strategy', 'defaults', 'referenceChannels']);
const STRATEGY_KEYS = Object.freeze(['language', 'audience', 'positioning', 'pillars', 'cadence', 'subjectsToAvoid']);
const DEFAULT_KEYS = Object.freeze(['kind', 'style']);
const REFERENCE_KEYS = Object.freeze([
  'name', 'recurringTopics', 'titlePatterns', 'hookTypes', 'formats', 'standoutTopics',
]);
const PLAN_KEYS = Object.freeze(['ideas']);

const FALLBACK_TEMPLATES = Object.freeze([
  ['Start Here: {pillar}', 'A useful first question can change how you see this topic.', 'A friendly introduction that gives the audience a practical frame.'],
  ['The {pillar} Question Most People Skip', 'The obvious question is rarely the one that unlocks the subject.', 'Use one overlooked question to make a familiar subject feel fresh.'],
  ['A Clear Guide to {pillar}', 'Here is the simple way to separate signal from noise.', 'Break a complicated subject into a small, useful sequence.'],
  ['What Changes When You Understand {pillar}', 'One idea connects the before and after.', 'Show the audience the practical consequence of a core insight.'],
  ['The Hidden Pattern in {pillar}', 'A repeating pattern makes the subject easier to remember.', 'Reveal a useful pattern with an original example.'],
  ['7 Things to Know About {pillar}', 'These are the details worth carrying forward.', 'A paced list that moves from fundamentals to a surprising takeaway.'],
  ['The {pillar} Myth Worth Rethinking', 'The popular shortcut misses an important part of the story.', 'Contrast a common assumption with a nuanced, evidence-led explanation.'],
  ['How to Make Sense of {pillar}', 'Start with the one distinction that makes the rest clearer.', 'Build confidence through a simple explanatory framework.'],
  ['Inside {pillar}: The Bigger Picture', 'A wider view reveals why this subject matters now.', 'Connect one focused topic to the channel promise and the audience goal.'],
  ['The Next Step for {pillar}', 'Once the basics are clear, this is the move that adds depth.', 'Create a natural follow-up that rewards returning viewers.'],
  ['Why {pillar} Still Surprises Experts', 'The interesting part is not the headline; it is what sits underneath it.', 'Use a counterintuitive detail to frame a deeper original lesson.'],
  ['A Better Way to Think About {pillar}', 'Changing the lens changes what becomes possible.', 'Offer a repeatable mental model that fits the channel positioning.'],
  ['The Essential {pillar} Timeline', 'The order of events explains more than isolated facts do.', 'Tell a chronological story that makes cause and effect easy to follow.'],
  ['{pillar} in One Useful Story', 'One concrete story can make an abstract idea stick.', 'Use a single scenario to explain the pillar without copying a reference.'],
  ['The Decision That Defines {pillar}', 'A key choice often reveals the real trade-off.', 'Explore the choices, constraints, and audience-relevant outcome.'],
  ['What Beginners Miss About {pillar}', 'The first mistake is understandable, and easy to avoid once you see it.', 'Teach a practical correction with a welcoming tone.'],
  ['The Case for Looking Closer at {pillar}', 'The detail people rush past is often the useful part.', 'Slow down around one overlooked element and explain its value.'],
  ['From Curiosity to Clarity: {pillar}', 'A good investigation starts broad and lands on one memorable truth.', 'Take the viewer from an intriguing question to a clear conclusion.'],
  ['The {pillar} Connection Nobody Explains', 'Two familiar ideas become more useful when viewed together.', 'Make an original connection between concepts inside the chosen pillar.'],
  ['A Fresh Challenge in {pillar}', 'The next question is more interesting than the old answer.', 'Invite the audience into a current, constructive debate without hype.'],
]);

export class ChannelPlannerValidationError extends Error {
  constructor(pathName, message) {
    super(`${pathName}: ${message}`);
    this.name = 'ChannelPlannerValidationError';
    this.path = pathName;
  }
}

function fail(pathName, message) {
  throw new ChannelPlannerValidationError(pathName, message);
}

function clone(value) {
  return structuredClone(value);
}

function object(value, pathName, allowedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(pathName, 'must be an object');
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) fail(`${pathName}.${key}`, 'is not allowed');
  }
  return value;
}

function text(value, pathName, { max = MAX_STRING, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(pathName, 'is required');
    return null;
  }
  if (typeof value !== 'string') fail(pathName, 'must be a string');
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (required && !normalized) fail(pathName, 'must not be empty');
  if (normalized.length > max) fail(pathName, `must be at most ${max} characters`);
  return normalized || null;
}

function textList(value, pathName, { required = false, maxItems = MAX_LIST_ITEMS, itemMax = MAX_STRING } = {}) {
  if (value === undefined || value === null) {
    if (required) fail(pathName, 'is required');
    return [];
  }
  if (!Array.isArray(value) || value.length > maxItems) fail(pathName, `must be an array with at most ${maxItems} items`);
  const values = value.map((item, index) => text(item, `${pathName}[${index}]`, { max: itemMax }));
  const seen = new Set();
  for (const item of values) {
    const key = item.toLocaleLowerCase();
    if (seen.has(key)) fail(pathName, 'must not contain duplicate values');
    seen.add(key);
  }
  return values;
}

function requiredKeys(value, pathName, keys) {
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${pathName}.${key}`, 'is required');
}

function normalizeReference(value, index) {
  const pathName = `referenceChannels[${index}]`;
  object(value, pathName, REFERENCE_KEYS);
  requiredKeys(value, pathName, ['name']);
  return {
    name: text(value.name, `${pathName}.name`),
    recurringTopics: textList(value.recurringTopics, `${pathName}.recurringTopics`),
    titlePatterns: textList(value.titlePatterns, `${pathName}.titlePatterns`),
    hookTypes: textList(value.hookTypes, `${pathName}.hookTypes`),
    formats: textList(value.formats, `${pathName}.formats`),
    standoutTopics: textList(value.standoutTopics, `${pathName}.standoutTopics`),
  };
}

/**
 * Normalize the only data allowed into a planning prompt: customer strategy
 * and pre-normalized, public reference-channel patterns. Raw API results,
 * credentials, system prompts, and renderer state have no field here.
 */
export function validateChannelPlannerRequest(value) {
  object(value, 'request', REQUEST_KEYS);
  requiredKeys(value, 'request', ['count', 'strategy']);
  if (!CHANNEL_PLANNER_COUNTS.includes(value.count)) fail('request.count', 'must be 10 or 20');

  const strategy = object(value.strategy, 'request.strategy', STRATEGY_KEYS);
  requiredKeys(strategy, 'request.strategy', ['language', 'audience', 'positioning', 'pillars']);
  const pillars = textList(strategy.pillars, 'request.strategy.pillars', { required: true, maxItems: MAX_PILLARS });
  if (!pillars.length) fail('request.strategy.pillars', 'must include at least one pillar');
  const normalizedStrategy = {
    language: text(strategy.language, 'request.strategy.language'),
    audience: text(strategy.audience, 'request.strategy.audience', { max: MAX_LONG_STRING }),
    positioning: text(strategy.positioning, 'request.strategy.positioning', { max: MAX_LONG_STRING }),
    pillars,
    cadence: text(strategy.cadence, 'request.strategy.cadence', { required: false }),
    subjectsToAvoid: textList(strategy.subjectsToAvoid, 'request.strategy.subjectsToAvoid'),
  };

  const defaults = value.defaults === undefined
    ? {}
    : object(value.defaults, 'request.defaults', DEFAULT_KEYS);
  const kind = defaults.kind === undefined ? 'story' : text(defaults.kind, 'request.defaults.kind', { max: 32 });
  if (!CHANNEL_PLANNER_KINDS.includes(kind)) fail('request.defaults.kind', 'must be story or animation');
  const style = defaults.style === undefined ? 'documentary' : text(defaults.style, 'request.defaults.style', { max: 120 });

  const references = value.referenceChannels === undefined
    ? []
    : value.referenceChannels;
  if (!Array.isArray(references) || references.length > MAX_REFERENCES) {
    fail('request.referenceChannels', `must be an array with at most ${MAX_REFERENCES} items`);
  }
  const referenceChannels = references.map(normalizeReference);
  const names = new Set();
  for (const reference of referenceChannels) {
    const key = reference.name.toLocaleLowerCase();
    if (names.has(key)) fail('request.referenceChannels', 'must not contain duplicate channel names');
    names.add(key);
  }
  return { count: value.count, strategy: normalizedStrategy, defaults: { kind, style }, referenceChannels };
}

function normalizeIdea(value, index, allowedPillars = null) {
  const pathName = `ideas[${index}]`;
  object(value, pathName, IDEA_KEYS);
  requiredKeys(value, pathName, IDEA_KEYS);
  const result = {
    title: text(value.title, `${pathName}.title`, { max: 160 }),
    hook: text(value.hook, `${pathName}.hook`, { max: 280 }),
    angle: text(value.angle, `${pathName}.angle`, { max: 600 }),
    pillar: text(value.pillar, `${pathName}.pillar`, { max: 160 }),
    kind: text(value.kind, `${pathName}.kind`, { max: 32 }),
    style: text(value.style, `${pathName}.style`, { max: 120 }),
    priority: value.priority,
  };
  if (!CHANNEL_PLANNER_KINDS.includes(result.kind)) fail(`${pathName}.kind`, 'must be story or animation');
  if (!Number.isInteger(result.priority) || result.priority < 1 || result.priority > 100) {
    fail(`${pathName}.priority`, 'must be an integer from 1 to 100');
  }
  if (allowedPillars && !allowedPillars.has(result.pillar.toLocaleLowerCase())) {
    fail(`${pathName}.pillar`, 'must be one of request.strategy.pillars');
  }
  return result;
}

function dedupeKey(idea) {
  // The title is the customer-facing identity of a slate item. Rewording its
  // hook cannot make a second copy of the same title a distinct idea.
  return idea.title.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function validateDiversity(ideas, request) {
  const used = new Set(ideas.map(idea => idea.pillar.toLocaleLowerCase()));
  const target = Math.min(request.count, request.strategy.pillars.length);
  if (used.size < target) fail('ideas', `must cover at least ${target} channel pillars`);
}

/** Strictly validates a complete agent response. */
export function validateChannelPlan(value, request) {
  const normalizedRequest = validateChannelPlannerRequest(request);
  object(value, 'plan', PLAN_KEYS);
  requiredKeys(value, 'plan', ['ideas']);
  if (!Array.isArray(value.ideas) || value.ideas.length !== normalizedRequest.count) {
    fail('plan.ideas', `must contain exactly ${normalizedRequest.count} ideas`);
  }
  const pillars = new Set(normalizedRequest.strategy.pillars.map(item => item.toLocaleLowerCase()));
  const ideas = value.ideas.map((idea, index) => normalizeIdea(idea, index, pillars));
  const seen = new Set();
  for (const idea of ideas) {
    const key = dedupeKey(idea);
    if (seen.has(key)) fail('plan.ideas', 'must not contain duplicate title, hook, and angle combinations');
    seen.add(key);
  }
  validateDiversity(ideas, normalizedRequest);
  return { ideas };
}

function promptPayload(request) {
  return {
    count: request.count,
    strategy: request.strategy,
    defaults: request.defaults,
    referenceChannels: request.referenceChannels,
  };
}

function plannerPrompt(request) {
  return [
    'You are a channel-content planner. Produce original, useful video ideas from the customer brief below.',
    'Use reference-channel summaries only to notice broad public patterns. Do not copy channel names, titles, scripts, thumbnails, or sequences.',
    'Return only a JSON object with exactly one key, "ideas". It must contain the requested number of objects.',
    'Every idea object must have only these keys: title, hook, angle, pillar, kind, style, priority.',
    'pillar must exactly match a customer strategy pillar. kind is story or animation. priority is an integer from 1 to 100.',
    'Cover each available pillar before repeating one. Make titles, hooks, and angles meaningfully distinct. Do not add commentary or markdown.',
    `Customer brief:\n${JSON.stringify(promptPayload(request))}`,
  ].join('\n\n');
}

function fallbackIdeas(request) {
  const ideas = [];
  for (let index = 0; index < request.count; index += 1) {
    const pillar = request.strategy.pillars[index % request.strategy.pillars.length];
    const [title, hook, angle] = FALLBACK_TEMPLATES[index % FALLBACK_TEMPLATES.length];
    ideas.push({
      title: title.replaceAll('{pillar}', pillar),
      hook,
      angle,
      pillar,
      kind: request.defaults.kind,
      style: request.defaults.style,
      priority: Math.max(1, 100 - index * 4),
    });
  }
  return ideas;
}

function parseDirectorResponse(value) {
  if (typeof value === 'string') return JSON.parse(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) return clone(value);
  throw new Error('director response is not JSON');
}

/**
 * Create a 10/20 idea slate.
 *
 * `director`, when supplied, receives `{ task, prompt, customerBrief }` and
 * must return JSON (or a JSON string) matching `validateChannelPlan`. A bad,
 * unavailable, or absent director never leaks its raw error or prompt: the
 * result falls back to a deterministic local slate suitable for review.
 */
export async function planChannelIdeas(input, { director } = {}) {
  const request = validateChannelPlannerRequest(input);
  if (director !== undefined && typeof director !== 'function') fail('options.director', 'must be a function');
  if (director) {
    try {
      const output = await director({
        task: 'channel-plan',
        prompt: plannerPrompt(request),
        customerBrief: clone(promptPayload(request)),
      });
      const plan = validateChannelPlan(parseDirectorResponse(output), request);
      return { ideas: plan.ideas, source: 'director', warnings: [] };
    } catch {
      // The result intentionally contains no raw agent output, error, prompt,
      // provider detail, or credential-shaped value.
      return { ideas: fallbackIdeas(request), source: 'fallback', warnings: ['director_unavailable_or_invalid'] };
    }
  }
  return { ideas: fallbackIdeas(request), source: 'fallback', warnings: ['director_not_configured'] };
}

export const createChannelPlan = planChannelIdeas;
