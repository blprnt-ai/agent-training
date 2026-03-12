import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const envPath = path.join(repoRoot, '.env');
const crawlScopePath = path.join(repoRoot, 'config', 'crawl-scope.json');
const args = parseArgs(process.argv.slice(2));
const outputKind = args.outputKind === 'mock' ? 'mock' : 'real';
const reuseFilePath = args.reuseFile ? path.resolve(process.cwd(), args.reuseFile) : null;
const outputDir = path.resolve(
  repoRoot,
  outputKind === 'mock' ? 'outputs/browser-rendering/raw/mock' : 'outputs/browser-rendering/raw/real',
);

loadDotEnv(envPath);

let token = process.env.CLOUDFLARE_API_TOKEN;
let accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const sourceUrl = 'https://developers.cloudflare.com/browser-rendering/';

if (!reuseFilePath && outputKind === 'mock' && (!token || !accountId)) {
  token = token || 'mock-token';
  accountId = accountId || 'mock-account';
}

if (!reuseFilePath && (!token || !accountId)) {
  console.error('Missing CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID. Add them to the environment or a local .env file.');
  process.exit(1);
}

mkdirSync(outputDir, { recursive: true });
const output = reuseFilePath
  ? getReusedOutput({ repoRoot, outputDir, reuseFilePath })
  : await createCrawlOutput({ accountId, crawlScopePath, outputDir, repoRoot, sourceUrl, token });

validateOutputForDirectory(output, outputKind);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outputPath = path.join(outputDir, `browser-rendering-crawl-${timestamp}.json`);
const latestPath = path.join(outputDir, 'latest.json');

writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
writeFileSync(latestPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

console.log(`Saved ${outputKind} crawl output to ${path.relative(repoRoot, outputPath).replace(/\\/g, '/')}`);

async function createCrawlOutput({ accountId, crawlScopePath, outputDir, repoRoot, sourceUrl, token }) {
  const scope = JSON.parse(readFileSync(crawlScopePath, 'utf8'));
  const payload = {
    url: sourceUrl,
    source: scope.source || 'links',
    limit: scope.limit ?? 60,
    depth: scope.depth ?? 2,
    formats: Array.isArray(scope.formats) ? scope.formats : [scope.format || 'markdown'],
    render: scope.render ?? false,
    options: {},
  };

  if (Array.isArray(scope.include) && scope.include.length > 0) {
    payload.options.includePatterns = scope.include;
  }

  if (Array.isArray(scope.exclude) && scope.exclude.length > 0) {
    payload.options.excludePatterns = scope.exclude;
  }

  if (Object.keys(payload.options).length === 0) {
    delete payload.options;
  }

  const createResponse = await apiFetch(`/accounts/${accountId}/browser-rendering/crawl`, {
    method: 'POST',
    token,
    body: payload,
  });

  const jobId = getCrawlJobId(createResponse);

  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('Crawl job did not return a job id.');
  }

  const statusUrl = `/accounts/${accountId}/browser-rendering/crawl/${jobId}?limit=1`;
  let statusResponse = null;

  for (;;) {
    statusResponse = await pollCrawlStatus(statusUrl, token);
    const status = statusResponse?.result?.status;

    if (status && status !== 'running') {
      break;
    }

    await sleep(5000);
  }

  const pages = [];
  let cursor = null;

  do {
    const query = cursor === null ? '' : `?cursor=${encodeURIComponent(String(cursor))}`;
    const page = await apiFetch(`/accounts/${accountId}/browser-rendering/crawl/${jobId}${query}`, {
      method: 'GET',
      token,
    });

    pages.push(page);
    cursor = page?.result?.cursor ?? null;
  } while (cursor !== null && cursor !== undefined);

  return {
    sourceUrl,
    outputDir: path.relative(repoRoot, outputDir).replace(/\\/g, '/'),
    requestedAt: new Date().toISOString(),
    payload,
    jobId,
    createResponse,
    statusResponse,
    pages,
  };
}

function getReusedOutput({ repoRoot, outputDir, reuseFilePath }) {
  const reusedOutput = JSON.parse(readFileSync(reuseFilePath, 'utf8'));
  const jobId = getOutputJobId(reusedOutput);

  return {
    ...reusedOutput,
    ...(jobId ? { jobId } : {}),
    outputDir: path.relative(repoRoot, outputDir).replace(/\\/g, '/'),
    reusedFrom: reuseFilePath,
    reusedAt: new Date().toISOString(),
  };
}

function validateOutputForDirectory(output, outputKind) {
  const jobId = getOutputJobId(output);

  if (typeof jobId !== 'string' || !jobId) {
    throw new Error('Crawl output is missing a jobId.');
  }

  if (outputKind === 'real' && !isUuid(jobId)) {
    throw new Error(`Refusing to write mock or malformed crawl output into outputs/browser-rendering/raw/real: ${jobId}`);
  }
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function parseArgs(argv) {
  const parsed = { outputKind: 'real', reuseFile: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--output-kind') {
      parsed.outputKind = argv[index + 1] || parsed.outputKind;
      index += 1;
      continue;
    }

    if (arg === '--reuse-file') {
      parsed.reuseFile = argv[index + 1] || null;
      index += 1;
    }
  }

  return parsed;
}

function loadDotEnv(filePath) {
  if (!existsSync(filePath)) {
    return;
  }

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

    if (!key || process.env[key]) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

function getCrawlJobId(createResponse) {
  const result = createResponse?.result;

  if (typeof result === 'string') {
    return result;
  }

  if (result && typeof result === 'object') {
    if (typeof result.id === 'string' && result.id) {
      return result.id;
    }

    if (typeof result.jobId === 'string' && result.jobId) {
      return result.jobId;
    }
  }

  return null;
}

function getOutputJobId(output) {
  if (typeof output?.jobId === 'string' && output.jobId) {
    return output.jobId;
  }

  const directJobId = getCrawlJobId(output);

  if (typeof directJobId === 'string' && directJobId) {
    return directJobId;
  }

  return getCrawlJobId(output?.createResponse);
}

async function pollCrawlStatus(statusUrl, token) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return await apiFetch(statusUrl, { method: 'GET', token });
    } catch (error) {
      if (!isTransientCrawlNotFound(error) || attempt === 4) {
        throw error;
      }

      await sleep(1000 * (attempt + 1));
    }
  }
}

function isTransientCrawlNotFound(error) {
  return error instanceof Error
    && error.message.includes('404 Not Found')
    && error.message.includes('Crawl job not found');
}

async function apiFetch(apiPath, { method, token, body }) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  const json = text ? JSON.parse(text) : null;

  if (!response.ok || json?.success === false) {
    throw new Error(`Cloudflare API request failed: ${response.status} ${response.statusText} ${text}`);
  }

  return json;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}