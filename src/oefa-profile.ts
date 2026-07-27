/**
 * OEFA Profile — publico.oefa.gob.pe
 *
 * The OEFA site uses JSF + PrimeFaces:
 *   1. GET  /repdig/consulta/consultaTfa.xhtml → session + ViewState + form
 *   2. POST form with search filters → PrimeFaces AJAX response
 *   3. Parse DataTable rows from HTML
 *   4. Pagination via PrimeFaces partial requests
 *   5. PDF download via non-AJAX postback with param_uuid
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as cheerio from "cheerio";
import type { AxiosInstance } from "axios";
import type {
  AppConfig,
  ScrapedDocument,
  JsfSession,
  FailedDownload,
  Checkpoint,
} from "./types.js";
import { createSessionClient, withRetry, sleep, validateJsfResponse } from "./http-client.js";
import { log } from "./logger.js";
import { exportToExcel } from "./excel-export.js";

// ── Output paths ───────────────────────────────────────────────
const DATA_FILE = "documents.jsonl";
const FAILED_FILE = "failed-downloads.jsonl";
const CHECKPOINT_FILE = "checkpoint.json";

// ── PDF magic bytes ────────────────────────────────────────────
const PDF_MAGIC = Buffer.from("%PDF-");

// ── Max PDFs to download before stopping ──────────────────────
const MAX_PDFS_TO_DOWNLOAD = 20;

// ── Known form structure ───────────────────────────────────────
const FORM_ID = "listarDetalleInfraccionRAAForm";
const TABLE_ID = `${FORM_ID}:dt`;
const PAGINATOR_ID = `${TABLE_ID}_paginator_bottom`;
const SEARCH_BUTTON = `${FORM_ID}:btnBuscar`;

// ════════════════════════════════════════════════════════════════
//  OEFA SESSION INITIALIZATION
// ════════════════════════════════════════════════════════════════

export async function initSession(
  config: AppConfig
): Promise<{ client: AxiosInstance; session: JsfSession }> {
  const { client, jar } = createSessionClient(config.requestTimeoutMs);

  log.info("OEFA: Initializing session — GET consultaTfa.xhtml ...");

  const res = await client.get(
    "/consulta/consultaTfa.xhtml",
    { baseURL: config.baseUrl }
  );

  if (res.status !== 200) {
    throw new Error(`OEFA init failed: HTTP ${res.status}`);
  }

  const html = typeof res.data === "string" ? res.data : "";
  validateJsfResponse(html, "OEFA initSession");
  const $ = cheerio.load(html);

  const viewState =
    $('input[name="javax.faces.ViewState"]').val() as string | undefined;
  if (!viewState) {
    throw new Error("OEFA: Could not extract ViewState from consultaTfa.xhtml");
  }

  const session: JsfSession = {
    cookies: { ...jar },
    viewState,
    baseUrl: config.baseUrl,
  };

  log.success(
    `OEFA: Session initialized — ViewState length=${viewState.length}`
  );

  return { client, session };
}

// ════════════════════════════════════════════════════════════════
//  OEFA SEARCH
// ════════════════════════════════════════════════════════════════

export async function search(
  client: AxiosInstance,
  session: JsfSession,
  config: AppConfig
): Promise<string> {
  log.info("OEFA: Searching ...");

  const formData = new URLSearchParams();
  formData.append(FORM_ID, FORM_ID);
  // Leave search fields empty to get all results
  formData.append(`${FORM_ID}:txtNroexp`, "");
  formData.append("javax.faces.ViewState", session.viewState);

  // PrimeFaces AJAX: the search button triggers partial execute/render
  // CRITICAL: the button name MUST be included for JSF to process the action
  formData.append(SEARCH_BUTTON, SEARCH_BUTTON);
  formData.append("javax.faces.partial.ajax", "true");
  formData.append("javax.faces.source", SEARCH_BUTTON);
  formData.append("javax.faces.partial.execute", "@all");
  formData.append(
    "javax.faces.partial.render",
    `${FORM_ID}:pgLista ${FORM_ID}:txtNroexp`
  );
  formData.append("javax.faces.behavior.event", "action");
  formData.append("javax.faces.partial.event", "action");

  const res = await client.post(
    "/consulta/consultaTfa.xhtml",
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

  const html = typeof res.data === "string" ? res.data : "";

  // Validate session is alive (JSF returns 200 even on expiry)
  validateJsfResponse(html, "OEFA search");

  // Update ViewState from response
  updateViewStateFromResponse(html, session);

  log.success("OEFA: Search completed");
  return html;
}

// ════════════════════════════════════════════════════════════════
//  OEFA RESULT PARSING
// ════════════════════════════════════════════════════════════════

/**
 * Parse documents from the PrimeFaces DataTable.
 * OEFA uses a standard HTML table with 7 columns:
 *   Nro | N° Expediente | Administrado | Unidad fiscalizable | Sector | N° Resolución | Archivo
 *
 * Search responses update <update id="...pgLista"> with full DataTable HTML.
 * Pagination responses update <update id="{dt}"> with raw <tr> elements only.
 */
