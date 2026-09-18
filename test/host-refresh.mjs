// Integration check: real Gateway service must publish changed model rows without a manual refresh.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
const exec = promisify(execFile);
const state = await mkdtemp(join(tmpdir(), 'cpa-refresh-'));
let modelId='before-refresh';
let requests=0;
const server=createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer smoke-key'){res.writeHead(401);res.end();return;}
 requests++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({data:[{id:modelId}]}));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const reserve=createServer();await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
const port=reserve.address().port;await new Promise(r=>reserve.close(r));
const cli=resolve('node_modules/openclaw/openclaw.mjs');
const env={...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:join(state,'openclaw.json'),OPENCLAW_GATEWAY_PORT:String(port),OPENCLAW_GATEWAY_TOKEN:'local-smoke-gateway-key',CLIPROXYAPI_BASE_URL:`http://127.0.0.1:${server.address().port}`,CLIPROXYAPI_API_KEY:'smoke-key'};
for(const k of ['CLIPROXYAPI_PROVIDER_ID','CPA_PROVIDER_ID','CLIPROXYAPI_API','CPA_API','CLIPROXYAPI_API_DRIVER','CPA_API_DRIVER','CLIPROXYAPI_FAST','CPA_FAST'])delete env[k];
await writeFile(env.OPENCLAW_CONFIG_PATH,JSON.stringify({gateway:{mode:'local',port,auth:{mode:'token',token:env.OPENCLAW_GATEWAY_TOKEN}},agents:{defaults:{model:{primary:'cliproxyapi/before-refresh',fallbacks:['cpa/before-refresh']}}},plugins:{allow:['cliproxyapi'],load:{paths:[resolve('.')]},entries:{cliproxyapi:{enabled:true,config:{refreshIntervalSeconds:30}}}}}));
let logs='';
const child=spawn(process.execPath,[cli,'gateway','run','--allow-unconfigured'],{env,stdio:['ignore','pipe','pipe']});
child.stdout.on('data',d=>{logs+=d;});child.stderr.on('data',d=>{logs+=d;});
async function list(refresh=false){return (await exec(process.execPath,[cli,'models','list','--all','--provider','cliproxyapi','--json',...(refresh?['--refresh']:[])],{env,timeout:30000,maxBuffer:4*1024*1024})).stdout;}
try{
 let ready=false;
 for(let i=0;i<30;i++){await delay(1000);if(child.exitCode!==null)throw new Error(logs);if(logs.includes('[gateway] ready')){ready=true;break;}}
 assert.ok(ready,logs);
 assert.match(await list(true),/before-refresh/);
 const initialRequests=requests;modelId='after-refresh';
 await delay(38000);
 const current=await list();
 assert.ok(requests>initialRequests,`no background discovery occurred\n${logs}`);
 assert.match(current,/after-refresh/,logs);
 console.log('PASS: running Gateway timer updated its published catalog without manual refresh');
}finally{
 child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),delay(5000)]);
 server.closeAllConnections();await new Promise(r=>server.close(r));
 await rm(state,{recursive:true,force:true,maxRetries:5,retryDelay:300});
}
