import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {corpus as calibrationCorpus} from './corpus.mjs';
import {hash,validateTask,writeFiles,schedule,processRun} from './common.mjs';
import {startProxy} from './proxy.mjs';
import {totalUsage,analyze} from './metrics.mjs';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const PIN='9076b82b5d126a314b847bd94da842c5ac34e38b';
const args=process.argv.slice(2),option=(key,fallback)=>{const i=args.indexOf(key);return i<0?fallback:args[i+1];};
const mode=args.includes('--live')?'live':'smoke',pr=option('--pr','');
const repetitions=Number(option('--repetitions','1')),seed=Number(option('--seed','42')),limit=Number(option('--tasks',mode==='smoke'?'2':'16'));
const timeoutMs=Number(option('--timeout-ms','600000')),campaignTokenLimit=Number(option('--max-tokens','0'));
const corpusPath=option('--corpus',null);
const sourceCorpus=corpusPath?JSON.parse(await fs.readFile(path.resolve(corpusPath),'utf8')):calibrationCorpus;
for(const t of sourceCorpus)validateTask(t);
const tasks=sourceCorpus.slice(0,limit),plan=schedule(tasks,repetitions,seed);
if(!tasks.length||!Number.isInteger(limit)||limit<1||!Number.isFinite(timeoutMs)||timeoutMs<1000||!Number.isFinite(seed))throw Error('Invalid campaign settings');
if(!/^https:\/\/github.com\/adanjoserrojas\/Pineagent\/pull\/\d+$/.test(pr))throw Error('Create and supply --pr URL before invoking Docker');
if(mode==='live'&&(!process.env.OPENAI_API_KEY||campaignTokenLimit<=0))throw Error('Live mode requires OPENAI_API_KEY and an explicitly authorized --max-tokens budget');
async function checked(command,argv,options={}){const r=await processRun(command,argv,{cwd:repo,...options});if(r.code!==0)throw Error(`${command} failed (${r.code}): ${r.err.slice(-2000)} ${r.out.slice(-1000)}`);return r.out.trim();}
const head=await checked('git',['rev-parse','HEAD']);
const branch=await checked('git',['branch','--show-current']);
const remote=await checked('git',['ls-remote','origin',`refs/heads/${branch}`]);
if(remote.split(/\s/)[0]!==head)throw Error('Push every commit before Docker');
if(await checked('git',['status','--porcelain','--','testbench']))throw Error('Commit all testbench changes before Docker');
if(await checked('git',['diff',PIN,'--','harness']))throw Error('Frozen harness differs from pinned remote main');
const runRoot=path.join(repo,'testbench/runs',`${new Date().toISOString().replace(/[:.]/g,'-')}-${mode}`);
await fs.mkdir(runRoot,{recursive:true});
const context=path.join(runRoot,'context');await fs.mkdir(context);
const tarPath=path.join(runRoot,'harness.tar');
await checked('git',['archive','--format=tar',`--output=${tarPath}`,PIN,'harness']);
await checked('tar',['-xf',tarPath,'-C',context]);
await fs.mkdir(path.join(context,'src'));
for(const name of ['common.mjs','metrics.mjs','worker.mjs'])await fs.copyFile(path.join(repo,'testbench/src',name),path.join(context,'src',name));
await fs.copyFile(path.join(repo,'testbench/Dockerfile'),path.join(context,'Dockerfile'));
const tag=`pineagent-bench:${head.slice(0,12)}`;
console.log(`Building ${tag}. Evidence directory: ${runRoot}`);
const built=await processRun('docker',['build','-t',tag,context],{cwd:repo,timeoutMs:600000});
await fs.writeFile(path.join(runRoot,'build.log'),built.out+'\n'+built.err);
if(built.code!==0)throw Error(`Docker build failed; see ${path.join(runRoot,'build.log')}`);
const image=await checked('docker',['image','inspect',tag,'--format','{{.Id}}']);
const actualCodex=await checked('docker',['run','--rm','--network','none','--entrypoint','codex',image,'--version']);
if(actualCodex!=='codex-cli 0.163.0')throw Error('Codex version mismatch');
const manifest={schemaVersion:1,mode,pr,head,branch,harnessCommit:PIN,harnessTree:await checked('git',['rev-parse',`${PIN}:harness`]),image,codex:actualCodex,model:'gpt-6-sol',effort:'medium',corpusKind:corpusPath?'external-supplied':'authored-calibration',corpusHash:hash(tasks),distinctTasks:tasks.length,repetitions,seed,timeoutMs,campaignTokenLimit,plan,startedAt:new Date().toISOString()};
await fs.writeFile(path.join(runRoot,'manifest.json'),JSON.stringify(manifest,null,2));
const rows=[];let spentTokens=0,stopReason=null;
const limits=['--cpus','2','--memory','2g','--pids-limit','128','--cap-drop','ALL','--security-opt','no-new-privileges','--read-only','--tmpfs','/tmp:rw,nosuid,size=256m','--tmpfs','/home/node:rw,nosuid,size=64m'];
async function snapshot(root){const files={};async function visit(dir,prefix=''){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=prefix+entry.name,abs=path.join(dir,entry.name);const stat=await fs.lstat(abs);if(stat.isSymbolicLink())throw Error('Symlink in workspace');if(stat.isDirectory())await visit(abs,p+'/');else if(stat.isFile()){if(stat.size>1_000_000)throw Error('Oversize file');files[p]=await fs.readFile(abs,'utf8');}else throw Error('Unsupported file type');}}await visit(root);return files;}
async function grade(root,task,finalFiles){const files={...task.files,...task.hidden};for(const p of task.allowedWrites){if(!Object.hasOwn(finalFiles,p))return {code:1,reason:'missing_source'};files[p]=finalFiles[p];}await writeFiles(root,files);const name=`pinegrade-${head.slice(0,8)}-${Date.now()}`;try{return await processRun('docker',['run','--rm','--name',name,'--network','none',...limits,'--mount',`type=bind,source=${root},target=/grade,readonly`,'--workdir','/grade','--entrypoint','node',image,'--test',task.visibleTestPath,...Object.keys(task.hidden)],{timeoutMs:30000});}finally{await processRun('docker',['rm','-f',name],{timeoutMs:10000});}}
const validation=[];
for(const task of tasks){const bad=await grade(path.join(runRoot,'validation',task.id,'bug'),task,task.files);const good=await grade(path.join(runRoot,'validation',task.id,'gold'),task,{...task.files,...task.gold});validation.push({taskId:task.id,bugExitCode:bad.code,goldExitCode:good.code,passed:bad.code===1&&good.code===0});console.log(`Fixture validation ${task.id}: ${validation.at(-1).passed?'pass':'FAIL'}`);}
await fs.writeFile(path.join(runRoot,'validation.json'),JSON.stringify(validation,null,2));
if(validation.some(v=>!v.passed))throw Error('Fixture validation failed; no agents started');
for(const pair of plan){
  if(mode==='live'&&spentTokens>=campaignTokenLimit){stopReason='campaign_token_budget';break;}
  const task=tasks.find(t=>t.id===pair.taskId);
  for(const arm of pair.arms){
    const id=`${task.id}-${pair.repetition}-${arm}`,trial=path.join(runRoot,id),work=path.join(trial,'work'),input=path.join(trial,'input');
    await fs.mkdir(input,{recursive:true});await writeFiles(work,task.files);
    const publicTask={id:task.id,prompt:task.prompt,allowedWrites:task.allowedWrites,visibleTestPath:task.visibleTestPath};
    await fs.writeFile(path.join(input,'task.json'),JSON.stringify(publicTask));
    const proxy=mode==='live'?await startProxy({apiKey:process.env.OPENAI_API_KEY,onReceipt:receipt=>fs.appendFile(path.join(trial,'receipts.jsonl'),JSON.stringify(receipt)+'\n')}):null;
    const name=`pinebench-${head.slice(0,8)}-${id}-${Date.now()}`;
    const env={...process.env,BENCH_PROXY_TOKEN:proxy?.token??'',BENCH_PROXY:proxy?`http://host.docker.internal:${proxy.port}`:'',BENCH_ARM:arm,BENCH_MODE:mode};
    let result;
    try{result=await processRun('docker',['run','--rm','--name',name,...limits,'--network',mode==='smoke'?'none':'bridge','--add-host','host.docker.internal:host-gateway','--mount',`type=bind,source=${work},target=/work`,'--mount',`type=bind,source=${input},target=/input,readonly`,'-e','BENCH_ARM','-e','BENCH_MODE','-e','BENCH_PROXY','-e','BENCH_PROXY_TOKEN',image],{env,timeoutMs});}
    finally{await processRun('docker',['rm','-f',name],{timeoutMs:10000});if(proxy)await proxy.close();}
    const receipts=proxy?.receipts??[];let payload=null;
    for(const line of result.out.split('\n'))try{const p=JSON.parse(line);if(p.benchmarkResult)payload=p;}catch{}
    let finalFiles={},violation=false;
    try{finalFiles=await snapshot(work);for(const p of new Set([...Object.keys(finalFiles),...Object.keys(task.files)]))if(finalFiles[p]!==task.files[p]&&!task.allowedWrites.includes(p))violation=true;}catch{violation=true;}
    const grading=violation?{code:1,reason:'invalid_write'}:await grade(path.join(trial,'grade'),task,finalFiles);
    const usage=totalUsage(receipts);
    // A missing worker result or a live arm with no provider request is not a zero-token success.
    if(mode==='live'&&(!payload||!receipts.length)){usage.complete=false;usage.totalTokens=null;}
    const status=result.timedOut?'timeout':result.code!==0?'infrastructure_error':violation?'invalid_write':payload?.status??'infrastructure_error';
    const row={taskId:task.id,repetition:pair.repetition,arm,mode,status,passed:mode==='live'&&!violation&&!result.timedOut&&result.code===0&&grading.code===0&&!!payload,wallMs:payload?.wallMs??result.wallMs,usage,gradeExitCode:grading.code,fallbackUsed:payload?.fallbackUsed??false};
    rows.push(row);await fs.appendFile(path.join(runRoot,'results.jsonl'),JSON.stringify(row)+'\n');
    await fs.writeFile(path.join(trial,'grading.log'),(grading.out??'')+'\n'+(grading.err??''));
    console.log(`${id}: ${status}, hidden tests ${grading.code===0?'pass':'fail'}, tokens ${usage.totalTokens??'unknown'}`);
    if(usage.totalTokens!==null)spentTokens+=usage.totalTokens;
    if(mode==='live'&&(!usage.complete||status==='infrastructure_error'))stopReason='incomplete_usage_or_infrastructure';
  }
  if(stopReason)break;
}
manifest.finishedAt=new Date().toISOString();manifest.stopReason=stopReason;manifest.completedTrials=rows.length;
await fs.writeFile(path.join(runRoot,'manifest.json'),JSON.stringify(manifest,null,2));
await fs.writeFile(path.join(runRoot,'summary.json'),JSON.stringify(analyze(rows),null,2));
console.log(`Finished ${rows.length} ${mode} trials. ${runRoot}`);
