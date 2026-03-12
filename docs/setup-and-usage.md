# Setup and usage

This repo builds a grounded Browser Rendering agent bundle for `blprnt` from a small reviewed knowledge pack. It does not fine-tune model weights.

## What the shipped agent does

- answers Browser Rendering workflow questions from the tracked docs bundle
- helps choose between `/crawl`, `/json`, and `/scrape`
- explains documented limits and when certainty stops
- refuses unsupported claims instead of padding with confident nonsense

## Why this bundle is useful

- it compresses the core Browser Rendering docs into a reviewable operator bundle
- it is aimed at real setup and endpoint-choice questions, not generic product paraphrase
- it gives `blprnt` a grounded first-pass corpus that is actually small enough to inspect

## Runtime positioning

- `blprnt` is the primary workflow and orchestrator.
- Other runtimes, including OpenClaw-style apps, can reuse the knowledge files, agent definition, and eval prompts as source material.
- This repo does not ship a tested turnkey adapter for any non-`blprnt` runtime.

## Current tested coverage and limits

- tested: overview, `/crawl`, `/json`, `/scrape`, endpoint comparison, setup guidance, and limits certainty boundaries
- not claimed: full Browser Rendering endpoint coverage, undocumented numeric ceilings, or drop-in runtime portability beyond `blprnt`

## Public repo and source

- Public remote: `https://github.com/blprnt-ai/agent-training.git`
- Source URL: `https://developers.cloudflare.com/browser-rendering/`

## Safe secret handling

Use environment variables only.

- Copy `.env.example` to `.env` locally.
- Replace placeholder values in `.env` with real local values.
- Do not commit `.env`.
- Do not paste tokens into JSON files in this repo.
- Keep raw crawl output in `outputs/`. It is ignored already. Leave it that way.

## Primary workflow

Use the local runner first. That is the intended path.

- Primary: `node scripts/run-browser-rendering-crawl.mjs`
- Backup when create calls are throttled: `node scripts/run-browser-rendering-crawl.mjs --reuse-file <path-to-successful-crawl.json>`
- Troubleshooting only: manual API calls

## Cost and limits

- Treat create calls as metered and limit-bound.
- Reuse a successful local crawl artifact before starting a fresh crawl.
- Prefer targeted capture for missing docs over broad reruns.
- Expect timeout and concurrency constraints as normal operating conditions.

## Files to use

- Agent definition: `agent/cloudflare-browser-rendering-agent.json`
- Runtime template: `config/blprnt.config.example.json`
- Crawl scope: `config/crawl-scope.json`
- Tracked knowledge bundle: `knowledge/index.json`
- First-pass tracked docs: overview, `/crawl`, `/json`, `/scrape`, and limits under `knowledge/`
- Evals: `evals/browser-rendering-v1.json`

## First-pass blprnt flow

1. Create a local `.env` from `.env.example`.
2. Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in that local `.env`.
3. Run `node scripts/run-browser-rendering-crawl.mjs` from the repo root.
4. Use the real crawl JSON written to `outputs/browser-rendering/raw/real/latest.json` as the source artifact for the tracked first-pass knowledge bundle.
5. Start with `knowledge/index.json` as the current reviewable corpus manifest.
6. Import or mirror `agent/cloudflare-browser-rendering-agent.json` into your local `blprnt` agent setup.
7. Use `config/blprnt.config.example.json` as the template for local runtime configuration. This bundle does not add a separate blprnt credential field; `blprnt` usage happens after your own model/runtime setup.
8. After indexing or training completes, run the prompts in `evals/browser-rendering-v1.json`.

## Local crawl runner

The repo includes one local runner so this is not manual curl theater.

### Create local `.env`

```env
CLOUDFLARE_API_TOKEN=YOUR_CLOUDFLARE_API_TOKEN_HERE
CLOUDFLARE_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID_HERE
```

### Run it

```bash
node scripts/run-browser-rendering-crawl.mjs
```

What it does:

- reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the environment or local `.env`
- reads crawl defaults from `config/crawl-scope.json`
- starts the approved Browser Rendering crawl against `https://developers.cloudflare.com/browser-rendering/`
- tolerates the brief create-to-poll delay before a new crawl job becomes readable
- uses `source: "links"`, `limit: 60`, `depth: 2`, `formats: ["markdown"]`, and `render: false`
- writes real crawl output to `outputs/browser-rendering/raw/real/`
- refuses to write non-UUID job ids into the real output directory, so fake `job-123` garbage cannot poison the next real run

## Reuse an existing successful crawl JSON

If a successful crawl already exists locally, do not burn another create call just to satisfy ritual.

```bash
node scripts/run-browser-rendering-crawl.mjs --reuse-file "C:\path\to\successful-crawl.json"
```

What this does:

