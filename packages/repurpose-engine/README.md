# Vidmyo Repurpose engine contracts

This package is the dependency-light contract boundary between Vidmyo's Node
core and the future Python Repurpose media worker. It requires Python 3.10 or
newer and intentionally has no FFmpeg, transcription, model, tracking, or
rendering dependencies.

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

The authoritative version-1 schemas live in `schemas/`.
