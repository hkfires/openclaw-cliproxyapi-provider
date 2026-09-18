// Isolated host smoke test. Run with a Node version supported by OpenClaw.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { buildProviderRegistration } from '../dist/index.js';
import { createAuthMethod } from '../dist/setup-entry.js';

const exec = promisify(execFile);
const state = await mkdtemp(join(tmpdir(), 'cpa-host-'));
const rows = [
  { id: 'gpt-image-2', visibility: 'hide', input_modalities: ['text'] },
  { id: 'smoke-model', context_window: 128000 },
  { id: 'backup-model' },
  { id: 'gemini-3.1-flash-image', visibility: 'list', input_modalities: ['text', 'image'] },
  { id: 'grok-imagine-video', visibility: 'hide' },
];
let requests = 0;
const server = createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer smoke-key') { res.writeHead(401); res.end(); return; }
  if (req.url !== '/v1/models?client_version=openclaw') { res.writeHead(404); res.end(); return; }
  requests++;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ data: rows }));
});
const savedEnv = { ...process.env };
try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  // Isolate both in-process host imports and CLI subprocesses from user credentials/config.
  for (const key of Object.keys(process.env)) {
    if (/^(CLIPROXYAPI_|CPA_|OPENCLAW_)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: join(state, 'openclaw.json'),
    CLIPROXYAPI_API_KEY: 'smoke-key',
  });
  // Deliberately no base-URL environment override: inference must use saved settings.
  const env = { ...process.env };
  const cli = resolve('node_modules/openclaw/openclaw.mjs');
  // Exercise the pinned host's actual auth-patch merge, not a test imitation.
  const hostDist = resolve('node_modules/openclaw/dist');
  const helperFile = (await readdir(hostDist)).find(name => /^provider-auth-choice-helpers-.*\.mjs$/.test(name));
  assert.ok(helperFile, 'host auth-patch merger must be available');
  const { n: applyProviderAuthConfigPatch } = await import(pathToFileURL(join(hostDist, helperFile)).href);
  async function run(...args) {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      env, timeout: 90000, maxBuffer: 8 * 1024 * 1024,
    });
    if (stderr) console.error(stderr);
    return stdout;
  }
  const vision = { primary: 'openai/gpt-4o' };
  const media = { image: { primary: 'openai/gpt-image-2' } };
  const oldRoute = {
    baseUrl: 'http://127.0.0.1:1/v1', api: 'openai-responses',
    models: [{ id: 'manual-model', name: 'Manual model', contextWindow: 8192 }],
    headers: { 'X-Custom': 'keep' },
  };
  for (const legacy of [false, true]) {
    let config = {
      agents: { defaults: { imageModel: vision, mediaModels: media, models: { 'openai/gpt-4o': { alias: 'vision' } } } },
      plugins: { allow: ['cliproxyapi'], load: { paths: [resolve('.')] }, entries: { cliproxyapi: { enabled: true } } },
      ...(legacy ? { models: { providers: { cliproxyapi: oldRoute, cpa: oldRoute } } } : {}),
    };
    for (const id of ['cliproxyapi', 'cpa']) {
      const answers = [baseUrl, 'smoke-key'];
      const result = await createAuthMethod(state, id).run({
        config,
        prompter: {
          text: async () => answers.shift(),
          select: async ({ options }) => {
            if (options[0]?.value === '') return '';
            assert.deepEqual(options.map(option => option.value), ['smoke-model', 'backup-model']);
            return 'smoke-model';
          },
          multiselect: async ({ options }) => {
            assert.deepEqual(options.map(option => option.value), ['backup-model']);
            return ['backup-model'];
          },
        },
      });
      assert.equal(result.defaultModel, undefined);
      assert.equal(result.configPatch.agents.defaults.imageModel, undefined);
      assert.equal(result.configPatch.agents.defaults.mediaModels, undefined);
      config = applyProviderAuthConfigPatch(config, result.configPatch);
      assert.deepEqual(config.agents.defaults.imageModel, vision);
      assert.deepEqual(config.agents.defaults.mediaModels, media);
      assert.deepEqual(config.agents.defaults.model, {
        primary: `${id}/smoke-model`, fallbacks: [`${id}/backup-model`],
      });
      assert.equal(config.agents.defaults.models['openai/gpt-4o'].alias, 'vision');
      assert.deepEqual(config.agents.defaults.models[`${id}/smoke-model`], {});
      assert.deepEqual(config.agents.defaults.models[`${id}/backup-model`], {});
      if (legacy) {
        for (const routeId of ['cliproxyapi', 'cpa']) {
          const provider = config.models.providers[routeId];
          assert.equal(provider.baseUrl, `${baseUrl}/v1`);
          assert.deepEqual(provider.models.map(model => model.id), ['manual-model']);
          assert.deepEqual(provider.headers, oldRoute.headers);
        }
      } else {
        assert.equal(config.models, undefined);
      }
      const reg = buildProviderRegistration({ configDir: state, providerId: id });
      const model = reg.resolveDynamicModel({ modelId: 'smoke-model', providerConfig: config.models?.providers?.[id] });
      assert.equal(model.baseUrl, `${baseUrl}/v1`);
    }
    await writeFile(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
    await run('config', 'validate');
    const inspected = JSON.parse(await run('plugins', 'inspect', 'cliproxyapi', '--runtime', '--json'));
    assert.equal(inspected.plugin.status, 'loaded');
    assert.deepEqual(inspected.plugin.providerIds, ['cliproxyapi']);
    assert.deepEqual(inspected.plugin.imageGenerationProviderIds, ['cliproxyapi']);
    const beforeRefresh = requests;
    const models = JSON.parse(await run('models', 'list', '--refresh', '--all', '--provider', 'cliproxyapi', '--json'));
    const text = JSON.stringify(models);
    assert.ok(text.includes('cliproxyapi/smoke-model'), text);
    // The host preserves membership for an explicit non-empty legacy model list.
    // Updating its route must not replace that authored list with discovery rows.
    if (legacy) assert.ok(text.includes('cliproxyapi/manual-model'), text);
    else assert.ok(text.includes('cliproxyapi/gpt-image-2'), 'hidden model must remain discoverable');
    assert.ok(requests > beforeRefresh, 'real host must call discovery at the new address');
    const saved = JSON.parse(await readFile(env.OPENCLAW_CONFIG_PATH, 'utf8'));
    assert.deepEqual(saved.agents.defaults.imageModel, vision);
    assert.deepEqual(saved.agents.defaults.mediaModels, media);
  }
  console.log('PASS: host validates fresh/legacy auth patches, preserves vision/media settings, and discovers both catalogs at the updated URL');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(state, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}
