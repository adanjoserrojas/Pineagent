import fs from 'node:fs/promises';
import path from 'node:path';
import {analyze} from './metrics.mjs';
const root=path.resolve(process.argv[2]??'testbench/runs/latest');
const rows=(await fs.readFile(path.join(root,'results.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const summary=analyze(rows);
await fs.writeFile(path.join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify(summary,null,2));