export function parseResults(
  html: string,
  page: number,
  session: JsfSession,
  totalRecordsFromSearch?: number,
  totalPagesFromSearch?: number
): {
  documents: Partial<ScrapedDocument>[];
  totalPages: number;
  currentPage: number;
  totalRecords: number;
} {
  const documents: Partial<ScrapedDocument>[] = [];

  // ── Extract HTML content from PrimeFaces partial response ──────
  let bodyHtml = html;
  let hasPaginatorText = false;

  if (html.includes("<partial-response")) {
    // Try pgLista first (search response — has full DataTable + paginator)
    const pgListaMatch = html.match(
      /<update id="listarDetalleInfraccionRAAForm:pgLista"><!\[CDATA\[([\s\S]*?)\]\]>/
    );
    if (pgListaMatch) {
      bodyHtml = pgListaMatch[1];
      hasPaginatorText = bodyHtml.includes("ui-paginator-current");
    } else {
      // Pagination response — DataTable ID with raw <tr> rows
      const updateMatch = html.match(
        new RegExp(
          `<update id="${TABLE_ID.replace(/:/g, "\\:")}"><!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`,
        )
      );
      if (updateMatch) {
        bodyHtml = updateMatch[1];
        // Pagination response has no paginator text
        hasPaginatorText = false;
      }
    }
  }

  // CRITICAL: <tr> elements outside <table> are dropped by cheerio's HTML parser.
  // Wrap raw content in <table> if it starts with <tr> to ensure proper parsing.
  if (bodyHtml.trimStart().startsWith("<tr")) {
    bodyHtml = "<table>" + bodyHtml + "</table>";
  }

  const $body = cheerio.load(bodyHtml);

  // ── Parse table rows ────────────────────────────────────
  // Search response: rows are inside #TABLE_ID_data tbody
  // Pagination response: rows are raw <tr> elements (no tbody ID)
  let rows = $body(`#${TABLE_ID.replace(/:/g, "\\:")}_data tr`);
  if (rows.length === 0) {
    // Fallback: try any tr inside the DataTable div
    rows = $body(`tr[data-ri]`);
  }

  rows.each((idx, row) => {
    const cells = $body(row).find("td");
    if (cells.length < 7) return; // Skip empty/header rows

    const nro = $body(cells[0]).text().trim();
    const nroExpediente = $body(cells[1]).text().trim();
    const administrado = $body(cells[2]).text().trim();
    const unidadFiscalizable = $body(cells[3]).text().trim();
    const sector = $body(cells[4]).text().trim();
    const nroResolucion = $body(cells[5]).text().trim();

    // ── Extract PDF URL from "Archivo" column ────────────
    let pdfUrl: string | null = null;
    let pdfBtnParam: string | null = null;
    const link = $body(cells[6]).find("a[onclick*='mojarra']").first();
    if (link.length) {
      const onclick = link.attr("onclick") ?? "";

      // Extract UUID and button param from mojarra.jsfcljs
      if (onclick.includes("mojarra.jsfcljs")) {
        const uuidMatch = onclick.match(/param_uuid['":\s]+['"]?([^'")\s,]+)/);
        if (uuidMatch) {
          pdfUrl = `${session.baseUrl}/consulta/descargaPdf.xhtml?param_uuid=${uuidMatch[1]}`;
          // Extract button param: {'btnName':'btnName','param_uuid':...}
          const btnMatch = onclick.match(/'([^']+)':'[^']*','param_uuid/);
          if (btnMatch) {
            pdfBtnParam = btnMatch[1];
          }
        }
      }
    }

    // Also check for image/pdf icons with onclick
    if (!pdfUrl) {
      $body(cells[6])
        .find("[onclick*='mojarra'], [onclick*='pdf'], [onclick*='uuid']")
        .each((_, el) => {
          const onclick = $body(el).attr("onclick") ?? "";
          if (onclick) {
            pdfUrl = buildPdfDownloadUrl(onclick, session.baseUrl);
          }
        });
    }

    // Build fields object
    const fields: Record<string, string> = {
      "N° Expediente": nroExpediente,
      Administrado: administrado,
      "Unidad fiscalizable": unidadFiscalizable,
      Sector: sector,
      "N° Resolución de Apelación": nroResolucion,
    };

    // Store button param for PDF download (hidden field)
    if (pdfBtnParam) {
      fields["_pdfBtnParam"] = pdfBtnParam;
    }

    const title = nroExpediente || `OEFA-${nro}`;
    const id = nro || generateId(title, page, idx);

    documents.push({
      source: "oefa",
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

  // ── Parse pagination ────────────────────────────────────
  let totalPages = totalPagesFromSearch ?? 1;
  let currentPage = page;
  let totalRecords = totalRecordsFromSearch ?? 0;

  // Only try to parse paginator text if present (search response has it)
  if (hasPaginatorText) {
    const pageText = $body(".ui-paginator-current").text();
    const pageMatch = pageText.match(
      /Página\s+(\d+)\s+de\s+(\d+)\s+\((\d+)\s+registros?\)/i
    );
    if (pageMatch) {
      currentPage = parseInt(pageMatch[1], 10);
      totalPages = parseInt(pageMatch[2], 10);
      totalRecords = parseInt(pageMatch[3], 10);
    }
  }

  return { documents, totalPages, currentPage, totalRecords };
}

// ════════════════════════════════════════════════════════════════
//  OEFA PAGINATION
// ════════════════════════════════════════════════════════════════

/**
 * Navigate to a specific page using PrimeFaces 6.0 DataTable paginate().
 *
 * Discovered from OEFA's actual components.js source code:
 *   params: [{dt}_pagination=true, {dt}_first=offset, {dt}_rows=10,
 *            {dt}_skipChildren=true, {dt}_encodeFeature=true]
 *   source/update/process: DataTable ID (NOT paginator ID)
 *   Response updates <update id="{dt}"> with raw <tr> elements.
 */
export async function goToPage(
  client: AxiosInstance,
  session: JsfSession,
  config: AppConfig,
  targetPage: number
): Promise<string> {
  const rowsPerPage = 10;
  const firstOffset = (targetPage - 1) * rowsPerPage;
  log.info(`OEFA: Navigating to page ${targetPage} (first=${firstOffset}) ...`);

  const formData = new URLSearchParams();
  // Form hidden fields
  formData.append(FORM_ID, FORM_ID);
  formData.append(`${TABLE_ID}_scrollState`, "0,0");
  formData.append("javax.faces.ViewState", session.viewState);

  // Standard JSF partial ajax headers
  formData.append("javax.faces.partial.ajax", "true");
  formData.append("javax.faces.source", TABLE_ID);
  formData.append("javax.faces.partial.execute", TABLE_ID);
  formData.append("javax.faces.partial.render", TABLE_ID);

  // PrimeFaces 6.0 DataTable paginate-specific params
  formData.append(`${TABLE_ID}_pagination`, "true");
  formData.append(`${TABLE_ID}_first`, String(firstOffset));
  formData.append(`${TABLE_ID}_rows`, String(rowsPerPage));
  formData.append(`${TABLE_ID}_skipChildren`, "true");
  formData.append(`${TABLE_ID}_encodeFeature`, "true");

  const res = await client.post(
    "/consulta/consultaTfa.xhtml",
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

  const html = typeof res.data === "string" ? res.data : "";

  // Validate session is alive (JSF returns 200 even on expiry)
  validateJsfResponse(html, `OEFA goToPage ${targetPage}`);

  // Update ViewState from response
  updateViewStateFromResponse(html, session);

  return html;
}

// ════════════════════════════════════════════════════════════════
//  PDF DOWNLOAD
// ════════════════════════════════════════════════════════════════

/**
 * Download a PDF document from OEFA.
 * OEFA uses a non-AJAX postback with mojarra.jsfcljs for PDF downloads.
 */
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
      log.info(`OEFA: PDF already exists — ${safeFilename}`);
      return safeFilename;
    }
  }

  // OEFA uses mojarra.jsfcljs postback for PDF downloads.
  // We simulate the form submission with the button param + param_uuid + ViewState.
  const btnParam = doc.fields["_pdfBtnParam"];
  if (!btnParam) {
    log.warn(`OEFA: No button param for ${doc.title} — skipping PDF`);
    return null;
  }

  // Extract UUID from pdfUrl
  const uuidMatch = doc.pdfUrl.match(/param_uuid=([^&]+)/);
  if (!uuidMatch) {
    log.warn(`OEFA: No UUID in pdfUrl for ${doc.title} — skipping PDF`);
    return null;
  }

  const result = await withRetry(
    async () => {
      const formData = new URLSearchParams();
      formData.append(FORM_ID, FORM_ID);
      formData.append(btnParam, btnParam);
      formData.append("param_uuid", uuidMatch[1]);
      formData.append("javax.faces.ViewState", session.viewState);

      return client.post(
        "/consulta/consultaTfa.xhtml",
        formData.toString(),
        {
          baseURL: session.baseUrl,
          responseType: "arraybuffer",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: `${session.baseUrl}/consulta/consultaTfa.xhtml`,
          },
        }
      );
    },
    {
      retryMax: config.retryMax,
      backoffMs: config.retryBackoffMs,
      label: `PDF download: ${doc.title}`,
    }
  );

  if (!result.success || !result.data) {
    log.error(`OEFA: Failed to download PDF — ${doc.title}: ${result.error}`);
    return null;
  }

  const buffer = Buffer.from(result.data as unknown as ArrayBuffer);

  // Validate PDF magic bytes
  if (!buffer.subarray(0, 5).equals(PDF_MAGIC)) {
    log.error(`OEFA: Response is not a valid PDF — ${doc.title}`);
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
    log.info(`OEFA: Found ${writtenIds.size} existing documents — will skip duplicates`);
  }

  // Load checkpoint if exists
  const checkpoint = loadCheckpoint(config);
  let startPage = checkpoint?.nextPage ?? 1;
  let positionOffset = checkpoint?.nextPosition ?? 0;
  let totalDocs = checkpoint?.totalDocuments ?? 0;
  let pdfsDownloaded = 0;
  const pdfLimit = MAX_PDFS_TO_DOWNLOAD;

  // Helper: download PDF + write to JSONL (single write, no duplicates)
  async function processDoc(doc: ScrapedDocument): Promise<boolean> {
    totalDocs++;
    log.progress(totalDocs, config.maxDocuments, `OEFA document: ${doc.title}`);

    if (config.downloadPdfs && doc.pdfUrl) {
      const filename = await downloadPdf(
        client, config, session, doc, config.outputDir
      );
      if (filename) {
        doc.pdfFile = filename;
        pdfsDownloaded++;
        log.success(
          `PDF downloads: ${pdfsDownloaded}/${pdfLimit}`
        );
      }
    }

    // Idempotent write: skip if this document ID was already written
    if (!writtenIds.has(doc.id)) {
      appendJsonl(jsonlPath, doc);
      writtenIds.add(doc.id);
    }
    await sleep(config.requestDelayMs);

    // Check stop conditions
    if (pdfsDownloaded >= pdfLimit) return true;
    return false;
  }

  // ── Main scraping logic (try/finally ensures Excel export) ──
  try {
  // Step 1: Search
  const searchHtml = await search(client, session, config);
  await sleep(config.requestDelayMs);

  // Step 2: Parse first page (from search response)
  if (startPage === 1) {
    const { documents, totalPages, totalRecords } = parseResults(
      searchHtml,
      1,
      session
    );

    log.info(`OEFA: Found ${totalRecords} records across ${totalPages} pages`);

    // Process first page
    for (let i = 0; i < documents.length; i++) {
      if (totalDocs >= config.maxDocuments) break;

      const stop = await processDoc(documents[i] as ScrapedDocument);
      if (stop) break;
    }

    if (pdfsDownloaded >= pdfLimit) {
      log.success(`OEFA: Reached ${pdfLimit} PDF downloads — stopping`);
      saveCheckpoint(config, {
        profile: "oefa", searchTerm: config.searchTerm,
        nextPage: 2, nextPosition: 0, totalDocuments: totalDocs,
        completed: true, timestamp: new Date().toISOString(),
      });
      log.success(`OEFA: Scraping complete — ${totalDocs} documents, ${pdfsDownloaded} PDFs`);
      return;
    }

    saveCheckpoint(config, {
      profile: "oefa",
      searchTerm: config.searchTerm,
      nextPage: 2,
      nextPosition: 0,
      totalDocuments: totalDocs,
      completed: totalPages <= 1,
      timestamp: new Date().toISOString(),
    });

    // Continue to remaining pages
    for (let page = 2; page <= config.maxPages; page++) {
      log.progress(page, config.maxPages, "OEFA page");

      const pageHtml = await goToPage(client, session, config, page);
      await sleep(config.requestDelayMs);

      const { documents, totalPages: pgTotal } = parseResults(
        pageHtml,
        page,
        session,
        totalRecords,
        totalPages
      );

      if (documents.length === 0) {
        log.warn(`OEFA: Page ${page} returned no documents — stopping.`);
        break;
      }

      for (let i = 0; i < documents.length; i++) {
        if (totalDocs >= config.maxDocuments) {
          log.info(`OEFA: Reached max documents limit (${config.maxDocuments})`);
          saveCheckpoint(config, {
            profile: "oefa", searchTerm: config.searchTerm,
            nextPage: page, nextPosition: i, totalDocuments: totalDocs,
            completed: true, timestamp: new Date().toISOString(),
          });
          return;
        }

        const stop = await processDoc(documents[i] as ScrapedDocument);
        if (stop) break;
      }

      if (pdfsDownloaded >= pdfLimit) {
        log.success(`OEFA: Reached ${pdfLimit} PDF downloads — stopping`);
        saveCheckpoint(config, {
          profile: "oefa", searchTerm: config.searchTerm,
          nextPage: page + 1, nextPosition: 0, totalDocuments: totalDocs,
          completed: true, timestamp: new Date().toISOString(),
        });
        break;
      }

      saveCheckpoint(config, {
        profile: "oefa",
        searchTerm: config.searchTerm,
        nextPage: page + 1,
        nextPosition: 0,
        totalDocuments: totalDocs,
        completed: page >= totalPages,
        timestamp: new Date().toISOString(),
      });

      if (page >= totalPages) {
        log.success(`OEFA: All pages scraped (${totalDocs} documents)`);
        break;
      }

      // If we got fewer than 10 rows, we've hit the last page
      if (documents.length < 10) {
        log.success(`OEFA: Last page reached (${totalDocs} documents)`);
        break;
      }
    }
  } else {
    // Resuming from checkpoint — navigate to start page
    log.info(`OEFA: Resuming from page ${startPage} ...`);
    for (let page = 2; page <= startPage; page++) {
      await goToPage(client, session, config, page);
      await sleep(config.requestDelayMs);
    }

    // Now scrape from startPage
    for (let page = startPage; page <= config.maxPages; page++) {
      log.progress(page, config.maxPages, "OEFA page");

      let pageHtml: string;
      if (page === startPage && positionOffset > 0) {
        // Navigate directly to the exact row offset
        const firstOffset = (page - 1) * 10;
        const fd = new URLSearchParams();
        fd.append(FORM_ID, FORM_ID);
        fd.append(`${TABLE_ID}_scrollState`, "0,0");
        fd.append("javax.faces.ViewState", session.viewState);
        fd.append("javax.faces.partial.ajax", "true");
        fd.append("javax.faces.source", TABLE_ID);
        fd.append("javax.faces.partial.execute", TABLE_ID);
        fd.append("javax.faces.partial.render", TABLE_ID);
        fd.append(`${TABLE_ID}_pagination`, "true");
        fd.append(`${TABLE_ID}_first`, String(firstOffset));
        fd.append(`${TABLE_ID}_rows`, "10");
        fd.append(`${TABLE_ID}_skipChildren`, "true");
        fd.append(`${TABLE_ID}_encodeFeature`, "true");

        const res = await client.post(
          "/consulta/consultaTfa.xhtml",
          fd.toString(),
          {
            baseURL: session.baseUrl,
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Faces: "request",
              "X-Requested-With": "XMLHttpRequest",
            },
          }
        );
        pageHtml = typeof res.data === "string" ? res.data : "";
        updateViewStateFromResponse(pageHtml, session);
      } else {
        pageHtml = await goToPage(client, session, config, page);
      }

      await sleep(config.requestDelayMs);

      const { documents, totalPages } = parseResults(pageHtml, page, session);

      if (documents.length === 0) {
        log.warn(`OEFA: Page ${page} returned no documents — stopping.`);
        break;
      }

      const startPos = page === startPage ? positionOffset : 0;
      for (let i = startPos; i < documents.length; i++) {
        if (totalDocs >= config.maxDocuments) {
          saveCheckpoint(config, {
            profile: "oefa", searchTerm: config.searchTerm,
            nextPage: page, nextPosition: i, totalDocuments: totalDocs,
            completed: true, timestamp: new Date().toISOString(),
          });
          return;
        }

        const stop = await processDoc(documents[i] as ScrapedDocument);
        if (stop) break;
      }

      if (pdfsDownloaded >= pdfLimit) {
        log.success(`OEFA: Reached ${pdfLimit} PDF downloads — stopping`);
        saveCheckpoint(config, {
          profile: "oefa", searchTerm: config.searchTerm,
          nextPage: page + 1, nextPosition: 0, totalDocuments: totalDocs,
          completed: true, timestamp: new Date().toISOString(),
        });
        break;
      }

      saveCheckpoint(config, {
        profile: "oefa",
        searchTerm: config.searchTerm,
        nextPage: page + 1,
        nextPosition: 0,
        totalDocuments: totalDocs,
        completed: page >= totalPages,
        timestamp: new Date().toISOString(),
      });

      if (page >= totalPages) {
        log.success(`OEFA: All pages scraped (${totalDocs} documents)`);
        break;
      }

      // If we got fewer than 10 rows, we've hit the last page
      if (documents.length < 10) {
        log.success(`OEFA: Last page reached (${totalDocs} documents)`);
        break;
      }
    }
  }

  log.success(`OEFA: Scraping complete — ${totalDocs} documents, ${pdfsDownloaded} PDFs`);
  } finally {
    // ── Export to Excel (always runs, even on early exit) ──
    exportToExcel(config.outputDir);
  }
}