- skips the create call entirely
- stages the existing successful crawl as `outputs/browser-rendering/raw/real/latest.json`
- lets local `blprnt` bundle work continue even when repeated new create attempts hit `429`
- gives you the source artifact used to derive the tracked `knowledge/` first-pass bundle

## Tracked first-pass knowledge bundle

The current tracked corpus is intentionally tiny.

- bundle index: `knowledge/index.json`
- current documents:
  - `knowledge/browser-rendering-overview.json`
  - `knowledge/browser-rendering-crawl.json`
  - `knowledge/browser-rendering-json.json`
  - `knowledge/browser-rendering-scrape.json`
  - `knowledge/browser-rendering-limits.json`
- source artifact: `outputs/browser-rendering/raw/real/latest.json`

What is included:

- source URL and crawl metadata
- a cleaned Browser Rendering overview summary
- concise endpoint notes for `/crawl`, `/json`, and `/scrape`
- separated limits guidance for documented signals, observed artifact behavior, and practical operator guidance

What is removed where practical:

- docs navigation chrome
- footer junk
- duplicated table-of-contents text
- edit/helpful UI fragments

What is not true yet:

- this is not a full Browser Rendering corpus
- this is not an automated ingestion framework
- this does not cover every endpoint page yet
- this is grounded retrieval/training input for `blprnt`, not model fine-tuning

Example use case:

- existing successful local crawl JSON: a previously completed Browser Rendering crawl saved under your ignored local outputs
- next step: point `--reuse-file` at that saved JSON and continue building the first agent bundle from `outputs/browser-rendering/raw/real/latest.json`

## Mock and test output isolation

The real output directory is reserved for real runs only.

- real output path: `outputs/browser-rendering/raw/real/`
- mock output path: `outputs/browser-rendering/raw/mock/`
- optional mock/test run: `node scripts/run-browser-rendering-crawl.mjs --output-kind mock`

If a stubbed run returns a fake job id like `job-123`, the script now rejects it for the real path instead of quietly writing nonsense into the artifact you actually need.

## Troubleshooting-only manual API flow

Manual API calls are backup tools, not the main docs path. Use them only if the local runner is broken and needs diagnosis.

## Exact crawl scope

- source: `links`
- include: `https://developers.cloudflare.com/browser-rendering/**`
- exclude: `**/changelog/**`
- exclude: `**/pricing/**`
- limit: `60`
- depth: `2`
- formats: `markdown`
- render: `false`

## Expected behavior

Good answers should:

- stay grounded in Browser Rendering docs
- answer `/crawl`, `/json`, `/scrape`, and training workflow questions directly
- choose the right endpoint when asked to compare workflows
- avoid claiming unsupported features or undocumented behavior
- say when the docs do not support an answer instead of making things up

## Demo/eval organization

`evals/browser-rendering-v1.json` is split into:

- `demo`: simple representative prompts
- `evals`: prompts with concrete pass criteria

Keep it small. Bloat is how repos become landfill.

## Local test harness

Use the shipped harness when you want a real local run against the reviewed bundle instead of pretending the JSON files will test themselves.

### Model env

Set these locally in the environment, `.env`, or a throwaway ignored file like `.env.openrouter.test`:

```env
OPENAI_API_KEY=YOUR_OPENAI_API_KEY_HERE
# optional
OPENAI_MODEL=gpt-4.1-mini
OPENAI_BASE_URL=https://api.openai.com/v1
```

### Single prompt mode

```bash
node scripts/test-agent.mjs --prompt "Explain when to use the Browser Rendering /crawl endpoint and what output shape a user should expect from the docs."
```

Local-only throwaway env-file path:

```bash
node scripts/test-agent.mjs --env-file .env.openrouter.test --prompt "Explain when to use the Browser Rendering /crawl endpoint and what output shape a user should expect from the docs."
```

### Eval mode

```bash
node scripts/test-agent.mjs --eval
```

### Stress eval mode

```bash
node scripts/test-agent.mjs --env-file C:\absolute\path\to\.env.openrouter.test --eval --eval-file C:\absolute\path\to\evals\browser-rendering-stress-v1.json
```

What it does:

- loads `agent/cloudflare-browser-rendering-agent.json`
- loads `knowledge/index.json` and every referenced knowledge file
- loads `evals/browser-rendering-v1.json` by default or another file via `--eval-file`
- sends one direct OpenAI-compatible chat completion request per prompt
- writes the eval output file immediately to `outputs/browser-rendering/tests/` and updates it after each completed prompt
- when `--env-file` is passed, loads that file explicitly for the test run
- fails clearly if `OPENAI_API_KEY` is missing from the environment, local `.env`, or the explicit env file
- partial eval files expose `status`, `summary.completed`, `summary.passed`, `summary.failed`, `summary.remaining`, and `lastCompletedId` for timeout inspection