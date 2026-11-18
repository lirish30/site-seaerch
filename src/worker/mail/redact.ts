/** Every form a secret may take inside an error message: raw, JSON-escaped, URL-encoded and base64. */
function forms(secret: string): string[] {
  const out = new Set<string>([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]);
  try { out.add(btoa(secret)); } catch { /* non-latin1 secret: no base64 form */ }
  try { out.add(btoa(`\0${secret}`)); out.add(btoa(`\0user\0${secret}`)); } catch { /* ditto */ }
  return [...out].filter(Boolean);
}

/** The error text with the secret (and its common escaped forms) replaced by ***. Never stores or returns the secret. */
export function redactSecret(text: string, secret: string | null | undefined): string {
  if (!secret) return text;
  let out = text;
  for (const f of forms(secret).sort((a, b) => b.length - a.length)) out = out.split(f).join("***");
  return out;
}

export const errorText = (e: unknown, secret: string | null | undefined): string => redactSecret(e instanceof Error ? e.message : String(e), secret);
