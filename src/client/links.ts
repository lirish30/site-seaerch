/** Returns a safe absolute http(s) URL, or null. Bare hosts get https://. */
export function safeHttpUrl(url: string | null | undefined): string | null {
  const raw = (url ?? "").trim();
  if (!raw) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/?#]*:\d+(?:[/?#]|$)/.test(raw);
  try {
    const u = new URL(hasScheme ? raw : `https://${raw}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch { return null; }
}
