// This is the only testbench entry point installed in the agent image.
import fs from 'node:fs/promises';
import {processRun} from './common.mjs';
import {cliUsage} from './metrics.mjs';
import {executeV8Dag,createFrozenRouter,createFrozenSynthesize,FROZEN_HISTORY,selectCandidateDags,prototypeTools} from '/opt/harness/dist/src/index.js';
const task=JSON.parse(await fs.readFile('/input/task.json','utf8'));
const arm=process.env.BENCH_ARM,mode=process.env.BENCH_MODE;
const started=Date.now();
const prompt=`${task.prompt}\nOnly edit these source files: ${task.allowedWrites.join(', ')}. Preserve all tests and package metadata. Run node --test ${task.visibleTestPath}. Work autonomously within this scope.`;
async function codex(evidence=''){
  const args=['exec','--json','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--dangerously-bypass-approvals-and-sandbox','-m','gpt-6-sol','-c','model_reasoning_effort="medium"','-c','model_provider="benchmark"','-c','model_providers.benchmark.name="Benchmark"','-c',`model_providers.benchmark.base_url="${process.env.BENCH_PROXY}/v1"`,'-c','model_providers.benchmark.env_key="BENCH_PROXY_TOKEN"','-c','model_providers.benchmark.wire_api="responses"','-c','model_providers.benchmark.supports_websockets=false','-'];
  const result=await processRun('codex',args,{cwd:'/work',input:prompt+(evidence?`\nContinue the current attempt using this evidence:\n${evidence}`:''),timeoutMs:590000});
  return {status:result.code===0?'completed':result.timedOut?'timeout':'agent_error',modelCalls:cliUsage(result.out).length,cliUsage:cliUsage(result.out),wallMs:result.wallMs};
}
let result;
try{
  if(mode==='smoke')result={status:'smoke_no_model',modelCalls:0};
  else if(arm==='codex')result=await codex();
  else{
    const meteredFetch=async(url,options)=>{const u=new URL(url);if(u.hostname!=='api.openai.com')throw Error('Unexpected provider');return fetch(`${process.env.BENCH_PROXY}${u.pathname}`,{...options,headers:{...options.headers,authorization:`Bearer ${process.env.BENCH_PROXY_TOKEN}`}});};
    const router=createFrozenRouter({decisionsApiKey:'proxy',fetchImpl:meteredFetch});
    const run=await executeV8Dag({trialRoot:'/work',task:{...task,prompt},router,candidates:selectCandidateDags({goalCapability:'verified_change',tools:prototypeTools}),history:FROZEN_HISTORY,synthesize:createFrozenSynthesize({apiKey:'proxy',fetchImpl:meteredFetch}),fallbackAgent:async({evidencePacket})=>codex(evidencePacket)});
    result={status:run.execution.status,route:run.route.routeLabel??null,modelCalls:run.execution.modelCalls,fallbackUsed:!!run.execution.fallback};
  }
}catch(e){result={status:'agent_error',errorType:e.name};}
console.log(JSON.stringify({benchmarkResult:true,...result,wallMs:Date.now()-started}));
