import test from 'node:test';
import assert from 'node:assert/strict';
import {corpus} from '../src/corpus.mjs';
import {calibrate} from '../src/calibrate.mjs';
import {safePath,schedule,validateTask} from '../src/common.mjs';
test('all buggy fixtures fail and reference fixes pass',async()=>{const r=await calibrate();assert.equal(r.length,16);for(const x of r)assert.ok(x.bugFails&&x.goldPasses,JSON.stringify(x));});
test('path escapes and hidden overlaps are rejected',()=>{for(const p of ['../x','/x','C:/x','a\\b','a/../b','a//b'])assert.throws(()=>safePath(p));const t=structuredClone(corpus[0]);t.hidden[t.visibleTestPath]='leak';assert.throws(()=>validateTask(t));});
test('pair schedule is reproducible and repetitions stay paired',()=>{const a=schedule(corpus,3,42);assert.deepEqual(a,schedule(corpus,3,42));assert.notDeepEqual(a,schedule(corpus,3,43));assert.equal(a.length,48);assert.equal(new Set(a.map(x=>`${x.taskId}/${x.repetition}`)).size,48);for(const p of a)assert.deepEqual([...p.arms].sort(),['codex','harness']);assert.throws(()=>schedule([corpus[0],corpus[0]]));});
