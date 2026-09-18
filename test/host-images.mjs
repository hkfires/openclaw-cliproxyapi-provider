// End-to-end image capability checks against an isolated local CPA mock.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const state = await mkdtemp(join(tmpdir(), 'cpa-host-images-'));
const savedEnv = { ...process.env };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1kAAAAASUVORK5CYII=', 'base64');
const records = [];
let responseMode = 'base64';
let assetHits = 0;
let foreignHits = 0;
const foreign = createServer((_req, res) => { foreignHits++; res.end(png); });
const server = createServer(async (req, res) => {
  if (req.url === '/image.png') {
    assetHits++;
    records.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader('Content-Type', 'image/png'); res.end(png); return;
  }
  if (req.headers.authorization !== 'Bearer mock-key') { res.writeHead(401); res.end(); return; }
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/proxy/v1/models?client_version=openclaw') {
    res.end(JSON.stringify({ data: [
      { id: 'gpt-4o' }, { id: 'gpt-image-2', visibility: 'hide' },
      { id: 'grok-imagine-image', visibility: 'hide' }, { id: 'grok-imagine-video', visibility: 'hide' },
    ] })); return;
  }
  if (!['/proxy/v1/images/generations', '/proxy/v1/images/edits'].includes(req.url)) { res.writeHead(404); res.end(); return; }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  records.push({ path: req.url, contentType: req.headers['content-type'], body });
  if (responseMode === 'slow') return;
  if (responseMode === 'error') { res.writeHead(500); res.end(JSON.stringify({ error: { message: 'expected mock failure' } })); return; }
  if (responseMode === 'redirect') { res.writeHead(307, { Location: `http://127.0.0.1:${foreign.address().port}/leak` }); res.end(); return; }
  if (responseMode === 'foreign-blocked') { res.end(JSON.stringify({ data: [{ url: 'https://blocked.example/image.png' }] })); return; }
  if (responseMode === 'foreign-private') { res.end(JSON.stringify({ data: [{ url: `http://127.0.0.1:${foreign.address().port}/image.png` }] })); return; }
  res.end(JSON.stringify({ data: [responseMode === 'url'
    ? { url: `http://127.0.0.1:${server.address().port}/image.png` }
    : { b64_json: png.toString('base64') }] }));
});
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve));
  for (const key of Object.keys(process.env)) if (/^(CLIPROXYAPI_|CPA_|OPENCLAW_)/.test(key)) delete process.env[key];
  Object.assign(process.env, { OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json') });
  const { createAuthMethod } = await import('../dist/setup-entry.js');
  const { buildImageGenerationProvider } = await import('../dist/image-generation.js');
  const { saveConfigFile } = await import('../dist/lib.js');
  const { SsrFBlockedError, GuardedFetchRedirectError } = await import('openclaw/plugin-sdk/ssrf-runtime');
  const dist = resolve('node_modules/openclaw/dist');
  const file = (await readdir(dist)).find(name => /^provider-auth-choice-helpers-.*\.mjs$/.test(name));
  const { n: mergeAuthPatch } = await import(pathToFileURL(join(dist, file)).href);
  const baseUrl = `http://127.0.0.1:${server.address().port}/proxy`;
  let config = {
    agents: { defaults: {
      model: { primary: 'cliproxyapi/gpt-4o' },
      imageModel: { primary: 'cliproxyapi/gpt-4o' },
      mediaModels: { video: { primary: 'other/video' } },
    } },
    // Explicit opt-in for the local mock only; never a production default.
    browser: { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } },
    plugins: { allow: ['cliproxyapi'], load: { paths: [resolve('.')] }, entries: { cliproxyapi: { enabled: true } } },
  };
  const answers = [baseUrl, 'mock-key'];
  const result = await createAuthMethod(state, 'cliproxyapi').run({
    config,
    prompter: {
      text: async () => answers.shift(),
      select: async ({ options }) => options[0].value === '' ? 'gpt-image-2' : 'gpt-4o',
      multiselect: async () => [],
    },
  });
  config = mergeAuthPatch(config, result.configPatch);
  assert.deepEqual(config.agents.defaults.mediaModels.image, { primary: 'cliproxyapi/gpt-image-2', fallbacks: [] });
  assert.deepEqual(config.agents.defaults.imageModel, { primary: 'cliproxyapi/gpt-4o' });
  assert.deepEqual(config.agents.defaults.mediaModels.video, { primary: 'other/video' });
  assert.equal(config.agents.defaults.models, undefined);
  assert.equal(config.models, undefined);
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  const agentDir = join(state, 'agents/main/agent');
  // The host keeps SQLite auth handles open. Seed profiles in a short-lived child
  // so Windows can remove the isolated database after all CLI checks finish.
  await exec(process.execPath, ['--input-type=module', '-e',
    'import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth"; for (const profile of JSON.parse(process.argv[1])) upsertAuthProfile({ ...profile, agentDir: process.argv[2] });',
    JSON.stringify(result.profiles), agentDir,
  ], { env: { ...process.env }, timeout: 30000 });
  const cli = resolve('node_modules/openclaw/openclaw.mjs');
  async function run(...args) {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { env: { ...process.env }, timeout: 90000, maxBuffer: 8 * 1024 * 1024 });
    if (stderr) console.error(stderr);
    return stdout;
  }
  await run('config', 'validate');
  const inspection = JSON.parse(await run('plugins', 'inspect', 'cliproxyapi', '--runtime', '--json'));
  assert.deepEqual(inspection.plugin.imageGenerationProviderIds, ['cliproxyapi']);
  // No API-key environment variable or plugin-file key: use the persisted auth profile.
  for (const id of ['cliproxyapi', 'cpa']) {
    const output = join(state, `${id}.png`);
    const result = JSON.parse(await run('infer', 'image', 'generate', '--model', `${id}/gpt-image-2`, '--prompt', 'mock generation', '--quality', 'high', '--output-format', 'jpeg', '--background', 'opaque', '--output', output, '--json'));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.deepEqual(await readFile(output), png);
    const posted = JSON.parse(records.at(-1).body);
    assert.equal(posted.model, 'gpt-image-2');
    assert.equal(posted.response_format, 'b64_json');
    assert.equal(posted.quality, 'high');
    assert.equal(posted.output_format, 'jpeg');
    assert.equal(posted.background, 'opaque');
  }
  await run('infer', 'image', 'generate', '--model', 'cpa/gpt-image-1.5', '--prompt', 'mock transparent', '--background', 'transparent', '--output', join(state, 'transparent.png'), '--json');
  assert.equal(JSON.parse(records.at(-1).body).background, 'transparent');
  responseMode = 'url';
  const edited = join(state, 'edited.png');
  const edit = JSON.parse(await run('infer', 'image', 'edit', '--model', 'cpa/grok-imagine-image', '--prompt', 'mock edit', '--file', join(state, 'cpa.png'), '--output', edited, '--json'));
  assert.equal(edit.ok, true, JSON.stringify(edit));
  assert.deepEqual(await readFile(edited), png);
  const editRequest = records.find(record => record.path.endsWith('/edits'));
  assert.match(editRequest.contentType, /^multipart\/form-data; boundary=/);
  assert.ok(editRequest.body.includes('grok-imagine-image'));
  assert.ok(editRequest.body.includes('name="image"'));
  assert.equal(assetHits, 1);
  assert.equal(records.at(-1).authorization, undefined);

  config.agents.defaults.mediaModels.image = { primary: 'cpa/gpt-image-2', fallbacks: [] };
  await writeFile(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
  responseMode = 'error';
  const requestsBeforeFailure = records.filter(record => record.path.endsWith('/generations')).length;
  await assert.rejects(run('infer', 'image', 'generate', '--prompt', 'expected failure', '--output', join(state, 'failure.png'), '--json'));
  const requestsAfterFailure = records.filter(record => record.path.endsWith('/generations')).length;
  assert.equal(requestsAfterFailure - requestsBeforeFailure, 1, 'an alias must not retry the same paid backend');
  responseMode = 'base64';

  const aliasProvider = buildImageGenerationProvider(state, 'cliproxyapi', ['cpa']);
  const aliasOnlyCfg = {
    ...config,
    models: { providers: { cpa: { baseUrl: `${baseUrl}/v1`, apiKey: 'mock-key', api: 'openai-responses', models: [] } } },
  };
  const aliasResult = await aliasProvider.generateImage({
    provider: 'cpa', model: 'gpt-image-2', prompt: 'alias config auth', cfg: aliasOnlyCfg,
    authStore: { version: 1, profiles: {} },
  });
  assert.deepEqual(aliasResult.images[0].buffer, png);

  // Exercise real DNS/SSRF checks and redirect refusal with the same implementation.
  saveConfigFile(state, { apiKey: 'mock-key' });
  const provider = buildImageGenerationProvider(state, 'cpa');
  const req = { provider: 'cpa', model: 'gpt-image-2', prompt: 'security test', cfg: config };
  await assert.rejects(provider.generateImage({ ...req, cfg: {} }), SsrFBlockedError);
  responseMode = 'foreign-private';
  await assert.rejects(provider.generateImage(req), SsrFBlockedError);
  assert.equal(foreignHits, 0);
  responseMode = 'foreign-blocked';
  await assert.rejects(provider.generateImage({ ...req, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true, blockedHostnames: ['blocked.example'] } }), SsrFBlockedError);
  await assert.rejects(provider.generateImage({ ...req, ssrfPolicy: { dangerouslyAllowPrivateNetwork: true, hostnameAllowlist: ['127.0.0.1'] } }), SsrFBlockedError);
  responseMode = 'redirect';
  await assert.rejects(provider.generateImage(req), GuardedFetchRedirectError);
  assert.equal(foreignHits, 0);
  responseMode = 'slow';
  await assert.rejects(provider.generateImage({ ...req, timeoutMs: 100 }), { name: /^(TimeoutError|AbortError)$/ });
  console.log('PASS: real host image generation/edit via CPA, auth-profile alias reuse, config preservation, URL download, SSRF/redirect refusal, and timeout');
} finally {
  server.closeAllConnections(); foreign.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => foreign.close(resolve))]);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
