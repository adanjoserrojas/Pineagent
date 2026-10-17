import test from "node:test";
import assert from "node:assert/strict";
import { createResponse } from "../src/openai-response-client.js";

test("structured response consumer selects the final answer rather than progress commentary",async()=>{
  const response=await createResponse({apiKey:"fake",body:{},fetchImpl:async()=>new Response(JSON.stringify({status:"completed",output:[
    {type:"message",role:"assistant",phase:"commentary",content:[{type:"output_text",text:"I'll implement the requested change."}]},
    {type:"message",role:"assistant",phase:"final_answer",content:[{type:"output_text",text:'{"files":[],'},{type:"output_text",text:'"summary":"done"}'}]},
  ],usage:{input_tokens:10,output_tokens:20}}))});
  assert.deepEqual(JSON.parse(response.text!),{files:[],summary:"done"});
});

test("commentary alone is never accepted as a completed structured answer",async()=>{
  const response=await createResponse({apiKey:"fake",body:{},fetchImpl:async()=>new Response(JSON.stringify({status:"completed",output:[{type:"message",phase:"commentary",content:[{type:"output_text",text:"Working on it."}]}]}))});
  assert.equal(response.text,null);
});

test("incomplete model output never reaches patch application",async()=>{
  await assert.rejects(()=>createResponse({apiKey:"fake",body:{},fetchImpl:async()=>new Response(JSON.stringify({status:"incomplete",output:[{type:"message",phase:"final_answer",content:[{type:"output_text",text:'{"files":[]}'}]}]}))}),/status incomplete/);
});
