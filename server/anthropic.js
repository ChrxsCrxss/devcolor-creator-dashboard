import { parseModelJson } from "./jsonExtract.js";

const ANTHROPIC_HOST = process.env.ANTHROPIC_HOST || "https://api.anthropic.com";
// Alias resolves to the latest dated build; override with ANTHROPIC_MODEL to
// pin a version or use a newer Opus (e.g. claude-opus-4-8, claude-opus-5).
export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-4-5";
const ANTHROPIC_VERSION = process.env.ANTHROPIC_VERSION || "2023-06-01";
const ANTHROPIC_TIMEOUT_MS = Number(process.env.ANTHROPIC_TIMEOUT_MS || 30000);
const MAX_TOKENS = Number(process.env.ANTHROPIC_MAX_TOKENS || 1024);

function apiKey() {
  return process.env.ANTHROPIC_API_KEY || "";
}

export async function generateJsonAnthropic(prompt, { temperature = 0.2 } = {}) {
  if (!apiKey()) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }

  const response = await fetch(`${ANTHROPIC_HOST}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey(),
      "anthropic-version": ANTHROPIC_VERSION
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: MAX_TOKENS,
      temperature,
      system:
        "You are a JSON API. Respond with ONLY a single valid JSON object. No prose, no explanations, no markdown code fences.",
      messages: [{ role: "user", content: prompt }]
    }),
    signal: AbortSignal.timeout(ANTHROPIC_TIMEOUT_MS)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Anthropic returned ${response.status} ${detail.slice(0, 200)}`);
  }

  const body = await response.json();
  const text = Array.isArray(body.content)
    ? body.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("")
    : "";
  return parseModelJson(text);
}

export async function checkAnthropic() {
  if (!apiKey()) {
    return { ok: false, model: ANTHROPIC_MODEL, modelAvailable: false, error: "ANTHROPIC_API_KEY not set" };
  }

  try {
    const response = await fetch(`${ANTHROPIC_HOST}/v1/models`, {
      headers: { "x-api-key": apiKey(), "anthropic-version": ANTHROPIC_VERSION },
      signal: AbortSignal.timeout(4000)
    });
    if (!response.ok) {
      return {
        ok: false,
        model: ANTHROPIC_MODEL,
        modelAvailable: false,
        error: `Anthropic returned ${response.status}`
      };
    }
    const body = await response.json();
    const ids = Array.isArray(body.data) ? body.data.map((model) => model.id) : [];
    const modelAvailable = ids.some((id) => id === ANTHROPIC_MODEL || id.startsWith(ANTHROPIC_MODEL));
    return { ok: true, model: ANTHROPIC_MODEL, modelAvailable };
  } catch (error) {
    return { ok: false, model: ANTHROPIC_MODEL, modelAvailable: false, error: error.message };
  }
}
