import type { PublicSubscription } from "../worker/billing/checkout";
export class ApiError extends Error { constructor(public status: number, message: string, public fields: string[] = [], public code = "", public body: unknown = undefined) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/login")) { location.href = "/login"; throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`, (data as any).fields ?? [], (data as any).code ?? "", data);
  return data as T;
}

/** Sends a file as it is (a recording), not as JSON. */
async function putRaw<T>(path: string, body: Blob, headers: Record<string, string>): Promise<T> {
  const res = await fetch(`/api${path}`, { method: "PUT", credentials: "same-origin", headers, body });
  if (res.status === 401) { location.href = "/login"; throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  putRaw,
  get: <T,>(p: string) => req<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  patch: <T,>(p: string, b: unknown) => req<T>("PATCH", p, b),
  put: <T,>(p: string, b: unknown) => req<T>("PUT", p, b),
  del: <T,>(p: string) => req<T>("DELETE", p),
};

// The client's subscription page (`/s/<token>`). Public: it deliberately bypasses `req`, whose 401 handling sends the visitor to the owner's login. No cookie is sent.

/** The page's state as the server reports it now: `{ status, page }`, `page` only for a 200. A dropped connection is `status` 0. */
export async function publicSubscription(token: string): Promise<{ status: number; page: PublicSubscription | null }> {
  try {
    const res = await fetch(`/api/public/s/${token}`, { credentials: "omit", cache: "no-store" });
    return { status: res.status, page: res.ok ? ((await res.json()) as PublicSubscription) : null };
  } catch { return { status: 0, page: null }; }
}

/** The click on "Set up payment": the payment page's address for this subscription, or the status that refused it. */
export async function startSubscriptionCheckout(token: string): Promise<{ status: number; url: unknown }> {
  try {
    const res = await fetch(`/api/public/s/${token}/checkout`, { method: "POST", credentials: "omit", cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as { url?: unknown };
    return { status: res.status, url: res.ok ? data.url : undefined };
  } catch { return { status: 0, url: undefined }; }
}
