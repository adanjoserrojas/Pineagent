import {rng} from './common.mjs';
const numeric = x => Number.isFinite(x)&&x>=0 ? x : null;
export function normalizeUsage(u){return {inputTokens:numeric(u?.input_tokens),outputTokens:numeric(u?.output_tokens),cachedInputTokens:numeric(u?.input_tokens_details?.cached_tokens??u?.cached_input_tokens),reasoningTokens:numeric(u?.output_tokens_details?.reasoning_tokens)};}
export function totalUsage(receipts){const keys=['inputTokens','outputTokens','cachedInputTokens','reasoningTokens'];const sum=Object.fromEntries(keys.map(k=>[k,receipts.every(r=>numeric(r.usage?.[k])!==null)?receipts.reduce((a,r)=>a+r.usage[k],0):null]));return {...sum,requests:receipts.length,complete:sum.inputTokens!==null&&sum.outputTokens!==null,totalTokens:sum.inputTokens===null||sum.outputTokens===null?null:sum.inputTokens+sum.outputTokens};}
// Transport receipts are primary. CLI turn summaries are retained only as a cross-check.
export function cliUsage(jsonl){const events=jsonl.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});return events.filter(e=>e.type==='turn.completed').map(e=>normalizeUsage(e.usage));}
const mean=xs=>xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null;
const interval=xs=>{if(xs.length===0||xs.some(x=>x===null||!Number.isFinite(x)))return null;const a=xs.toSorted((a,b)=>a-b);return [a[Math.floor(.025*(a.length-1))],a[Math.ceil(.975*(a.length-1))]];};
function effect(pairs){const a=pairs.map(p=>p.harness),b=pairs.map(p=>p.codex);const complete=[...a,...b].every(x=>numeric(x.usage?.totalTokens)!==null&&x.usage.complete);const sumA=complete?a.reduce((s,x)=>s+x.usage.totalTokens,0):null,sumB=complete?b.reduce((s,x)=>s+x.usage.totalTokens,0):null;return {qualityDifference:mean(a.map(x=>+x.passed))-mean(b.map(x=>+x.passed)),tokenRatio:complete&&sumB>0?sumA/sumB:null};}
export function analyze(rows,{bootstrap=5000,seed=20261018}={}){
  const seen=new Set(),groups=new Map();
  for(const r of rows){if(!['harness','codex'].includes(r.arm)||typeof r.passed!=='boolean'||!r.taskId||!Number.isInteger(r.repetition)||r.repetition<0)throw Error('Invalid trial record');const key=`${r.taskId}/${r.repetition}`;if(seen.has(`${key}/${r.arm}`))throw Error('Duplicate trial');seen.add(`${key}/${r.arm}`);const p=groups.get(key)??{};p[r.arm]=r;groups.set(key,p);}
  const pairs=[...groups.values()].filter(p=>p.harness&&p.codex),clusters=new Map();
  for(const p of pairs){const id=p.harness.taskId;clusters.set(id,[...(clusters.get(id)??[]),p]);}
  const arms=Object.fromEntries(['harness','codex'].map(arm=>{const a=rows.filter(r=>r.arm===arm),complete=a.every(r=>r.usage?.complete),tokens=complete?a.reduce((s,r)=>s+r.usage.totalTokens,0):null,successes=a.filter(r=>r.passed).length;return [arm,{attempts:a.length,successes,passRate:mean(a.map(r=>+r.passed)),usageComplete:complete,totalTokens:tokens,tokensPerSuccess:successes&&tokens!==null?tokens/successes:null,meanWallMs:mean(a.map(r=>r.wallMs)),unknownUsage:a.filter(r=>!r.usage?.complete).length,statusCounts:Object.fromEntries([...new Set(a.map(r=>r.status))].map(s=>[s,a.filter(r=>r.status===s).length]))}];}));
  if(!pairs.length)return {arms,pairedTrials:0,distinctTasks:0,unpairedTrials:rows.length,verdict:'No paired model evidence'};
  const random=rng(seed),cs=[...clusters.values()],draws=[];
  for(let i=0;i<bootstrap;i++){const sample=[];for(let j=0;j<cs.length;j++)sample.push(...cs[Math.floor(random()*cs.length)]);draws.push(effect(sample));}
  // A degenerate empirical bootstrap cannot establish population-level quality precision.
  const qualityVaries=new Set(cs.map(c=>effect(c).qualityDifference)).size>1;
  const point=effect(pairs),qualityCI=cs.length>=2&&qualityVaries?interval(draws.map(d=>d.qualityDifference)):null,tokenRatioCI=cs.length>=2?interval(draws.map(d=>d.tokenRatio)):null;
  const unpairedTrials=rows.length-pairs.length*2;
  const eligible=!unpairedTrials&&rows.every(r=>r.mode==='live')&&cs.length>=100&&qualityCI&&tokenRatioCI;
  const joint=pairs.filter(p=>p.harness.passed&&p.codex.passed);
  return {arms,pairedTrials:pairs.length,distinctTasks:cs.length,unpairedTrials,...point,qualityCI,tokenRatioCI,jointlySolvedPairs:joint.length,jointlySolvedTokenRatio:joint.length?effect(joint).tokenRatio:null,bootstrap:{replicates:bootstrap,seed,unit:'distinct task'},verdict:eligible&&qualityCI[0]>-.05&&tokenRatioCI[1]<1?'Quality-preserving token reduction under the prespecified rule':'Inconclusive or exploratory; no superiority claim',limitations:['Authored calibration fixtures do not establish real-repository performance.','Repeated attempts cluster by task.','Missing receipts prevent total token claims.','A constant task-level quality difference has no bootstrap quality interval; use a separately specified exact or conservative analysis.']};
}
