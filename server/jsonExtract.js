// Robustly parse a JSON object out of an LLM response. Handles clean JSON,
// reasoning models that wrap output in <think> blocks, and models that add
// prose or markdown fences around the object.
export function parseModelJson(raw) {
  const text = String(raw || "");
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/```json/gi, "")
      .replace(/```/g, "");
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start !== -1 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1));
    }
    throw new Error("Model did not return parseable JSON");
  }
}
