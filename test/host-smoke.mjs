// Isolated host smoke test. Run with a Node version supported by OpenClaw.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const state = await mkdtemp(join(tmpdir(), 'cpa-host-'));
let requests = 0;
const server = createServer((req,res)=>{
 if(req.headers.authorization !== 'Bearer smoke-key'){res.writeHead(401);res.end();return;}
 if(req.url !== '/v1/models?client_version=openclaw'){res.writeHead(404);res.end();return;}
 requests++;
 res.setHeader('Content-Type','application/json');
 res.end(JSON.stringify({data:[{id:'smoke-model',context_window:128000}]}));
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const env = {...process.env, OPENCLAW_STATE_DIR:state, OPENCLAW_CONFIG_PATH:join(state,'openclaw.json'), CLIPROXYAPI_BASE_URL:`http://127.0.0.1:${server.address().port}`, CLIPROXYAPI_API_KEY:'smoke-key'};
// Avoid unrelated user overrides during the smoke test.
for(const k of ['CLIPROXYAPI_PROVIDER_ID','CPA_PROVIDER_ID','CLIPROXYAPI_API','CPA_API','CLIPROXYAPI_API_DRIVER','CPA_API_DRIVER','CLIPROXYAPI_FAST','CPA_FAST']) delete env[k];
const cli=resolve('node_modules/openclaw/openclaw.mjs');
async function run(...args){const {stdout,stderr}=await exec(process.execPath,[cli,...args],{env,timeout:90000,maxBuffer:8*1024*1024}); if(stderr) console.error(stderr); return stdout;}
try {
 await writeFile(join(state,'openclaw.json'),JSON.stringify({agents:{defaults:{model:{primary:'cliproxyapi/smoke-model',fallbacks:['cpa/smoke-model']}}},plugins:{allow:['cliproxyapi'],load:{paths:[resolve('.')]},entries:{cliproxyapi:{enabled:true}}}}));
 const inspected=JSON.parse(await run('plugins','inspect','cliproxyapi','--runtime','--json'));
 assert.equal(inspected.plugin.status,'loaded');
 assert.deepEqual(inspected.plugin.providerIds,['cliproxyapi','cpa']);
 const models=await run('models','list','--refresh','--all','--provider','cliproxyapi','--json');
 assert.match(models,/smoke-model/, `discovery requests: ${requests}`);
 assert.ok(requests>0,'real host must call model discovery');
 const aliases=await run('models','list','--refresh','--all','--provider','cpa','--json');
 assert.match(aliases,/smoke-model/);
 console.log('PASS: real host loads plugin and discovers both provider catalogs against local mock CPA');
} finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(state,{recursive:true,force:true});}
