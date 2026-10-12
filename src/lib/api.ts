/**
 * Typed fetch client for the Hono gateway. Always sends credentials (Better Auth
 * HTTP-only cookies) so the session cookie travels with every request; CORS on
 * the gateway allowlists this origin with credentials=true.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3000";

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers: {
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data as { error?: string; code?: string } | null;
    throw new ApiClientError(d?.error ?? `Request failed (${res.status})`, res.status, d?.code);
  }
  return data as T;
}
