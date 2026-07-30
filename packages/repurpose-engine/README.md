# Vidmyo Repurpose engine contracts

This package is the dependency-light contract boundary and local ingest worker
for Vidmyo Repurpose. It requires Python 3.10 or newer. Local ingest also
requires `ffprobe` from FFmpeg to be available on `PATH`; it does not download,
copy, transcribe, rank, reframe, or render source media.

Install for development and tests:

```bash
python3 -m pip install -e '.[test]'
python3 -m pytest
```

Validate a versioned request or project manifest:

```bash
vidmyo-repurpose validate --kind request tests/fixtures/valid-worker-request.json
vidmyo-repurpose validate --kind manifest tests/fixtures/valid-project-manifest.json
```

Exercise the JSONL protocol without doing media work:

```bash
vidmyo-repurpose smoke --request tests/fixtures/valid-worker-request.json
```

Ingest the `local_file` source named by `<project-dir>/repurpose.json`:

```bash
vidmyo-repurpose ingest --request /path/to/ingest-request.json
```

The request must use stage `ingest` and point `project_dir` at the caller's
Repurpose project. A successful run emits ordered version-1 JSONL events and
atomically writes `artifacts/ingest-artifact.v1.json` inside that project.
The artifact contains normalized ffprobe metadata and a streaming SHA-256
fingerprint; the source file itself is never copied or modified. The reserved
`url` source contract remains valid, but execution returns
`url_ingest_not_implemented` without making a network request.

The authoritative version-1 schemas live in `schemas/`.
