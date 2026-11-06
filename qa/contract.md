# Initial Animations contract; qa-gate/1.0 core rules retained.
policy_version: "qa-gate/1.0"
rules:
  - id: R-01
    rule: "Completion requires an actual MP4 and matching measured timing/audio evidence."
    test: "node qa/checks/animation_unit.mjs"
    tier: STRICT
    severity: blocker
    module: filesystem-media
    mutation:
      file: packages/core/src/codeAnimation.js
      find: "if (!evidence.ok ||"
      replace: "if (false && !evidence.ok ||"
  - id: R-02
    rule: "Retry reuses known Zenborg runs and cached code; uncertain dispatch is never silently resubmitted."
    test: "node qa/checks/animation_unit.mjs"
    tier: STRICT
    severity: blocker
    module: external-integrations
    mutation:
      file: electron/lib/zenborgBrowser.js
      find: "if (!saved || saved.fingerprint !== fingerprint || saved.state === 'retry-ready')"
      replace: "if (true)"
  - id: R-03
    rule: "Script writes are verified by independent reload and invalidate stale output."
    test: "node qa/checks/animation_unit.mjs"
    tier: STRICT
    severity: blocker
    module: persistent-state
    mutation:
      file: mcp/lib/animationService.js
      find: "project.manifest.script = script.trim();"
      replace: "project.manifest.script = project.manifest.script;"
  - id: R-04
    rule: "Projects have shared writer locks; browser code cannot access parent or network."
    test: "node qa/checks/animation_render_smoke.mjs"
    tier: STRICT
    severity: blocker
    module: agent-tools
    mutation:
      file: packages/core/pipelines/code-animation/render.mjs
      find: 'sandbox="allow-scripts"'
      replace: 'sandbox="allow-scripts allow-same-origin"'
  - id: R-05
    rule: "Credentials never enter project artifacts or tool errors; Zenborg owns its credential handling."
    test: "node qa/checks/animation_unit.mjs"
    tier: ALL
    severity: blocker
    module: core
  - id: R-06
    rule: "Interrupted work never exposes partial output as complete; promotion is atomic and completed stages are retained."
    test: "node qa/checks/animation_render_smoke.mjs"
    tier: STRICT
    severity: blocker
    module: filesystem-media
    mutation:
      file: packages/core/pipelines/code-animation/render.mjs
      find: "fs.renameSync(temp, output);"
      replace: "fs.rmSync(temp, { force: true });"

# Mutation copies must install declared dependencies. Missing dependencies are
# execution errors, never evidence of a killed mutant. Live provider and signed
# package checks remain separate release gates.
