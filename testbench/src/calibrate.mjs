import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {corpus} from './corpus.mjs';
import {validateTask,writeFiles,processRun} from './common.mjs';
export async function calibrate(){const results=[];const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|NODE_TEST_CONTEXT/i.test(k)));for(const task of corpus){validateTask(task);const root=await fs.mkdtemp(path.join(os.tmpdir(),'pine-calibration-'));try{await writeFiles(root,{...task.files,...task.hidden});const bad=await processRun(process.execPath,['--test','test/visible.test.js','test/hidden.test.js'],{cwd:root,env});await writeFiles(root,task.gold);const good=await processRun(process.execPath,['--test','test/visible.test.js','test/hidden.test.js'],{cwd:root,env});results.push({id:task.id,bugFails:bad.code!==0&&bad.code!==null,goldPasses:good.code===0});if(good.code!==0)console.error(task.id,good.out,good.err);}finally{await fs.rm(root,{recursive:true,force:true});}}return results;}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const r=await calibrate();console.log(JSON.stringify(r,null,2));if(r.some(x=>!x.bugFails||!x.goldPasses))process.exitCode=1;}
