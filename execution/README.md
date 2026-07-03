# Execution Scripts

Deterministic Python scripts. Each script should be:
- **Reliable** — same input → same output
- **Testable** — runnable standalone with clear args
- **Commented** — explain the why, not just the what

All secrets are read from `../.env` via `python-dotenv`.
All intermediates are written to `../.tmp/`.
