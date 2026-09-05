import { sanitizePromptEditorText } from "../prompt/sanitize.js";
const sensitive =
  /authorization|cookie|password|secret|credential|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key/i;
/** Metadata-only by default; inherited prompt sanitizer remains the text boundary. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth_limit]";
  if (typeof value === "string") return sanitizePromptEditorText(value, 4000);
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(value),
    ).slice(0, 100)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype")
        continue;
      result[key] = sensitive.test(key)
        ? "[redacted]"
        : "value" in descriptor
          ? redact(descriptor.value, depth + 1)
          : "[accessor]";
    }
    return result;
  }
  return value;
}
