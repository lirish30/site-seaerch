export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method, credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !path.startsWith("/login")) { location.href = "/login"; throw new ApiError(401, "unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, (data as any).error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  get: <T,>(p: string) => req<T>("GET", p),
  post: <T,>(p: string, b?: unknown) => req<T>("POST", p, b ?? {}),
  patch: <T,>(p: string, b: unknown) => req<T>("PATCH", p, b),
  put: <T,>(p: string, b: unknown) => req<T>("PUT", p, b),
};
