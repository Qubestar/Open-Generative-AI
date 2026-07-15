// Per-agent pipeline registry.
//
// Claude, Codex, and Hermes each keep their OWN isolated copy of the faceless
// doodle pipeline in the Faceless YT 1 project. The core scripts are the same,
// but the image-generation workflow, venv, invocation quirks, and script rules
// differ per agent. When Vidmyo delegates a video to an agent it must point
// that agent at ITS OWN pipeline — not a generic one.
//
// We only REFERENCE these folders; Vidmyo never edits the pipeline files.
// Paths are overridable via story-config.json { agentPipelines: { <id>: {...} } }.

const fs = require('fs');

const FYT = '/Volumes/My Lexar/AI Projects/Faceless YT 1';

const DEFAULTS = {
  claude_code: {
    label: 'Claude',
    dir: `${FYT}/pipeline`,
    venv: `${FYT}/pipeline/.venv/bin/python`,
    pythonPrefix: '',
    images:
      'Google Flow → Nano Banana 2 (free) is the default; Higgsfield web is the only fallback. '
      + 'After downloads land in images/, run batch_generate.py until it reports "Missing: 0" and eyeball a contact sheet.',
    scriptRule: 'Target ~8-9 min (1,400-1,900 words). Clean, retention-first script.',
  },
  codex: {
    label: 'Codex',
    dir: `${FYT}/pipeline-codex`,
    venv: `${FYT}/pipeline-codex/.venv/bin/python`,
    pythonPrefix: '',
    images:
      'Fill prompts with fill_prompts.py → build the Curio Flow Queue JSON. Use the Codex Chrome '
      + 'extension to prepare a fresh Flow project (Nano Banana 2 · 16:9 · Agent mode OFF), then Luke '
      + 'starts the Curio Flow Queue extension which owns bulk generation. Move verified sNNN.jpg into '
      + 'images/ and re-run batch_generate.py until Missing: 0.',
    scriptRule: 'Very easy English (CEFR B1): 6-14 word sentences, one idea each, common words. '
      + 'Normal length 8-9 min; occasional naturally-short videos allowed.',
  },
  hermes: {
    label: 'Hermes',
    dir: `${FYT}/pipeline-hermes`,
    venv: `${FYT}/pipeline-hermes/.venv/bin/python`,
    // Hermes injects its own Python 3.11 into PYTHONPATH, which breaks this
    // 3.12 venv (pydantic_core mismatch). Always strip it.
    pythonPrefix: 'env -u PYTHONPATH ',
    images:
      'make_flow_queue.py (beats.json → queue.json) → open_flow.py (opens signed-in Chrome at flow.google) '
      + '→ Luke starts the Curio Flow Queue extension → pull_flow_images.py --wait syncs downloads into images/. '
      + 'Hermes does NOT drive the browser itself.',
    scriptRule: 'Simple conversational English (see pipeline-hermes/references/language-level.md). '
      + 'Default 6-9 min; short videos allowed when the topic is naturally short.',
  },
};

function getAgentPipeline(agentId, config = {}) {
  const override = (config.agentPipelines || {})[agentId] || {};
  const base = DEFAULTS[agentId];
  if (!base) return null;
  const merged = { ...base, ...override };
  merged.available = fs.existsSync(merged.venv) && fs.existsSync(merged.dir);
  return merged;
}

// The `images:` line for the brief. Each agent's own pipeline is Google-Flow-based
// (browser + the Curio Flow Queue extension) — correct only while Vidmyo's image
// source IS Flow. Point it at a cloud source in Settings → Story and that whole
// workflow is wrong, so say so instead of letting the agent burn a session on it.
// The agent can't call the API itself: the key is in Vidmyo's keychain and the
// vidmyo MCP has no image-generation tool, so images route through Vidmyo's ⚡
// (which is a human gate the pipeline already has).
function imageInstruction(pipeline, imageSource) {
  if (!imageSource || imageSource.manual) return pipeline.images;
  return `Vidmyo's scene-image source is set to ${imageSource.name} (Settings → Story), NOT Google Flow — `
    + `your Flow/Nano-Banana workflow does NOT apply here. You cannot call ${imageSource.name} yourself `
    + `(Vidmyo holds the key). Write the prompts, then STOP at the images stage and ask Luke to click `
    + `"${imageSource.name} ⚡" on each scene in Vidmyo's Story tab (or Attach…). Resume at Approve → assemble.`;
}

// A ready-to-embed instruction block for the session brief / kickoff prompt.
function pipelineInstructions(agentId, config = {}, videoDir = '', imageSource = null) {
  const p = getAgentPipeline(agentId, config);
  if (!p) return '';
  const py = `${p.pythonPrefix}${p.venv}`;
  return [
    `## Your pipeline (${p.label})`,
    `Use YOUR OWN pipeline folder — do not use another agent's:`,
    `- dir: ${p.dir}`,
    `- run scripts as: ${py} ${p.dir}/<script>.py <args>`,
    `- voiceover: ${py} ${p.dir}/tts_kokoro.py ${videoDir}/script.txt ${videoDir}/voiceover.wav --voice am_onyx`,
    `- beats: ${py} ${p.dir}/detect_beats.py ${videoDir}/voiceover.wav ${videoDir}/beats.json`,
    `- assemble: ${py} ${p.dir}/assemble.py ${videoDir} --ext jpg`,
    `- finalize (4K + −14 LUFS): ${p.dir}/finalize_video.sh <in.mp4> ${videoDir}/<seo-name>.mp4`,
    `- images: ${imageInstruction(p, imageSource)}`,
    `- script: ${p.scriptRule}`,
    p.available ? '' : `⚠ Pipeline venv/dir not found at the paths above — run ${p.dir}/setup_env.sh first.`,
  ].filter(Boolean).join('\n');
}

module.exports = { getAgentPipeline, pipelineInstructions, imageInstruction, DEFAULTS };
