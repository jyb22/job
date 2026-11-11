// Everything that arrives from outside the application — uploaded files, CSV
// cells, marketplace responses, comparable-listing titles, model output — is
// untrusted DATA. These helpers normalise it and flag text that looks like an
// attempt to give the system instructions. Flags only ever make the system
// MORE cautious (route to review); nothing in external text can grant a
// permission, because authorisation is decided by src/policy/engine.ts from
// settings alone.

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any |the )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /disregard (all |any |the )?(previous|prior|above)/i,
  /\bsystem prompt\b/i,
  /you are now\b/i,
  /\bas an ai\b/i,
  /override (the )?(policy|price|floor|rules|settings)/i,
  /(set|change|lower) (the )?(price|minimum|floor) to/i,
  /publish (this )?(immediately|now) without/i,
  /<\/?(system|assistant|instructions?)>/i,
  /\b(api[_ -]?key|password|secret|token)\s*[:=]/i,
];

export function looksLikeInstruction(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

/** Strip control characters, collapse whitespace, cap length. */
export function cleanText(input: unknown, maxLength = 500): string {
  if (input === null || input === undefined) return "";
  return String(input)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim()
    .slice(0, maxLength);
}

/** Single-line variant for titles, brands, sizes. */
export function cleanLine(input: unknown, maxLength = 200): string {
  return cleanText(input, maxLength).replace(/\s*[\r\n]+\s*/g, " ");
}

const SECRET_PATTERNS: RegExp[] = [
  /\b(sk-ant-[A-Za-z0-9_-]{8,})/g,
  /\b(pak_[A-Za-z0-9]{8,})/g,
  /\b(prt_[A-Za-z0-9]{8,})/g,
  /\b(v\^1\.1#[^\s"']+)/g, // eBay user tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/g, // JWTs
];

/** Remove anything that looks like a credential before text is logged or sent in a notification. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out.replace(/("?(?:access_token|refresh_token|client_secret|api_key|password|authorization)"?\s*[:=]\s*)"?[^",\s}]+"?/gi, '$1"[redacted]"');
}

/** Deep-redact an object for audit detail. Drops known secret keys and buyer address fields. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 2000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactObject(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Flags and counts under a secret-sounding name (e.g. credentialsChanged: true) carry no secret.
      if (/token|secret|password|api_?key|authorization|credential/i.test(k)) out[k] = typeof v === "boolean" || typeof v === "number" || v === null ? v : "[redacted]";
      else if (/buyer_address|shipping_address|buyer_email|buyer_name|phone/i.test(k)) out[k] = "[private]";
      else out[k] = redactObject(v, depth + 1);
    }
    return out;
  }
  return value;
}
