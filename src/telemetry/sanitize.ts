/** Bounded secret redaction for untrusted text at ingest boundaries. */
export const CONTEXT_TRUNCATION_MARKER = "[truncated]";
export const SANITIZER_LOOKAHEAD_CODE_UNITS = 512;

export function sanitizeUntrustedText(
  value: string,
  maxCodeUnits: number,
  sourceTruncated = false,
): string {
  const scanLimit = maxCodeUnits + SANITIZER_LOOKAHEAD_CODE_UNITS;
  let sanitized = redactUnterminatedQuotedAssignment(value.slice(0, scanLimit))
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[redacted private key]",
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*/gi,
      "[redacted private key]",
    )
    .replace(/\bAuthorization\s*:\s*[^\r\n]*/gi, "Authorization: [redacted]")
    .replace(/\b(?:Set-)?Cookie\s*:\s*[^\r\n]*/gi, "Cookie: [redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g,
      "[redacted token]",
    )
    .replace(
      /\b((?:[A-Z0-9_]*)(?:TOKEN|SECRET[_-]?ACCESS[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL))\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      "$1=[redacted]",
    );
  if (
    (sourceTruncated || value.length > maxCodeUnits) &&
    sanitized.length <= maxCodeUnits
  )
    sanitized += CONTEXT_TRUNCATION_MARKER;
  return truncateText(sanitized, maxCodeUnits);
}

function redactUnterminatedQuotedAssignment(value: string): string {
  const prefix =
    /\b((?:[A-Z0-9_]*)(?:TOKEN|SECRET[_-]?ACCESS[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|API[_-]?KEY|PRIVATE[_-]?KEY|AUTHORIZATION|COOKIE|CREDENTIAL))\s*[:=]\s*(["'])/gi;
  for (let match = prefix.exec(value); match; match = prefix.exec(value)) {
    const quote = match[2];
    if (!quote) continue;
    const valueStart = match.index + match[0].length;
    const closingQuote = value.indexOf(quote, valueStart);
    if (closingQuote < 0)
      return `${value.slice(0, match.index)}${match[1]}=[redacted]`;
    prefix.lastIndex = closingQuote + 1;
  }
  return value;
}

function truncateText(text: string, maxCodeUnits: number): string {
  if (text.length <= maxCodeUnits) return text;
  if (maxCodeUnits <= CONTEXT_TRUNCATION_MARKER.length) {
    return CONTEXT_TRUNCATION_MARKER;
  }
  return `${text.slice(0, maxCodeUnits - CONTEXT_TRUNCATION_MARKER.length)}${CONTEXT_TRUNCATION_MARKER}`;
}
