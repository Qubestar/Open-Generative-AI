import { z } from 'zod';

export function registerAnimationTools(server, service) {
  const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
  const wrap = fn => async args => {
    try { return reply(await fn(args)); }
    catch (error) { return { isError: true, content: [{ type: 'text', text: String(error.message).replace(/(?:Bearer\s+|sk-)[\w-]+/g, '[redacted]').slice(0, 1600) }] }; }
  };
  const directory = z.string().max(2000);
  const tools = [
    ['animations_styles', 'List numbered animation styles with names, source references and preview clips. Styles 1–3 retain the original desktop pipeline; 4–170 are code animation. Search by name or number.', { query: z.string().max(200).optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(50).optional() }, args => service.styles(args)],
    ['animations_create', 'Create an Animations project from a topic (or a planned topic supplied by the caller) and style number/id. No provider calls. Workflow: set_script → prepare → code_task → submit_code → render. All rendering is local; no publishing.', { project_dir: directory, topic: z.string().min(1).max(300), style: z.union([z.number().int(), z.string()]), script: z.string().max(30000).optional(), details: z.string().max(10000).optional(), aspect: z.enum(['16:9', '9:16']).optional(), duration_seconds: z.number().min(5).max(3600).optional(), language: z.string().max(80).optional(), narration: z.boolean().optional(), voice: z.string().max(80).optional() }, args => service.create(args)],
    ['animations_get', 'Read durable animation state, actual narration timing, output and the next action.', { project_dir: directory }, args => service.get(args.project_dir)],
    ['animations_set_script', 'Save the clean narration authored by the calling agent. Invalidates stale audio and video. No nested AI or paid API is invoked.', { project_dir: directory, script: z.string().min(1).max(30000) }, args => service.setScript(args.project_dir, args.script)],
    ['animations_prepare', 'Start local Kokoro voiceover and speech beat timing; returns a durable job immediately. Poll animations_get_job. Does not download models or spend API credits.', { project_dir: directory }, args => service.prepare(args.project_dir)],
    ['animations_code_task', 'Return the selected style guide, offline HTML frame contract and measured narration beats. Author original animation HTML implementing window.renderFrame(timeSeconds), then call animations_submit_code. This is internal agent work; no user prompt copying is needed.', { project_dir: directory }, args => service.codeTask(args.project_dir)],
    ['animations_submit_code', 'Save agent-authored self-contained HTML animation. Rendering runs only in an offline opaque-origin browser sandbox; no host code is executed.', { project_dir: directory, html: z.string().min(100).max(2000000) }, args => service.submitCode(args.project_dir, { html: args.html })],
    ['animations_render', 'Start local code-animation rendering and narration mastering; returns a durable job immediately. Poll animations_get_job. Produces a verified MP4 and frame previews; does not publish.', { project_dir: directory }, args => service.render(args.project_dir)],
    ['animations_get_job', 'Poll only an animation preparation/render job. On error, completed narration/code stays reusable.', { job_id: z.string().max(200) }, args => service.job(args.job_id)],
    ['animations_cancel', 'Stop local animation work. Reuses completed artifacts on retry.', { job_id: z.string().max(200) }, args => service.cancel(args.job_id)],
  ];
  for (const [name, description, inputSchema, fn] of tools) server.registerTool(name, { description, inputSchema }, wrap(fn));
}