// ════════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════════

/**
 * Build a PDF download URL from an onclick handler like:
 *   mojarra.jsfcljs('form',{param_uuid:'xxx'},'')
 */
export function buildPdfDownloadUrl(onclick: string, baseUrl: string): string {
  const uuidMatch = onclick.match(/param_uuid['":\s]+['"]?([^'")\s,]+)/);
  if (uuidMatch) {
    return `${baseUrl}/consulta/descargaPdf.xhtml?param_uuid=${uuidMatch[1]}`;
  }

  // Fallback: try to extract any UUID-like pattern
  const genericUuid = onclick.match(
    /['"]([0-9a-f-]{36})['"]/i
  );
  if (genericUuid) {
    return `${baseUrl}/consulta/descargaPdf.xhtml?param_uuid=${genericUuid[1]}`;
  }

  return "";
}

export function updateViewStateFromResponse(html: string, session: JsfSession): void {
  // Try partial response XML first — PrimeFaces may prefix with a component ID
  const vsMatch = html.match(
    /<update id="[^"]*javax\.faces\.ViewState[^"]*">(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/update>/s
  );
  if (vsMatch) {
    session.viewState = vsMatch[1].trim();
    return;
  }

  // Fallback: full HTML
  const $ = cheerio.load(html);
  const vs = $('input[name="javax.faces.ViewState"]').val() as
    | string
    | undefined;
  if (vs) {
    session.viewState = vs;
  }
}

export function generateId(title: string, page: number, position: number): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40);
  return `${slug}-p${page}-${position}`;
}

export function makeSafeFilename(doc: ScrapedDocument): string {
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
export function loadExistingJsonlIds(filePath: string): Set<string> {
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
    if (cp.profile !== "oefa") return null;
    return cp;
  } catch {
    return null;
  }
}
