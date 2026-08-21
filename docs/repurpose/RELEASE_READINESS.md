# Repurpose release readiness

Assessment date: 2026-08-22. Scope: the SAI-17–SAI-21 local-first Repurpose
vertical, including Electron packaging and the local MCP surface.

## Verdict

- Internal engineering alpha: **GO**, on the tested Apple-silicon development
  machine with trusted local inputs, for contract and integration testing.
- Private creator beta: **NO-GO** until the licensed five-video human benchmark
  is completed and transcription-model installation/readiness is exercised on
  the distribution path.
- Public creator release: **NO-GO** until the real benchmark passes, a supported
  Python/runtime installation strategy is selected, the remaining Electron
  toolchain security upgrades are completed, and macOS Developer ID signing
  and notarization are in place.

The offline synthetic corpus passed mechanics only. Its quality status is
`unknown`, by design; it is not evidence of transcription, ranking, sentence,
speaker-tracking, or creator-facing quality.

## Evidence captured

- The version-1 corpus enforced exactly five categories. All five synthetic
  scenarios produced five approved shortlist entries, zero mid-word boundary
  violations, zero duplicate shortlist pairs, and one probed 1080x1920
  H.264/AAC export each.
- Reframe evidence recorded safe-zone fractions of 0.98 or 1.0. Three scenarios
  deliberately exercised fallback layout. No quality inference was made.
- Fixture media generation completed in 1.91 seconds (2.05 seconds CLI wall
  time) and report computation in 0.18 seconds (0.35 seconds CLI wall time) in
  the final recorded run. Individual real-stage
  timings remain null because the fixture generator does not fabricate them.
- Restart/recovery tests cover ingest, transcribe, generate-candidates, rank,
  repair-boundaries, reframe, and render, including both reframe substeps. They
  distinguish live children from stale jobs and preserve completed artifacts.
- The final Apple-silicon directory package built in 15.24 seconds and occupied
  744 MB including the Electron runtime. The packaged
  standalone Next server served `/studio`; the packaged Python source imported
  contract version 1; and the packaged MCP server listed its tools over stdio.
- The Python wheel contains the benchmark module plus installed data files for
  all schemas, the bundled YuNet model, and its license.
- Dependency updates moved Next.js to 16.3.2 and Axios to 1.19.0. Both
  `npm audit --omit=dev` and the MCP audit report zero vulnerabilities. The full
  development audit still requires breaking Electron 43, electron-builder 26,
  and Vite 8 upgrades; those toolchain migrations remain explicit public-release
  blockers rather than untested changes to this milestone.
- Full regression and final package-size results are recorded on the SAI-21 pull
  request after the final clean verification run.

## Distribution boundaries and blockers

The directory package is self-contained for the Next web runtime, Electron
main process, MCP server, core service, engine source, schemas, and bundled
YuNet asset. It excludes repository projects, `.vidmyo`, `videos`, environment
files, engine tests, and MCP source tests. Runtime paths resolve from Electron's
`resourcesPath`; packaged operation does not substitute developer checkout
paths.

The current macOS artifact is ad-hoc signed because no valid Developer ID
Application identity is installed. It is not notarized. Python itself and the
transcription model are intentionally not bundled in this milestone, and model
setup remains an explicit user action. Cross-platform installers and real-media
crash/recovery exercises remain required before public release.

No source media, generated benchmark media, credentials, or paid/model-call
outputs are committed as release evidence.
