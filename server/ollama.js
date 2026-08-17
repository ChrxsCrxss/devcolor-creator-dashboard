import { parseModelJson } from "./jsonExtract.js";

const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://localhost:11434";
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:14b-instruct";
// Larger models are slower to first token; give them room before timing out.
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 90000);

// Reasoning models (deepseek-r1, qwq) need to emit a <think> block before the
// answer, so we must NOT constrain them to json grammar from the first token.
function isReasoningModel(model) {
  return /(^|[:/])(deepseek-r1|r1|qwq)/i.test(model);
}

export async function checkOllama() {
  try {
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) {
      return { ok: false, model: OLLAMA_MODEL, error: `Ollama returned ${response.status}` };
    }
    const body = await response.json();
    const models = Array.isArray(body.models) ? body.models.map((model) => model.name) : [];
    return {
      ok: true,
      model: OLLAMA_MODEL,
      modelAvailable: models.some((name) => name === OLLAMA_MODEL || name.startsWith(`${OLLAMA_MODEL}:`)),
      models
    };
  } catch (error) {
    return { ok: false, model: OLLAMA_MODEL, error: error.message };
  }
}

export async function generateJson(prompt, { temperature = 0.2 } = {}) {
  const reasoning = isReasoningModel(OLLAMA_MODEL);
  const response = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: reasoning
        ? `${prompt}\n\nThink briefly, then output ONLY the final JSON object.`
        : prompt,
      stream: false,
      // Don't force json grammar on reasoning models; parse it out afterwards.
      ...(reasoning ? {} : { format: "json" }),
      options: {
        temperature
      }
    }),
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS)
  });

  if (!response.ok) {
    throw new Error(`Ollama returned ${response.status}`);
  }

  const body = await response.json();
  return parseModelJson(body.response);
}
