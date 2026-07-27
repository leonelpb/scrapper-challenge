import axios, {
  type AxiosInstance,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";
import type { RetryResult } from "./types.js";
import { log } from "./logger.js";

/**
 * Create a configured Axios instance with default headers and timeout.
 */
export function createHttpClient(timeoutMs: number): AxiosInstance {
  const client = axios.create({
    timeout: timeoutMs,
    maxRedirects: 5,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "es-PE,es;q=0.9,en;q=0.8",
    },
    // Prevent axios from throwing on non-2xx (we handle status ourselves)
    validateStatus: () => true,
  });

  return client;
}

/**
 * Sleep for `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an HTTP operation with exponential backoff + jitter.
 *
 * Retries on: 429, 408, 5xx, network errors without response.
 * Does NOT retry on: 4xx (except 408, 429), validation errors, etc.
 */
export async function withRetry<T>(
  fn: () => Promise<AxiosResponse<T>>,
  options: {
    retryMax: number;
    backoffMs: number;
    label: string;
  }
): Promise<RetryResult<T>> {
  const { retryMax, backoffMs, label } = options;
  let lastError = "";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= retryMax; attempt++) {
    try {
      const response = await fn();
      lastStatus = response.status;

      // ── Success ──────────────────────────────────────────
      if (response.status >= 200 && response.status < 300) {
        return { success: true, data: response.data, attempts: attempt };
      }

      // ── Retryable status codes ──────────────────────────
      const retryable =
        response.status === 429 ||
        response.status === 408 ||
        response.status >= 500;

      if (!retryable) {
        lastError = `HTTP ${response.status}`;
        return {
          success: false,
          error: lastError,
          attempts: attempt,
          finalStatus: response.status,
        };
      }

      // ── Compute wait time ───────────────────────────────
      const retryAfter = response.headers["retry-after"];
      let waitMs = backoffMs * 2 ** (attempt - 1);

      if (retryAfter) {
        const retryAfterSec = parseInt(retryAfter, 10);
        if (!Number.isNaN(retryAfterSec)) {
          waitMs = Math.max(waitMs, retryAfterSec * 1000);
        }
      }

      // Add jitter: ±25%
      const jitter = waitMs * 0.25 * (Math.random() * 2 - 1);
      waitMs = Math.max(0, Math.round(waitMs + jitter));

      lastError = `HTTP ${response.status} (attempt ${attempt}/${retryMax}, wait ${waitMs}ms)`;
      log.warn(`${label}: ${lastError}`);
      await sleep(waitMs);
    } catch (err: unknown) {
      // Network error without HTTP response
      const message =
        err instanceof Error ? err.message : String(err);
      lastError = `Network: ${message} (attempt ${attempt}/${retryMax})`;
      log.warn(`${label}: ${lastError}`);

      if (attempt < retryMax) {
        const waitMs =
          backoffMs * 2 ** (attempt - 1) +
          Math.round(backoffMs * 0.25 * (Math.random() * 2 - 1));
        await sleep(waitMs);
      }
    }
  }

  return {
    success: false,
    error: lastError,
    attempts: retryMax,
    finalStatus: lastStatus,
  };
}

/**
 * Validate that a JSF response contains a ViewState, indicating the session is alive.
 *
 * JSF applications return HTTP 200 even when the session has expired — they serve
 * the login page with a 200 status. This helper detects that pattern so callers
 * can retry with a fresh session instead of silently processing garbage data.
 */
export function validateJsfResponse(html: string, context: string): void {
  // Check 1: ViewState must be present in valid JSF responses
  if (!html.includes("javax.faces.ViewState")) {
    throw new Error(
      `${context}: Response missing ViewState — session may have expired. ` +
        `Got ${html.length} chars, no javax.faces.ViewState found.`
    );
  }

  // Check 2: Detect login-page patterns that indicate session expiry
  const lower = html.toLowerCase();
  if (
    (lower.includes("iniciar sesión") || lower.includes("iniciar sesion")) &&
    (lower.includes("password") || lower.includes("contraseña") || lower.includes("contrasena"))
  ) {
    throw new Error(
      `${context}: Response is a login page — session has expired.`
    );
  }
}

/**
 * Create a session-aware Axios instance that carries cookies across requests.
 * This is essential for JSF apps which require JSESSIONID + ViewState.
 */
export function createSessionClient(timeoutMs: number): {
  client: AxiosInstance;
  jar: Record<string, string>;
} {
  const jar: Record<string, string> = {};
  const client = createHttpClient(timeoutMs);

  // ── Request interceptor: inject cookies ──────────────────
  client.interceptors.request.use((config: InternalAxiosRequestConfig) => {
    const cookieStr = Object.entries(jar)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
    if (cookieStr) {
      config.headers.set("Cookie", cookieStr);
    }
    return config;
  });

  // ── Response interceptor: capture cookies ────────────────
  client.interceptors.response.use((response: AxiosResponse) => {
    const setCookies = response.headers["set-cookie"];
    if (Array.isArray(setCookies)) {
      for (const raw of setCookies) {
        const cookiePart = raw.split(";")[0]?.trim();
        if (cookiePart) {
          const eqIdx = cookiePart.indexOf("=");
          if (eqIdx > 0) {
            jar[cookiePart.slice(0, eqIdx)] = cookiePart.slice(eqIdx + 1);
          }
        }
      }
    }
    return response;
  });

  return { client, jar };
}
