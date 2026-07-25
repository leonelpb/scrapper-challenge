import type { AppConfig, ProfileId } from "./types.js";

/**
 * Build application configuration from environment variables.
 * Environment variables are loaded by dotenv in index.ts before this runs.
 */
export function buildConfig(profileOverride?: ProfileId): AppConfig {
  const profile: ProfileId =
    profileOverride ?? (process.env.PROFILE as ProfileId) ?? "oefa";

  // ── Base URLs per profile ──────────────────────────────────
  const baseUrls: Record<ProfileId, string> = {
    pj:
      process.env.PJ_BASE_URL ??
      "https://jurisprudencia.pj.gob.pe/jurisprudenciaweb",
    oefa:
      process.env.OEFA_BASE_URL ??
      "https://publico.oefa.gob.pe/repdig",
  };

  // ── Search terms per profile ───────────────────────────────
  const searchTerms: Record<ProfileId, string> = {
    pj: process.env.PJ_SEARCH_TERM ?? "contrato de trabajo",
    oefa: "", // OEFA uses empty search (returns all)
  };

  const maxDocuments = parseIntEnv("MAX_DOCUMENTS", 0);
  const maxPages = parseIntEnv("MAX_PAGES", 3);

  return {
    profile,
    baseUrl: baseUrls[profile],
    searchTerm: searchTerms[profile],
    maxPages: maxPages === 0 ? Infinity : maxPages,
    maxDocuments: maxDocuments === 0 ? Infinity : maxDocuments,
    requestDelayMs: parseIntEnv("REQUEST_DELAY_MS", 1500),
    requestTimeoutMs: parseIntEnv("REQUEST_TIMEOUT_MS", 60_000),
    retryMax: parseIntEnv("RETRY_MAX", 5),
    retryBackoffMs: parseIntEnv("RETRY_BACKOFF_MS", 1000),
    downloadPdfs: process.env.DOWNLOAD_PDFS !== "0",
    outputDir: `output/${profile}`,
    pjBaseUrl: process.env.PJ_BASE_URL,
    pjSearchTerm: process.env.PJ_SEARCH_TERM,
    oefaBaseUrl: process.env.OEFA_BASE_URL,
    oefaSector: process.env.OEFA_SECTOR,
  };
}

function parseIntEnv(key: string, defaultValue: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return defaultValue;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}
