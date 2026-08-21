# Repurpose five-scenario benchmark

This benchmark produces repeatable release evidence for exactly five source
categories: `talking_head`, `two_speaker`, `lecture`, `webinar`, and
`visually_active`. The versioned manifest is validated by
`benchmark-corpus.v1.schema.json`; missing, duplicated, or renamed categories
fail closed.

## Offline mechanics run

From the repository root:

```bash
output_dir=$(mktemp -d /tmp/vidmyo-benchmark.XXXXXX)
PYTHONPATH=packages/repurpose-engine/src python3 -m vidmyo_repurpose.cli \
  benchmark-fixtures --output "$output_dir"
PYTHONPATH=packages/repurpose-engine/src python3 -m vidmyo_repurpose.cli \
  benchmark --manifest "$output_dir/benchmark-corpus.v1.json" \
  --output "$output_dir/report"
```

The first command creates five 20-second horizontal sources, one vertical
H.264/AAC export per scenario, and minimal versioned evidence. It uses local
FFmpeg color and sine-wave generators, performs no network or model call, and
contains no third-party expressive content. The report computes shortlist
approval count, sentence-boundary status, mid-word violations, duplicate
shortlist pairs, reframe fallback/safe-zone observations, FFprobe export
contract results, and available per-stage timings.

Synthetic fixture evidence can make only `mechanical_status` pass. Its
`quality_status` is always `unknown`; it cannot substantiate transcription,
ranking, sentence, speaker-tracking, or creator-release quality.

## Licensed real-corpus intake

For a quality run, create five project directories with completed evidence and
one manifest entry per required category. Set every entry's `evidence_kind` to
`human_real` and record the source provenance and license. Keep media outside
Git and point the manifest at project-confined paths. Human reviewers must
approve or reject the top five suggestions and record complete-sentence status
before running the report.

The quality gate passes only when all five scenarios are real human-reviewed
evidence and at least four qualify. A mixed or synthetic corpus remains
`unknown`; an incomplete real corpus fails schema validation. Never interpret
the offline fixture report as a claim about creator-facing output quality.
