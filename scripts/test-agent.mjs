import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const args = parseArgs(process.argv.slice(2));
const envPath = resolveEnvPath(args.envFile);

loadDotEnv(envPath, { override: Boolean(args.envFile) });

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  if (!args.prompt && !args.eval) {
    throw new Error('Usage: node scripts/test-agent.mjs [--env-file .env.openrouter.test] --prompt "..." | --eval [--eval-file evals/browser-rendering-stress-v1.json]');
  }

  const provider = resolveProvider();
  const outputDir = path.join(repoRoot, 'outputs', 'browser-rendering', 'tests');

  const agent = readJson(path.join(repoRoot, 'agent', 'cloudflare-browser-rendering-agent.json'));
  const knowledgeIndex = readJson(path.join(repoRoot, 'knowledge', 'index.json'));
  const crawlScope = readJson(path.join(repoRoot, 'config', 'crawl-scope.json'));
  const envExample = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const setupUsage = readFileSync(path.join(repoRoot, 'docs', 'setup-and-usage.md'), 'utf8');
  const knowledgeDocs = knowledgeIndex.artifacts.map((artifact) => readJson(path.join(repoRoot, artifact.path)));
  const knowledgeDocsById = new Map(knowledgeDocs.map((doc) => [doc.id, doc]));
  const evalFilePath = resolveEvalFilePath(args.evalFile);
  const evals = readJson(evalFilePath);
  const sharedContext = buildSharedContext({
    agent,
    knowledgeIndex,
    crawlScope,
    envExample,
    setupUsage,
  });

  mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  if (args.prompt) {
    const response = await runPrompt({
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      extraHeaders: provider.extraHeaders,
      sharedContext,
      knowledgeDocsById,
      model: provider.model,
      prompt: args.prompt,
    });
    const output = {
      mode: 'single-prompt',
      provider: provider.name,
      model: provider.model,
      prompt: args.prompt,
      response,
      generatedAt: new Date().toISOString(),
    };
    const outputPath = path.join(outputDir, `single-prompt-${timestamp}.json`);
    writeJson(outputPath, output);
    console.log(JSON.stringify({ ok: true, mode: output.mode, outputPath: toRepoPath(outputPath) }, null, 2));
    return;
  }

  const evalFileSlug = path.basename(evalFilePath, path.extname(evalFilePath)).replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const outputPath = path.join(outputDir, `eval-${evalFileSlug}-${timestamp}.json`);
  const runState = createEvalRunState({
    evalFilePath,
    outputPath,
    provider,
    total: evals.evals.length,
  });
  const unregisterShutdownHandlers = registerEvalShutdownHandlers(runState, outputPath);

  writeJson(outputPath, runState);

  try {
    for (const evaluation of evals.evals) {
      const response = await runPrompt({
        apiKey: provider.apiKey,
        baseUrl: provider.baseUrl,
        extraHeaders: provider.extraHeaders,
        sharedContext,
        knowledgeDocsById,
        model: provider.model,
        prompt: evaluation.prompt,
      });
      const checks = scoreEvaluation(response, evaluation);
      runState.results.push({
        id: evaluation.id,
        prompt: evaluation.prompt,
        response,
        ...checks,
      });
      updateEvalRunState(runState, { status: 'running', lastCompletedId: evaluation.id });
      writeJson(outputPath, runState);
    }
  } catch (error) {
    updateEvalRunState(runState, {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      finishedAt: new Date().toISOString(),
    });
    writeJson(outputPath, runState);
    unregisterShutdownHandlers();
    throw error;
  }

  updateEvalRunState(runState, {
    status: 'completed',
    finishedAt: new Date().toISOString(),
    generatedAt: new Date().toISOString(),
  });
  writeJson(outputPath, runState);
  unregisterShutdownHandlers();
  console.log(JSON.stringify({ ok: true, mode: runState.mode, summary: runState.summary, outputPath: toRepoPath(outputPath) }, null, 2));
}

function createEvalRunState({ evalFilePath, outputPath, provider, total }) {
  const startedAt = new Date().toISOString();

  return {
    mode: 'eval',
    status: 'running',
    evalFile: toRepoPath(evalFilePath),
    outputPath: toRepoPath(outputPath),
    provider: provider.name,
    model: provider.model,
    summary: {
      total,
      completed: 0,
      passed: 0,
      failed: 0,
      remaining: total,
    },
    results: [],
    startedAt,
    updatedAt: startedAt,
  };
}

