/**
 * PJ Profile — jurisprudencia.pj.gob.pe
 *
 * The PJ site uses JSF + RichFaces:
 *   1. GET  /faces/page/inicio.xhtml  → session + ViewState + search form
 *   2. POST /faces/page/inicio.xhtml  → formBuscador search → redirect to resultado.xhtml
 *   3. GET  /faces/page/resultado.xhtml → parse result panels
 *   4. POST for pagination (RichFaces spinner postback)
 *   5. GET  /ServletDescarga?uuid=... → PDF download
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import type { AxiosInstance, AxiosResponse } from "axios";
import type {
  AppConfig,
  ScrapedDocument,
  JsfSession,
  FailedDownload,
  Checkpoint,
} from "./types.js";
import { createSessionClient, withRetry, sleep, validateJsfResponse } from "./http-client.js";
import { log } from "./logger.js";

// ── Output paths ───────────────────────────────────────────────
const DATA_FILE = "documents.jsonl";
const FAILED_FILE = "failed-downloads.jsonl";
const CHECKPOINT_FILE = "checkpoint.json";

// ── PDF magic bytes ────────────────────────────────────────────
const PDF_MAGIC = Buffer.from("%PDF-");

// ════════════════════════════════════════════════════════════════
//  PJ SESSION INITIALIZATION
// ════════════════════════════════════════════════════════════════

export async function initSession(
  config: AppConfig
): Promise<{ client: AxiosInstance; session: JsfSession }> {
  const { client, jar } = createSessionClient(config.requestTimeoutMs);

  log.info("PJ: Initializing session — GET inicio.xhtml ...");

  const res = await client.get(
    "/faces/page/inicio.xhtml",
    { baseURL: config.baseUrl }
  );

  if (res.status !== 200) {
    if (res.status === 403) {
      throw new Error(
        "PJ site returned 403 Forbidden. You likely need a VPN with " +
          "an exit node in Peru. Connect your VPN and try again."
      );
    }
    throw new Error(`PJ init failed: HTTP ${res.status}`);
  }

  const html = typeof res.data === "string" ? res.data : "";
  validateJsfResponse(html, "PJ initSession");

  const $ = cheerio.load(res.data as string);

  // Extract ViewState
  const viewState =
    $('input[name="javax.faces.ViewState"]').val() as string | undefined;
  if (!viewState) {
    throw new Error("PJ: Could not extract ViewState from inicio.xhtml");
  }

  // Extract form ID
  const formId = $("form").first().attr("id") ?? "formBuscador";

  const session: JsfSession = {
    cookies: { ...jar },
    viewState,
    baseUrl: config.baseUrl,
  };

  log.success(
    `PJ: Session initialized — form="${formId}", ViewState length=${viewState.length}`
  );

  return { client, session };
}

// ════════════════════════════════════════════════════════════════
//  PJ SEARCH
// ════════════════════════════════════════════════════════════════

export async function search(
  client: AxiosInstance,
  session: JsfSession,
  config: AppConfig
): Promise<void> {
  log.info(`PJ: Searching — "${config.searchTerm}" ...`);

  const formData = new URLSearchParams();
  formData.append("formBuscador", "formBuscador");
  formData.append("formBuscador:txtBusqueda", config.searchTerm);
  formData.append("formBuscador:btnBuscar", "Buscar");
  formData.append("javax.faces.ViewState", session.viewState);

  const res = await client.post(
    "/faces/page/inicio.xhtml",
    formData.toString(),
    {
      baseURL: session.baseUrl,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      maxRedirects: 5,
    }
  );

  // RichFaces may redirect to resultado.xhtml
  // Check if we ended up on the results page
  const html = typeof res.data === "string" ? res.data : "";

  // Validate session is alive (JSF returns 200 even on expiry)
  validateJsfResponse(html, "PJ search");

  // Update ViewState from response
  const $ = cheerio.load(html);
  const newViewState =
    $('input[name="javax.faces.ViewState"]').val() as string | undefined;
  if (newViewState) {
    session.viewState = newViewState;
  }

  log.success("PJ: Search completed");
}

// ════════════════════════════════════════════════════════════════
//  PJ RESULT PARSING
// ════════════════════════════════════════════════════════════════

/**
 * Parse documents from a RichFaces results page.
 * PJ uses `div.rf-p[id^="formBuscador:repeat:"]` panels for each document.
 */
