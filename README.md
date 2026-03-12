# Cloudflare Browser Rendering Agent

Minimal open-source v1 bundle for a `blprnt` agent that answers Cloudflare Browser Rendering workflow questions from a small reviewed set of official docs.

## Public repository

- Public remote: `https://github.com/blprnt-ai/agent-training.git`

## Current scope

- This repo ships a narrow first-pass knowledge bundle, not a full Browser Rendering corpus.
- It currently covers overview, `/crawl`, `/json`, `/scrape`, and limits/constraints.
- It builds a grounded agent bundle for retrieval/training workflows inside `blprnt`. It does not fine-tune model weights.

## What the shipped agent does

- explains what Browser Rendering is and which endpoint fits a job
- helps choose between `/crawl`, `/json`, and `/scrape`
- summarizes documented limits and certainty boundaries without inventing numbers
- refuses claims that are not supported by the tracked docs

## Why it is useful

- Browser Rendering has multiple paths that look similar until they waste an afternoon.
- This bundle turns the core docs into a small operator-focused corpus for endpoint selection, setup, and safe answers.
- It is most useful when a user wants the shortest path to the right Browser Rendering workflow without rereading the docs site.

## Runtime positioning

- `blprnt` is the primary runtime and orchestrator for this bundle.
- Other runtimes, including OpenClaw-style apps, can adapt the agent file, knowledge files, and eval prompts manually.
- This repo does not ship or claim a turnkey adapter for non-`blprnt` runtimes.

## Testing posture

- The shipped evals cover overview, `/crawl`, `/json`, `/scrape`, endpoint comparison/selection, and limits certainty boundaries.
- The bundle is tested as a narrow grounded knowledge pack, not as a full Browser Rendering assistant.
- It does not claim tested coverage for every Browser Rendering endpoint or every account-specific limit behavior.

## What this repo includes

- a minimal agent definition for `blprnt`
- placeholder-only config templates
- the exact first-pass crawl scope for Browser Rendering docs
- a small tracked first-pass knowledge pack derived from a real crawl artifact plus targeted source capture for missing core topics
- setup and usage instructions for safe local configuration
- compact demo/eval fixtures for `/crawl`, `/json`, `/scrape`, limits, and grounding behavior

## Source material

- Source URL: `https://developers.cloudflare.com/browser-rendering/`

## Approved v1 crawl scope

- source: `links`
- include: `https://developers.cloudflare.com/browser-rendering/**`
- exclude: `**/changelog/**`
- exclude: `**/pricing/**`
- limit: `60`
- depth: `2`
- formats: `markdown`
- render: `false`

Do not widen this scope in v1. Cheap and focused wins.

## Cost and limit posture

- Browser Rendering usage is not free forever just because optimism is.
- Expect account limits, timeout behavior, and occasional rate friction.
- Reuse successful local crawl artifacts before issuing fresh create calls.
- Prefer targeted acquisition over broad reruns when filling knowledge gaps.

## Safe configuration rule

Real secrets do not belong in this repo. Use environment variables only.

- allowed: `.env.example`, placeholder values, local untracked `.env`
- forbidden: real API keys, tokens, copied outputs with secrets, committed `.env` values

## Repository layout

```text
agent/
  cloudflare-browser-rendering-agent.json
config/
  blprnt.config.example.json
  crawl-scope.json
docs/
  setup-and-usage.md
evals/
  browser-rendering-v1.json
knowledge/
  browser-rendering-crawl.json
  browser-rendering-json.json
  browser-rendering-limits.json
  browser-rendering-overview.json
  browser-rendering-scrape.json
  index.json
scripts/
  run-browser-rendering-crawl.mjs
  test-agent.mjs
.env.example
```

## Quick start

1. Copy `.env.example` to a local `.env` file and replace placeholders locally only.
2. Review `config/crawl-scope.json` and keep it exactly as shipped for the first pass.
3. Run `node scripts/run-browser-rendering-crawl.mjs` as the primary workflow. It writes only to `outputs/browser-rendering/raw/real/`.
4. If a successful crawl JSON already exists locally, run `node scripts/run-browser-rendering-crawl.mjs --reuse-file <path-to-successful-crawl.json>` instead of forcing another create call.
5. Load `agent/cloudflare-browser-rendering-agent.json` and `config/blprnt.config.example.json` into your local `blprnt` setup after your normal model/runtime setup. This bundle does not add a separate blprnt credential field.
6. Use `knowledge/index.json` as the tracked first-pass knowledge basis. The reviewed bundle currently includes overview, `/crawl`, `/json`, `/scrape`, and limits.
7. Use `evals/browser-rendering-v1.json` for smoke-test questions and answer quality checks.
8. Run `node scripts/test-agent.mjs --prompt "..."` for one grounded local bundle check or `node scripts/test-agent.mjs --eval` for the formal eval set. Results write to `outputs/browser-rendering/tests/`.

## Workflow priority

- Primary: one-command local runner.
- Secondary: reuse an existing successful crawl JSON when create calls are rate-limited.
- Troubleshooting only: manual API calls.

## Demo and eval organization

- `evals/browser-rendering-v1.json` contains representative prompts and success criteria.
- `evals/browser-rendering-stress-v1.json` adds a 30-prompt robustness pool with rephrasings and refusal checks.
- The eval set is intentionally small. It exists to prove setup, grounding, and non-fabrication, not to cosplay as a benchmark suite.

## Local agent bundle test harness

- single prompt: `node scripts/test-agent.mjs --prompt "Compare /crawl, /json, and /scrape for site-wide capture, structured extraction, and selector-based extraction."`
- formal evals: `node scripts/test-agent.mjs --eval`
- stress evals: `node scripts/test-agent.mjs --env-file C:\\absolute\\path\\to\\.env.openrouter.test --eval --eval-file C:\\absolute\\path\\to\\evals\\browser-rendering-stress-v1.json`
- model env: set `OPENROUTER_API_KEY` plus `OPENROUTER_MODEL` for OpenRouter, or `OPENAI_API_KEY` for a generic OpenAI-compatible target; optional `OPENROUTER_BASE_URL` or `OPENAI_BASE_URL` override the default request target.
- output path: `outputs/browser-rendering/tests/`
- eval mode writes the run file immediately and rewrites it after each prompt with `status`, `summary.completed`, `summary.passed`, `summary.failed`, `summary.remaining`, and `lastCompletedId`.

## Notes

- First runtime is `blprnt` only.
- Other runtimes are portable targets, not promised drop-in integrations.
- No credentials are stored in tracked files.
- The tracked `knowledge/` bundle is intentionally small and reviewable, not a vanity dump of the docs site.
- This repo is for grounded retrieval/training workflows in `blprnt`, not model-weight fine-tuning.
- This repo is scaffolded for understanding, safe setup, and a narrow first-pass run.