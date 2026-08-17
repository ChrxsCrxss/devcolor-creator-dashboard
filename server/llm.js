import { checkOllama, generateJson as generateJsonOllama, OLLAMA_MODEL } from "./ollama.js";
import { ANTHROPIC_MODEL, checkAnthropic, generateJsonAnthropic } from "./anthropic.js";

// Provider selection: explicit LLM_PROVIDER wins; otherwise default to
// Anthropic when a key is present, else fall back to local Ollama.
export const LLM_PROVIDER = (
  process.env.LLM_PROVIDER || (process.env.ANTHROPIC_API_KEY ? "anthropic" : "ollama")
).toLowerCase();

export async function generateJson(prompt, options) {
  if (LLM_PROVIDER === "anthropic") {
    return generateJsonAnthropic(prompt, options);
  }
  return generateJsonOllama(prompt, options);
}

export async function checkLlm() {
  if (LLM_PROVIDER === "anthropic") {
    const status = await checkAnthropic();
    return {
      provider: "anthropic",
      model: status.model || ANTHROPIC_MODEL,
      ok: status.ok,
      modelAvailable: status.modelAvailable,
      note: status.ok
        ? null
        : status.error?.includes("API_KEY")
          ? "Set ANTHROPIC_API_KEY to enable Claude."
          : status.error
    };
  }

  const status = await checkOllama();
  return {
    provider: "ollama",
    model: status.model || OLLAMA_MODEL,
    ok: status.ok,
    modelAvailable: status.modelAvailable,
    note: status.ok
      ? status.modelAvailable
        ? null
        : `Run: ollama pull ${status.model || OLLAMA_MODEL}`
      : status.error
  };
}
