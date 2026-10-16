// Main-process adapter for Channel Planner.
//
// The current local-agent subsystem owns detection, authentication, and user
// launched sessions. It intentionally does not auto-run prompts. If a future
// local-agent implementation exposes `runStructured`, this adapter uses it;
// otherwise planning remains local and deterministic. Tests and approved
// integrations can inject `director` directly.

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const agentsModule = require('./agents');
const agentPipelines = require('./agentPipelines');

const SAFE_AGENT_ID = /^[a-z][a-z0-9_]{0,63}$/;

function createChannelPlanner(deps = {}) {
  const loadCore = deps.core || (() => import(pathToFileURL(path.join(__dirname, '..', '..', 'packages', 'core', 'index.js')).href));
  const localAgents = deps.agents || agentsModule;
  const pipelines = deps.agentPipelines || agentPipelines;
  const injectedDirector = deps.director;

  if (injectedDirector !== undefined && typeof injectedDirector !== 'function') {
    throw new TypeError('director must be a function');
  }

  function localDirector(agentId) {
    if (typeof localAgents.runStructured !== 'function') return undefined;
    if (agentId !== undefined && (typeof agentId !== 'string' || !SAFE_AGENT_ID.test(agentId))) {
      throw new TypeError('agentId is invalid');
    }
    const pipeline = agentId && typeof pipelines.getAgentPipeline === 'function'
      ? pipelines.getAgentPipeline(agentId)
      : null;
    if (agentId && !pipeline) throw new Error('The selected local agent is unavailable.');
    return request => localAgents.runStructured({
      agentId: agentId || null,
      pipeline,
      task: request.task,
      prompt: request.prompt,
      customerBrief: request.customerBrief,
    });
  }

  async function plan(input, options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options must be an object');
    if (options.director !== undefined && typeof options.director !== 'function') throw new TypeError('options.director must be a function');
    const core = await loadCore();
    const director = options.director || injectedDirector || localDirector(options.agentId);
    return core.planChannelIdeas(input, { director });
  }

  return { plan };
}

module.exports = { createChannelPlanner };