function updateEvalRunState(runState, updates = {}) {
  const completed = runState.results.length;
  const passed = runState.results.filter((result) => result.pass).length;
  const failed = completed - passed;

  runState.status = updates.status || runState.status;
  runState.summary = {
    total: runState.summary.total,
    completed,
    passed,
    failed,
    remaining: runState.summary.total - completed,
  };
  runState.updatedAt = new Date().toISOString();

  if (updates.lastCompletedId) {
    runState.lastCompletedId = updates.lastCompletedId;
  }

  if (Object.prototype.hasOwnProperty.call(updates, 'error')) {
    runState.error = updates.error;
  }

  if (updates.finishedAt) {
    runState.finishedAt = updates.finishedAt;
  }

  if (updates.generatedAt) {
    runState.generatedAt = updates.generatedAt;
  }
}

function registerEvalShutdownHandlers(runState, outputPath) {
  let finalized = false;

  const handleSignal = (signal) => {
    if (finalized) {
      return;
    }

    finalized = true;
    updateEvalRunState(runState, {
      status: 'interrupted',
      error: `Interrupted by ${signal}`,
      finishedAt: new Date().toISOString(),
    });
    writeJson(outputPath, runState);
    process.exit(1);
  };

  const sigintHandler = () => handleSignal('SIGINT');
  const sigtermHandler = () => handleSignal('SIGTERM');

  process.once('SIGINT', sigintHandler);
  process.once('SIGTERM', sigtermHandler);

  return () => {
    finalized = true;
    process.off('SIGINT', sigintHandler);
    process.off('SIGTERM', sigtermHandler);
  };
}

function resolveProvider() {
  const openRouterApiKey = process.env.OPENROUTER_API_KEY;

  if (openRouterApiKey) {
    return {
      name: 'openrouter',
      apiKey: openRouterApiKey,
      model: process.env.OPENROUTER_MODEL || process.env.OPENAI_MODEL || 'openai/gpt-4.1-mini',
      baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
      extraHeaders: {
        'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://github.com/blprnt-ai/agent-training',
        'X-Title': process.env.OPENROUTER_APP_NAME || 'Cloudflare Browser Rendering Agent Harness',
      },
    };
  }

  const openAiApiKey = process.env.OPENAI_API_KEY;

  if (openAiApiKey) {
    return {
      name: 'openai-compatible',
      apiKey: openAiApiKey,
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      baseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
      extraHeaders: {},
    };
  }

  throw new Error('Missing model credentials. Set OPENROUTER_API_KEY or OPENAI_API_KEY in the environment or a local .env file.');
}

function parseArgs(argv) {
  const parsed = { prompt: '', eval: false, envFile: '', evalFile: '' };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--env-file') {
      parsed.envFile = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--prompt') {
      parsed.prompt = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--eval-file') {
      parsed.evalFile = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (arg === '--eval') {
      parsed.eval = true;
    }
  }

  return parsed;
}

