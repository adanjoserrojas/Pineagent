import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
export const hash = value => createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function safePath(p){if(typeof p!=='string'||!p||p.includes('\\')||p.includes(':')||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..'))throw Error(`Unsafe fixture path: ${p}`);return p;}
export async function writeFiles(root,files){for(const [p,s] of Object.entries(files)){safePath(p);const target=path.join(root,p);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,s);}}
export function validateTask(t){
  if(!/^[a-zA-Z0-9_-]+$/.test(t.id)||!t.prompt||!t.category)throw Error('Invalid task identity');
  for(const section of ['files','hidden','gold'])for(const [p,s] of Object.entries(t[section]??{})){safePath(p);if(typeof s!=='string')throw Error('Fixture content must be text');}
  if(!t.files[t.visibleTestPath]||!Object.keys(t.hidden??{}).length)throw Error('Visible and hidden tests required');
  for(const p of t.allowedWrites){safePath(p);if(!p.startsWith('src/')||!Object.hasOwn(t.files,p))throw Error('Only existing source files may be edited');}
  for(const p of Object.keys(t.hidden))if(Object.hasOwn(t.files,p)||t.allowedWrites.includes(p))throw Error('Hidden fixture overlaps visible files');
  for(const p of Object.keys(t.gold))if(!t.allowedWrites.includes(p))throw Error('Gold edits outside allowlist');
  return t;
}
export function rng(seed){let a=seed>>>0;return ()=>{a+=0x6D2B79F5;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}
export function schedule(tasks,repetitions=1,seed=42){if(!Number.isInteger(repetitions)||repetitions<1)throw Error('Invalid repetitions');if(new Set(tasks.map(x=>x.id)).size!==tasks.length)throw Error('Duplicate task');const random=rng(seed),pairs=[];for(const t of tasks)for(let r=0;r<repetitions;r++)pairs.push({taskId:t.id,repetition:r,arms:random()<0.5?['harness','codex']:['codex','harness']});for(let i=pairs.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[pairs[i],pairs[j]]=[pairs[j],pairs[i]];}return pairs;}
export function processRun(command,args,options={}){return new Promise(resolve=>{const started=Date.now();let out='',err='',timedOut=false,overflow=false;const child=spawn(command,args,{cwd:options.cwd,env:options.env??process.env,windowsHide:true,stdio:['pipe','pipe','pipe']});const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},options.timeoutMs??60000);const collect=(which,data)=>{if(out.length+err.length>8_000_000){overflow=true;child.kill('SIGKILL');return;}if(which==='out')out+=data;else err+=data;};child.stdout.on('data',x=>collect('out',x));child.stderr.on('data',x=>collect('err',x));child.on('error',e=>{clearTimeout(timer);resolve({code:null,out,err:e.code,wallMs:Date.now()-started,timedOut,overflow});});child.on('close',code=>{clearTimeout(timer);resolve({code,out,err,wallMs:Date.now()-started,timedOut,overflow});});child.stdin.on('error',()=>{});child.stdin.end(options.input??'');});}