export function parseResults(
  html: string,
  page: number,
  baseUrl: string
): {
  documents: Partial<ScrapedDocument>[];
  totalPages: number;
  currentPage: number;
} {
  const $ = cheerio.load(html);
  const documents: Partial<ScrapedDocument>[] = [];

  // ── Extract panels ─────────────────────────────────────
  // PJ RichFaces panels have class "rf-p" or id pattern "formBuscador:repeat:N"
  const panels = $('div.rf-p, div[id^="formBuscador:repeat:"]');

  panels.each((idx, panel) => {
    const $panel = $(panel);
    const fields: Record<string, string> = {};

    // Extract header (usually contains recurso + expediente)
    const header = $panel.find(".rf-p-hdr, .rf-p-sh").text().trim();
    if (header) {
      fields["_header"] = header;
    }

    // Extract label/value pairs from the panel body
    $panel
      .find(".rf-p-br, .rf-p-b, table tr, dl dt, dl dd")
      .each((_, el) => {
        const text = $(el).text().trim();
        if (text) {
          // Try to split label: value
          const colonMatch = text.match(/^(.+?):\s*(.+)$/);
          if (colonMatch) {
            fields[colonMatch[1].trim()] = colonMatch[2].trim();
          }
        }
      });

    // Also try table rows within the panel
    $panel.find("tr").each((_, tr) => {
      const cells = $(tr).find("td, th");
      if (cells.length >= 2) {
        const label = $(cells[0]).text().trim().replace(/:$/, "");
        const value = $(cells[1]).text().trim();
        if (label && value) {
          fields[label] = value;
        }
      }
    });

    // Extract UUID from download link
    let pdfUrl: string | null = null;

    // Check href attributes first
    const hrefLinks = $panel.find(
      'a[href*="ServletDescarga"], a[href*="uuid="]'
    );
    for (const a of hrefLinks.toArray()) {
      const href = $(a).attr("href");
      if (href && !pdfUrl) {
        pdfUrl = href.startsWith("http")
          ? href
          : `${baseUrl}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    }

    // Also check for onclick handlers with uuid
    if (!pdfUrl) {
      const onclickEls = $panel.find("[onclick*='uuid']");
      for (const el of onclickEls.toArray()) {
        const onclick = $(el).attr("onclick") ?? "";
        const uuidMatch = onclick.match(/uuid=([^&'"]+)/);
        if (uuidMatch) {
          pdfUrl = `${baseUrl}/ServletDescarga?uuid=${uuidMatch[1]}`;
        }
      }
    }

    // Build title from header or first meaningful field
    const title =
      fields["Recurso"] && fields["Expediente"]
        ? `${fields["Recurso"]} ${fields["Expediente"]}`
        : header || `Document ${idx + 1}`;

    // Generate ID from UUID if available
    const uuidMatch = pdfUrl ? pdfUrl.match(/uuid=([^&]+)/) : null;
    const id = uuidMatch ? uuidMatch[1] : generateId(title, page, idx);

    documents.push({
      source: "pj",
      page,
      position: idx + 1,
      id,
      title,
      fields,
      pdfUrl,
      pdfFile: null,
      scrapedAt: new Date().toISOString(),
    });
  });

  // ── Extract pagination info ─────────────────────────────
  let totalPages = 1;
  let currentPage = page;

  // RichFaces pagination may be in a spinner or page display
  const pageText = $(".rf-pg-lbl, .rf-paging-str").text();
  const pageMatch = pageText.match(/(\d+)\s*(?:de|of)\s*(\d+)/i);
  if (pageMatch) {
    currentPage = parseInt(pageMatch[1], 10);
    totalPages = parseInt(pageMatch[2], 10);
  }

  return { documents, totalPages, currentPage };
}

// ════════════════════════════════════════════════════════════════
//  PJ PAGINATION
// ════════════════════════════════════════════════════════════════

/**
 * Navigate to a specific page using RichFaces postback.
 */
export async function goToPage(
  client: AxiosInstance,
  session: JsfSession,
  config: AppConfig,
  targetPage: number
): Promise<string> {
  log.info(`PJ: Navigating to page ${targetPage} ...`);

  // RichFaces uses a spinner input for page navigation
  const formData = new URLSearchParams();
  formData.append("formBuscador", "formBuscador");
  formData.append("formBuscador:sbxPagina", String(targetPage));
  formData.append("formBuscador:btnIr", "IR");
  formData.append("javax.faces.ViewState", session.viewState);
  // RichFaces partial execution
  formData.append(
    "javax.faces.partial.ajax",
    "true"
  );
  formData.append(
    "javax.faces.source",
    "formBuscador:btnIr"
  );
  formData.append("javax.faces.partial.execute", "formBuscador");
  formData.append("javax.faces.partial.render", "formBuscador:resultados");

  const res = await client.post(
    "/faces/page/resultado.xhtml",
    formData.toString(),
    {
      baseURL: session.baseUrl,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Faces: "request",
        "X-Requested-With": "XMLHttpRequest",
      },
    }
  );

  const data = res.data as string;

  // Validate session is alive (JSF returns 200 even on expiry)
  validateJsfResponse(data, `PJ goToPage ${targetPage}`);

  // Update ViewState
  const $ = cheerio.load(data);
  const newViewState =
    $('partial-response')?.find('update[id="javax.faces.ViewState"]')?.text() ??
    (() => {
      const $full = cheerio.load(data);
      return (
        $full('input[name="javax.faces.ViewState"]').val() as string | undefined
      );
    })();

  if (newViewState) {
    session.viewState = newViewState;
  }

  return data;
}

// ════════════════════════════════════════════════════════════════
//  PDF DOWNLOAD
// ════════════════════════════════════════════════════════════════

export async function downloadPdf(
  client: AxiosInstance,
  config: AppConfig,
  session: JsfSession,
  doc: ScrapedDocument,
  outputDir: string
): Promise<string | null> {
  if (!doc.pdfUrl) return null;

  const safeFilename = makeSafeFilename(doc);
  const destPath = path.join(outputDir, "pdfs", safeFilename);

  // Skip if already downloaded
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    if (stat.size > 0) {
      log.info(`PJ: PDF already exists — ${safeFilename}`);
      return safeFilename;
    }
  }

  const result = await withRetry(
    () =>
      client.get(doc.pdfUrl!, {
        baseURL: session.baseUrl,
        responseType: "arraybuffer",
      }),
    {
      retryMax: config.retryMax,
      backoffMs: config.retryBackoffMs,
      label: `PDF download: ${doc.title}`,
    }
  );

  if (!result.success || !result.data) {
    log.error(`PJ: Failed to download PDF — ${doc.title}: ${result.error}`);
    return null;
  }

  const buffer = Buffer.from(result.data as unknown as ArrayBuffer);

  // Validate PDF magic bytes
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    log.error(`PJ: Response is not a valid PDF — ${doc.title}`);
    return null;
  }

  // Ensure directory exists
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, buffer);

  log.download(safeFilename);
  return safeFilename;
}

// ════════════════════════════════════════════════════════════════
//  MAIN SCRAPING LOOP
// ════════════════════════════════════════════════════════════════

export async function scrape(config: AppConfig): Promise<void> {
  const { client, session } = await initSession(config);

  // Ensure output directory
  fs.mkdirSync(config.outputDir, { recursive: true });
  fs.mkdirSync(path.join(config.outputDir, "pdfs"), { recursive: true });

  // Load existing document IDs for idempotent writes
  const jsonlPath = path.join(config.outputDir, DATA_FILE);
  const writtenIds = loadExistingJsonlIds(jsonlPath);
  if (writtenIds.size > 0) {
    log.info(`PJ: Found ${writtenIds.size} existing documents — will skip duplicates`);
  }

  // Load checkpoint if exists
  const checkpoint = loadCheckpoint(config);
  let startPage = checkpoint?.nextPage ?? 1;
  let positionOffset = checkpoint?.nextPosition ?? 0;
  let totalDocs = checkpoint?.totalDocuments ?? 0;

  // Step 1: Search
  await search(client, session, config);
  await sleep(config.requestDelayMs);

  // Step 2: If resuming from checkpoint, navigate to the right page
  if (startPage > 1) {
    log.info(`PJ: Resuming from page ${startPage} ...`);
    for (let p = 2; p <= startPage; p++) {
      const pageHtml = await goToPage(client, session, config, p);
      await sleep(config.requestDelayMs);
      // We only need the final page's HTML for parsing
      if (p === startPage) {
        const { documents, totalPages } = parseResults(pageHtml, p, session.baseUrl);
        totalDocs = documents.length > 0 ? totalDocs : totalDocs;
      }
    }
  }

  // Step 3: Scrape pages
  for (let page = startPage; page <= config.maxPages; page++) {
    log.progress(page, config.maxPages, "PJ page");

    let pageHtml: string;
    if (page === 1 && startPage === 1) {
      // First page — we need to get the HTML from the search result
      // The search redirect gives us resultado.xhtml
      const res = await client.get("/faces/page/resultado.xhtml", {
        baseURL: session.baseUrl,
      });
      pageHtml = typeof res.data === "string" ? res.data : "";

      // Update ViewState
      const $ = cheerio.load(pageHtml);
      const newViewState =
        $('input[name="javax.faces.ViewState"]').val() as string | undefined;
      if (newViewState) {
        session.viewState = newViewState;
      }
    } else if (page > 1) {
      pageHtml = await goToPage(client, session, config, page);
    } else {
      continue; // Skip pages before startPage
    }

    await sleep(config.requestDelayMs);

    const { documents, totalPages } = parseResults(pageHtml, page, session.baseUrl);

    if (documents.length === 0) {
      log.warn(`PJ: Page ${page} returned no documents — stopping.`);
      break;
    }

    // Process documents
    const startPos = page === startPage ? positionOffset : 0;
    for (let i = startPos; i < documents.length; i++) {
      if (totalDocs >= config.maxDocuments) {
        log.info(`PJ: Reached max documents limit (${config.maxDocuments})`);
        saveCheckpoint(config, {
          profile: "pj",
          searchTerm: config.searchTerm,
          nextPage: page,
          nextPosition: i,
          totalDocuments: totalDocs,
          completed: true,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const doc = documents[i] as ScrapedDocument;
      totalDocs++;

      log.progress(
        totalDocs,
        config.maxDocuments,
        `PJ document: ${doc.title}`
      );

      // Download PDF if enabled (before writing, so pdfFile is set on first write)
      if (config.downloadPdfs && doc.pdfUrl) {
        const filename = await downloadPdf(client, config, session, doc, config.outputDir);
        if (filename) {
          doc.pdfFile = filename;
        }
      }

      // Write document to JSONL (ONCE — idempotent)
      if (!writtenIds.has(doc.id)) {
        appendJsonl(jsonlPath, doc);
        writtenIds.add(doc.id);
      }

      await sleep(config.requestDelayMs);
    }

    // Save checkpoint after each page
    saveCheckpoint(config, {
      profile: "pj",
      searchTerm: config.searchTerm,
      nextPage: page + 1,
      nextPosition: 0,
      totalDocuments: totalDocs,
      completed: page >= totalPages,
      timestamp: new Date().toISOString(),
    });

    if (page >= totalPages) {
      log.success(`PJ: All pages scraped (${totalPages} pages, ${totalDocs} documents)`);
      break;
    }
  }

  // Final checkpoint
  saveCheckpoint(config, {
    profile: "pj",
    searchTerm: config.searchTerm,
    nextPage: config.maxPages + 1,
    nextPosition: 0,
    totalDocuments: totalDocs,
    completed: true,
    timestamp: new Date().toISOString(),
  });

  log.success(`PJ: Scraping complete — ${totalDocs} documents`);
}

// ════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════

function generateId(title: string, page: number, position: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  return `${slug}-p${page}-${position}`;
}

function makeSafeFilename(doc: ScrapedDocument): string {
  const slug = doc.title
    .replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ\s-]/g, "")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return `${slug}_${doc.id.slice(0, 12)}.pdf`;
}

function appendJsonl(filePath: string, data: unknown): void {
  const line = JSON.stringify(data) + "\n";
  fs.appendFileSync(filePath, line, "utf-8");
}

/**
 * Load document IDs already present in a JSONL file.
 * Used to make append operations idempotent — resuming a scraped run
 * will not duplicate documents that were written before interruption.
 */
function loadExistingJsonlIds(filePath: string): Set<string> {
  const ids = new Set<string>();
  if (!fs.existsSync(filePath)) return ids;

  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return ids;

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const doc = JSON.parse(line) as { id?: string };
        if (doc.id) ids.add(doc.id);
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error — start fresh
  }

  return ids;
}

export function saveCheckpoint(config: AppConfig, checkpoint: Checkpoint): void {
  const filePath = path.join(config.outputDir, CHECKPOINT_FILE);
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
}

export function loadCheckpoint(config: AppConfig): Checkpoint | null {
  const filePath = path.join(config.outputDir, CHECKPOINT_FILE);
  if (!fs.existsSync(filePath)) return null;

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const cp = JSON.parse(raw) as Checkpoint;
    if (cp.completed) return null;
    if (cp.profile !== "pj" || cp.searchTerm !== config.searchTerm) return null;
    return cp;
  } catch {
    return null;
  }
}

// Re-export session for use in main
export { type JsfSession };
