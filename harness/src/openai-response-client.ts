import type { FetchLike, TokenUsage, Patch } from "./types.js";
interface ApiUsage {
  input_tokens?: number; output_tokens?: number; cache_write_input_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number; cache_write_input_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}
interface ApiMessage { type?: string; phase?: string; content?: { type?: string; text?: string }[] }
interface ApiResponse { output_text?: string; output?: ApiMessage[]; usage?: ApiUsage; status?: string }
interface ResponseOptions { apiKey: string | undefined; body: unknown; timeoutMs?: number; fetchImpl?: FetchLike; responsePhasePolicy?: string }
interface SynthesisOptions {
  apiKey: string | undefined; model?: string; effort?: string; task: string; evidence: string; fetchImpl?: FetchLike;
  changeContract?: boolean; maxOutputTokens?: number; responsePhasePolicy?: string;
}

const RESPONSE_URL = "https://api.openai.com/v1/responses";

function extractLegacyText(response: ApiResponse): string | null {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  return null;
}

function extractFinalText(response: ApiResponse): string | null {
  const messages=(response.output??[]).filter(item=>item.type==="message"||Array.isArray(item.content));
  const message=messages.filter(item=>item.phase==="final_answer").at(-1)
    ??messages.filter(item=>!item.phase).at(-1);
  if(message){
    const text=(message.content??[]).filter(part=>part.type==="output_text"&&typeof part.text==="string").map(part=>part.text).join("");
    return text||null;
  }
  if(messages.length)return null;
  return typeof response.output_text==="string"?response.output_text:null;
}

export function responseUsage(response: ApiResponse): TokenUsage {
  const usage = response.usage ?? {};
  return {
    inputTokens: usage.input_tokens ?? null,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens ?? usage.input_tokens_details?.cache_write_input_tokens ?? usage.cache_write_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

export async function createResponse({ apiKey, body, timeoutMs = 90_000, fetchImpl = fetch, responsePhasePolicy = "final-answer" }: ResponseOptions) {
  if (!apiKey) throw new Error("OPENAI_API_KEY is required");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetchImpl(RESPONSE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`OpenAI Responses HTTP ${response.status}: ${text.slice(0, 400)}`);
    const json = JSON.parse(text) as ApiResponse;
    if(responsePhasePolicy!=="legacy-first-text"&&json.status&&json.status!=="completed")throw new Error(`OpenAI response ended with status ${json.status}`);
    return {
      json,
      text: responsePhasePolicy==="legacy-first-text"?extractLegacyText(json):extractFinalText(json),
      usage: responseUsage(json),
      wallMs: Math.round(performance.now() - started),
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function synthesizePatch({ apiKey, model = "gpt-6-luna", effort = "low", task, evidence, fetchImpl = fetch, changeContract = false, maxOutputTokens = 6000, responsePhasePolicy = "final-answer" }: SynthesisOptions): Promise<Patch & { promptChars: number }> {
  const prompt = [
    "Implement the requested change using only the supplied repository evidence.",
    "Return complete replacement contents for every file that must change.",
    "Do not invent paths, do not return unchanged files, and do not include markdown.",
    ...(changeContract ? ["Trace the public entry point through its dependencies and callers. Preserve existing public exports, validation, and error behavior. Implement every requirement, including cross-file data flow and edge cases. Check that every changed consumer receives the new value. Do not change tests."] : []),
    "",
    `TASK\n${task}`,
    "",
    `EVIDENCE\n${evidence}`,
  ].join("\n");
  const response = await createResponse({
    apiKey,
    fetchImpl,
    responsePhasePolicy,
    body: {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "file_patch",
          strict: true,
          schema: {
            type: "object",
            properties: {
              files: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                  },
                  required: ["path", "content"],
                  additionalProperties: false,
                },
              },
              summary: { type: "string" },
            },
            required: ["files", "summary"],
            additionalProperties: false,
          },
        },
      },
    },
  });
  if (!response.text) throw new Error("Patch response did not contain output text");
  return { ...(JSON.parse(response.text) as Patch), usage: response.usage, wallMs: response.wallMs, model, promptChars: prompt.length };
}
