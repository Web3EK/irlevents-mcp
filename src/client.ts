// Thin fetch wrapper around the IRLEvents API.
// Used by every tool handler in src/index.ts. Centralizes auth, base URL,
// and error shape normalization so individual tools stay one-liners.

const DEFAULT_BASE = "https://irlevents.io";

export type RequestOptions = RequestInit & {
  query?: Record<string, string | number | boolean | undefined>;
};

export interface IRLClient {
  base: string;
  request: <T = unknown>(path: string, init?: RequestOptions) => Promise<T>;
}

export class IRLApiError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    public body: unknown,
  ) {
    super(message);
    this.name = "IRLApiError";
  }
}

export function createClient(opts: { apiKey: string; base?: string }): IRLClient {
  const base = (opts.base ?? DEFAULT_BASE).replace(/\/+$/, "");
  if (!opts.apiKey) {
    throw new Error("IRLEVENTS_API_KEY is required");
  }
  if (!opts.apiKey.startsWith("api_")) {
    throw new Error('IRLEVENTS_API_KEY must start with "api_"');
  }

  async function request<T>(path: string, init: RequestOptions = {}): Promise<T> {
      const url = new URL(base + (path.startsWith("/") ? path : "/" + path));
      const { query, ...rest } = init;
      if (query) {
        for (const [k, v] of Object.entries(query)) {
          if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
        }
      }

      const headers = new Headers(rest.headers);
      headers.set("Authorization", `Bearer ${opts.apiKey}`);
      headers.set("Accept", "application/json");
      if (rest.body && !headers.has("Content-Type")) {
        headers.set("Content-Type", "application/json");
      }
      headers.set("User-Agent", "irlevents-mcp/0.1.0");

      const res = await fetch(url, { ...rest, headers });
      const text = await res.text();
      let parsed: unknown = text;
      if (text && (res.headers.get("content-type") || "").includes("json")) {
        try {
          parsed = JSON.parse(text);
        } catch {
          // leave as text
        }
      }

      if (!res.ok) {
        const body = parsed as Record<string, unknown> | string;
        const code =
          typeof body === "object" && body !== null
            ? (body.code as string | undefined) ?? (body.error as string | undefined) ?? null
            : null;
        const msg =
          (typeof body === "object" && body !== null
            ? (body.message as string | undefined)
            : undefined) ??
          (typeof body === "string" ? body : null) ??
          `HTTP ${res.status}`;
        throw new IRLApiError(res.status, code, msg, parsed);
      }

      return parsed as T;
  }

  return { base, request };
}
