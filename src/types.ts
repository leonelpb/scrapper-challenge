// ── Profile identifiers ────────────────────────────────────────
export type ProfileId = "pj" | "oefa";

// ── Scraped document ───────────────────────────────────────────
export interface ScrapedDocument {
  source: ProfileId;
  page: number;
  position: number;
  id: string;
  title: string;
  fields: Record<string, string>;
  pdfUrl: string | null;
  pdfFile: string | null;
  scrapedAt: string;
}

// ── Checkpoint for resumability ────────────────────────────────
export interface Checkpoint {
  profile: ProfileId;
  searchTerm: string;
  nextPage: number;
  nextPosition: number;
  totalDocuments: number;
  completed: boolean;
  timestamp: string;
}

// ── Failed download record ─────────────────────────────────────
export interface FailedDownload {
  documentId: string;
  title: string;
  pdfUrl: string;
  httpStatus: number | null;
  error: string;
  attempts: number;
  timestamp: string;
}

// ── JSF session state (shared by both profiles) ────────────────
export interface JsfSession {
  cookies: Record<string, string>;
  viewState: string;
  baseUrl: string;
}

// ── Profile-specific scraping context ──────────────────────────
export interface ScrapingContext {
  config: AppConfig;
  session: JsfSession;
  documents: ScrapedDocument[];
  failedDownloads: FailedDownload[];
  checkpoint: Checkpoint;
}

// ── Application configuration ──────────────────────────────────
export interface AppConfig {
  profile: ProfileId;
  baseUrl: string;
  searchTerm: string;
  maxPages: number;
  maxDocuments: number;
  requestDelayMs: number;
  requestTimeoutMs: number;
  retryMax: number;
  retryBackoffMs: number;
  downloadPdfs: boolean;
  outputDir: string;
  // PJ-specific
  pjBaseUrl?: string;
  pjSearchTerm?: string;
  // OEFA-specific
  oefaBaseUrl?: string;
  oefaSector?: string;
}

// ── Retry result ───────────────────────────────────────────────
export interface RetryResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  attempts: number;
  finalStatus?: number;
}

// ── CLI arguments ──────────────────────────────────────────────
export interface CliArgs {
  profile?: ProfileId;
  query?: string;
  output?: string;
  startPage?: number;
  maxPages?: number;
  maxDocuments?: number;
  delayMs?: number;
  retries?: number;
  noPdf?: boolean;
  help?: boolean;
}