function resolveEnvPath(envFile) {
  if (!envFile) {
    return path.join(repoRoot, '.env');
  }

  const resolvedPath = path.resolve(envFile);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Env file not found: ${envFile}`);
  }

  return resolvedPath;
}

function resolveEvalFilePath(evalFile) {
  if (!evalFile) {
    return path.join(repoRoot, 'evals', 'browser-rendering-v1.json');
  }

  const resolvedPath = path.resolve(evalFile);

  if (!existsSync(resolvedPath)) {
    throw new Error(`Eval file not found: ${evalFile}`);
  }

  return resolvedPath;
}

function buildSharedContext({ agent, knowledgeIndex, crawlScope, envExample, setupUsage }) {
  const sections = [
    `Agent name: ${agent.name}`,
    `Description: ${agent.description}`,
    `Focus topics: ${agent.focusTopics.join(', ')}`,
    `Scope limitations: ${agent.scopeLimitations.join(' ')}`,
    `Tested coverage: ${agent.testedCoverage.join(', ')}`,
    `Knowledge bundle: ${knowledgeIndex.bundle} (${knowledgeIndex.version})`,
    [
      'Exact crawl scope:',
      `source: ${crawlScope.source}`,
      `include: ${crawlScope.include.join(', ')}`,
      `exclude: ${crawlScope.exclude.join(', ')}`,
      `limit: ${crawlScope.limit}`,
      `depth: ${crawlScope.depth}`,
      `formats: ${crawlScope.formats.join(', ')}`,
      `render: ${String(crawlScope.render)}`,
    ].join('\n'),
    [
      'Secret handling:',
      'Use environment variables only.',
      'Copy .env.example to .env locally.',
      'Do not commit real secrets.',
      'Relevant local env template:',
      envExample.trim(),
    ].join('\n'),
    [
      'Operator guidance:',
      extractSection(setupUsage, '## Cost and limits', '## Files to use'),
      extractSection(setupUsage, '## Exact crawl scope', '## Expected behavior'),
      extractSection(setupUsage, '## Safe secret handling', '## Primary workflow'),
      extractSection(setupUsage, '## Expected behavior', '## Demo/eval organization'),
    ].join('\n\n'),
  ];

  return sections.join('\n\n');
}

function extractSection(markdown, startHeading, endHeading) {
  const start = markdown.indexOf(startHeading);

  if (start === -1) {
    return '';
  }

  const end = markdown.indexOf(endHeading, start + startHeading.length);
  const section = end === -1 ? markdown.slice(start) : markdown.slice(start, end);
  return section.trim();
}

async function runPrompt({ apiKey, baseUrl, extraHeaders, sharedContext, knowledgeDocsById, model, prompt }) {
  const groundingContext = buildPromptContext({ sharedContext, knowledgeDocsById, prompt });
  const promptControls = buildPromptControls(prompt);
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: [
            'You are testing a grounded agent bundle.',
            'Answer using only the supplied repo context.',
            'If the context does not support a claim, say that directly and do not invent details.',
            'If the docs do not provide an exact number, say exactly: The docs do not provide an exact number. Do not invent it.',
            'For secret handling, say local .env and do not commit.',
            'For reuse-first guidance, prefer the wording reuse an existing successful crawl artifact when it fits.',
            'Use this exact response shape: Answer:, Evidence:, optional Why:, Boundary:.',
            'Keep the answer concise and deterministic.',
            'Do not compare endpoints unless the question asks for comparison, choice, or confusion resolution.',
            'For binary-choice or one-endpoint prompts, answer with only the correct endpoint and minimal reason; do not mention excluded endpoints unless the question explicitly asks for comparison.',
            'Do not echo bait phrasing from the prompt when a clean positive phrasing works.',
            promptControls.systemInstruction,
          ].join(' '),
        },
        {
          role: 'user',
          content: `Repo context:\n${groundingContext}\n\nQuestion:\n${prompt}`,
        },
      ],
    }),
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(`Model request failed: ${response.status} ${response.statusText} ${text}`);
  }

  const content = json?.choices?.[0]?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const joined = content
      .map((item) => item?.text || item?.content || '')
      .join('')
      .trim();

    if (joined) {
      return joined;
    }
  }

  throw new Error(`Model response did not include message content: ${text}`);
}

function buildPromptContext({ sharedContext, knowledgeDocsById, prompt }) {
  const docs = selectKnowledgeDocs({ knowledgeDocsById, prompt });
  const sections = [sharedContext];

  for (const doc of docs) {
    sections.push(formatKnowledgeDoc(doc));
  }

  return sections.join('\n\n');
}

function selectKnowledgeDocs({ knowledgeDocsById, prompt }) {
  const normalizedPrompt = normalize(prompt);
  const selectedIds = new Set(['browser-rendering-answer-policy-v1']);
  const promptClass = classifyPrompt(normalizedPrompt);
  const binaryEndpointPrompt = promptClass === 'selection-binary';

  if (matchesAny(normalizedPrompt, ['credential', 'credentials', 'token', 'secret', 'api key', '.env', 'environment variable', 'commit'])) {
    selectedIds.add('browser-rendering-overview-v1');
  }

  if (matchesAny(normalizedPrompt, ['limit', 'limits', 'timeout', 'concurrency', 'ceiling', 'ceilings', 'account', 'browser acquisition'])) {
    selectedIds.add('browser-rendering-limits-v1');
  }

  if (matchesAny(normalizedPrompt, ['crawl', 'multi-page', 'site-wide', 'site wide', 'artifact', 'poll', 'job'])) {
    selectedIds.add('browser-rendering-crawl-v1');
  }

  if (matchesAny(normalizedPrompt, ['/json', ' json ', 'schema', 'structured', 'typed fields', 'typed', 'json_schema', 'response_format'])) {
    selectedIds.add('browser-rendering-json-v1');
  }

  if (matchesAny(normalizedPrompt, ['scrape', 'selector', 'selectors', 'css-selected', 'css selected', 'one page', 'elements', 'html', 'attributes'])) {
    selectedIds.add('browser-rendering-scrape-v1');
  }

  if (promptClass === 'comparison') {
    selectedIds.add('browser-rendering-endpoint-selection-v1');
    selectedIds.add('browser-rendering-crawl-v1');
    selectedIds.add('browser-rendering-json-v1');
    selectedIds.add('browser-rendering-scrape-v1');
  }

  if (binaryEndpointPrompt) {
    if (normalizedPrompt.includes('/crawl')) {
      selectedIds.add('browser-rendering-crawl-v1');
    }

    if (normalizedPrompt.includes('/json')) {
      selectedIds.add('browser-rendering-json-v1');
    }

    if (normalizedPrompt.includes('/scrape')) {
      selectedIds.add('browser-rendering-scrape-v1');
    }
  }

  if (matchesAny(normalizedPrompt, ['scope', 'coverage', 'fine-tune', 'fine tune', 'fine-tuning', 'fine tuning', 'supported claim', 'does not support', 'grounded'])) {
    selectedIds.add('browser-rendering-overview-v1');
  }

  if (selectedIds.size === 1) {
    selectedIds.add('browser-rendering-overview-v1');
  }

  return Array.from(selectedIds)
    .map((id) => knowledgeDocsById.get(id))
    .filter(Boolean);
}

function buildPromptControls(prompt) {
  const normalizedPrompt = normalize(prompt);
  const promptClass = classifyPrompt(normalizedPrompt);
  const instructionParts = [`Prompt class: ${promptClass}.`];

  if (promptClass === 'comparison') {
    instructionParts.push('Map each requested job to its endpoint directly. Comparison is allowed because the prompt asked for it.');
  }

  if (promptClass === 'selection-binary' || promptClass === 'selection-single') {
    instructionParts.push('Selection mode. Name only the chosen endpoint in Answer:. Do not mention rejected endpoints anywhere unless the prompt explicitly asks for comparison.');
    instructionParts.push('Use evidence from the chosen endpoint or repo policy only.');
  }

  if (promptClass === 'policy') {
    instructionParts.push('Policy mode. Prefer canonical repo phrasing exactly where it fits: local .env, do not commit, reuse an existing successful crawl artifact, The docs do not provide an exact number. Do not invent it.');
  }

  if (matchesAny(normalizedPrompt, ['crawl artifact', 'crawl artifact does this bundle point to', 'returned records', 'records be described', 'broad documentation capture', 'multi-page content acquisition', 'collecting many pages'])) {
    instructionParts.push('When describing /crawl output records grounded in the local artifact, include the word markdown.');
  }

  if (matchesAny(normalizedPrompt, ['metered', 'budget', 'create calls', 'create call', 'reuse-first', 'reuse first', 'successful crawl on disk'])) {
    instructionParts.push('When answering reuse-first cost guidance, include the word metered and recommend reuse an existing successful crawl artifact first.');
  }

  if (matchesAny(normalizedPrompt, ['typed', 'schema-shaped', 'schema shaped', 'downstream code can trust', 'must follow a schema', 'structured output'])) {
    instructionParts.push('When answering /json schema extraction prompts, include the word typed and mention response_format with json_schema when relevant.');
  }

  if (promptClass === 'scope') {
    instructionParts.push('Scope mode. State that this is a narrow first-pass grounded bundle and do not imply full product coverage.');
  }

  if (matchesAny(normalizedPrompt, ['local .env', '.env', 'token', 'tokens', 'secret', 'secrets', 'credential', 'credentials', 'commit'])) {
    instructionParts.push('Use the exact phrase local .env. Use the exact phrase do not commit.');
  }

  if (matchesAny(normalizedPrompt, ['one page', 'single page', 'single rendered page', 'one rendered page'])) {
    instructionParts.push('Use the exact phrase one page.');
  }

  if (matchesAny(normalizedPrompt, ['docs do not provide', 'do not confirm', 'cannot substantiate', 'does not support', 'undocumented', 'limit number', 'ceiling'])) {
    instructionParts.push('When the docs do not support the claim or number, use the canonical refusal sentence exactly when it fits.');
  }

  return {
    promptClass,
    systemInstruction: instructionParts.join(' '),
  };
}

function classifyPrompt(normalizedPrompt) {
  if (isComparisonPrompt(normalizedPrompt)) {
    return 'comparison';
  }

  if (isBinaryEndpointPrompt(normalizedPrompt)) {
    return 'selection-binary';
  }

  if (isSingleEndpointSelectionPrompt(normalizedPrompt)) {
    return 'selection-single';
  }

  if (matchesAny(normalizedPrompt, ['credential', 'credentials', 'token', 'tokens', 'secret', 'secrets', 'api key', '.env', 'environment variable', 'commit', 'reuse', 'artifact', 'metered', 'limit-bound', 'limit bound', 'docs do not provide', 'do not confirm', 'does not support', 'undocumented', 'invent'])) {
    return 'policy';
  }

  if (matchesAny(normalizedPrompt, ['scope', 'coverage', 'fine-tune', 'fine tune', 'fine-tuning', 'fine tuning', 'grounded', 'full product coverage', 'first-pass', 'first pass'])) {
    return 'scope';
  }

  return 'default';
}

function isEndpointSelectionPrompt(normalizedPrompt) {
  const endpointMentions = ['/crawl', '/json', '/scrape'].filter((endpoint) => normalizedPrompt.includes(endpoint)).length;

  return endpointMentions >= 2
    || matchesAny(normalizedPrompt, ['compare', 'difference', 'differences', 'versus', 'vs', 'choose', 'choice', 'map each', 'which endpoint', 'right endpoint', 'confusing it with', 'or /scrape', 'or /json', 'or /crawl']);
}

function isComparisonPrompt(normalizedPrompt) {
  const endpointMentions = ['/crawl', '/json', '/scrape'].filter((endpoint) => normalizedPrompt.includes(endpoint)).length;

  return endpointMentions >= 3
    || matchesAny(normalizedPrompt, ['compare', 'difference', 'differences', 'versus', 'vs', 'map each', 'assign each', 'three jobs', 'three tasks', 'match the correct endpoint']);
}

function isBinaryEndpointPrompt(normalizedPrompt) {
  const endpointMentions = ['/crawl', '/json', '/scrape'].filter((endpoint) => normalizedPrompt.includes(endpoint)).length;

  return endpointMentions === 2
    && !matchesAny(normalizedPrompt, ['compare', 'difference', 'differences', 'map each', 'explain why both', 'all three']);
}

function isSingleEndpointSelectionPrompt(normalizedPrompt) {
  const endpointMentions = ['/crawl', '/json', '/scrape'].filter((endpoint) => normalizedPrompt.includes(endpoint)).length;

  return endpointMentions === 1
    && matchesAny(normalizedPrompt, ['which endpoint', 'right endpoint', 'fits', 'pick', 'use /crawl', 'use /json', 'use /scrape']);
}

function matchesAny(haystack, needles) {
  return needles.some((needle) => haystack.includes(normalize(needle)));
}

function formatKnowledgeDoc(doc) {
  return [
    `Title: ${doc.source?.title || doc.id}`,
    `Summary: ${doc.summary || ''}`,
    `Content: ${JSON.stringify(doc.content)}`,
  ].join('\n');
}

function scoreEvaluation(response, evaluation) {
  const haystack = normalizeForEval(response);
  const mustInclude = (evaluation.mustInclude || []).filter((item) => !haystack.includes(normalizeForEval(item)));
  const mustNotInclude = (evaluation.mustNotInclude || []).filter((item) => haystack.includes(normalizeForEval(item)));

  return {
    pass: mustInclude.length === 0 && mustNotInclude.length === 0,
    missingMustInclude: mustInclude,
    triggeredMustNotInclude: mustNotInclude,
  };
}

function normalize(value) {
  return String(value).toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizeForEval(value) {
  return normalize(value)
    .replace(/[`“”‘’]/g, '')
    .replace(/(?<=\w)-(?=\w)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function toRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replace(/\\/g, '/');
}

function loadDotEnv(filePath, options = {}) {
  if (!existsSync(filePath)) {
    return;
  }

  const { override = false } = options;

  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();

    if (!key || (!override && process.env[key])) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}
