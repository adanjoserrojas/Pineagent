import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {normalizeUsage,totalUsage} from './metrics.mjs';
export function responseReceipt(text,contentType){
  if(contentType.includes('text/event-stream')){let last=null;for(const line of text.split('\n'))if(line.startsWith('data: ')){try{const j=JSON.parse(line.slice(6));if(j.response?.usage)last=j.response;}catch{}}return last;}
  try{return JSON.parse(text);}catch{return null;}
}
export async function startProxy({apiKey,maxRequests=50,maxTokens=200000,onReceipt=()=>{},fetchImpl=fetch}){
  const token=randomBytes(32).toString('hex'),receipts=[];let active=false,blocked=false;
  const server=http.createServer(async(req,res)=>{
    if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401).end();return;}
    if(req.method!=='POST'||!['/v1/responses','/v1/decisions'].includes(req.url)){res.writeHead(403).end();return;}
    if(active||blocked||receipts.length>=maxRequests){res.writeHead(429).end('{"error":"benchmark request budget"}');return;}
    active=true;const started=Date.now();let receipt=null;
    try{
      let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>1_000_000)throw Error('Request too large');}
      const body=JSON.parse(raw),isRouter=req.url.endsWith('/decisions');
      if(body.model!==(isRouter?'gpt-6-luna':'gpt-6-sol'))throw Error('Unpinned model');
      if(!isRouter&&body.reasoning?.effort!=='medium')throw Error('Unpinned effort');
      // Same per-response output ceiling for both coding arms. Frozen synthesis already uses 8192.
      if(!isRouter)body.max_output_tokens=8192;
      receipt={endpoint:isRouter?'decisions':'responses',model:body.model,status:null,usage:null,wallMs:null};
      receipts.push(receipt);
      const upstream=await fetchImpl(`https://api.openai.com${req.url}`,{method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
      receipt.status=upstream.status;
      const type=upstream.headers.get('content-type')??'application/json';
      res.writeHead(upstream.status,{'content-type':type});let text='',bytes=0;
      for await(const chunk of upstream.body){bytes+=chunk.length;if(bytes>16_000_000)throw Error('Response too large');text+=Buffer.from(chunk).toString('utf8');if(!res.destroyed)res.write(chunk);}
      const parsed=responseReceipt(text,type);receipt.usage=parsed?.usage?normalizeUsage(parsed.usage):null;receipt.reportedModel=parsed?.model??null;
      res.end();
    }catch{if(!res.headersSent)res.writeHead(502);res.end('{"error":"benchmark transport rejected or failed"}');}
    finally{if(receipt){receipt.wallMs=Date.now()-started;const total=totalUsage(receipts);blocked=!total.complete||total.totalTokens>=maxTokens;await onReceipt(structuredClone(receipt));}active=false;}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'0.0.0.0',resolve);});
  return {token,port:server.address().port,receipts,close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
