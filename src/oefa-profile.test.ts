import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseResults,
  buildPdfDownloadUrl,
  generateId,
  makeSafeFilename,
  updateViewStateFromResponse,
  loadExistingJsonlIds,
  saveCheckpoint,
  loadCheckpoint,
} from "./oefa-profile.js";
import { withRetry, validateJsfResponse } from "./http-client.js";
import { exportToExcel } from "./excel-export.js";
import type { JsfSession, ScrapedDocument, Checkpoint, AppConfig } from "./types.js";

// PJ profile functions
import { parseResults as pjParseResults } from "./pj-profile.js";
import {
  saveCheckpoint as pjSaveCheckpoint,
  loadCheckpoint as pjLoadCheckpoint,
} from "./pj-profile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "__fixtures__");

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), "utf-8");
}

function makeSession(overrides?: Partial<JsfSession>): JsfSession {
  return {
    cookies: {},
    viewState: "initial-view-state",
    baseUrl: "https://publico.oefa.gob.pe/repdig",
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════
//  parseResults
// ════════════════════════════════════════════════════════════════

describe("parseResults", () => {
  it("parses search response with pgLista update (full DataTable + paginator)", () => {
    const html = readFixture("oefa-search-response.html");
    const session = makeSession();
    const result = parseResults(html, 1, session);

    assert.equal(result.documents.length, 4, "should parse 4 rows");
    assert.equal(result.totalPages, 2);
    assert.equal(result.currentPage, 1);
    assert.equal(result.totalRecords, 18);

    // First row — has PDF link
    const doc1 = result.documents[0];
    assert.equal(doc1.title, "891-08-PRODUCE/DIGSECOVI-Dsvs");
    assert.ok(doc1.pdfUrl?.includes("153a6d2a-cbed-40ef-b8ef-cd2272b19867"));
    assert.equal(
      doc1.fields["_pdfBtnParam"],
      "listarDetalleInfraccionRAAForm:dt:0:j_idt63"
    );
    assert.equal(doc1.source, "oefa");
    assert.equal(doc1.page, 1);
    assert.equal(doc1.position, 1);

    // Second row
    const doc2 = result.documents[1];
    assert.equal(doc2.title, "857-2011-PRODUCE/DIGSECOVI-Dsvs");
    assert.ok(doc2.pdfUrl?.includes("9c8d4d4a-846f-4e41-b047-4dbb8b1d2571"));
    assert.equal(
      doc2.fields["_pdfBtnParam"],
      "listarDetalleInfraccionRAAForm:dt:1:j_idt63"
    );

    // Fourth row — no PDF link
    const doc4 = result.documents[3];
    assert.equal(doc4.title, "NO-PDF-001-PRODUCE/DIGSECOVI");
    assert.equal(doc4.pdfUrl, null);
    assert.equal(doc4.fields["_pdfBtnParam"], undefined);
  });

  it("parses pagination response with raw <tr> rows in CDATA", () => {
    const html = readFixture("oefa-pagination-response.html");
    const session = makeSession();
    const result = parseResults(html, 2, session);

    assert.equal(result.documents.length, 2, "should parse 2 rows");
    // Pagination response has no paginator text
    assert.equal(result.totalPages, 1);
    assert.equal(result.currentPage, 2);

    const doc1 = result.documents[0];
    assert.equal(doc1.title, "012-2010-PRODUCE/DIGSECOVI-Dsvs");
    assert.ok(doc1.pdfUrl?.includes("aaaa-bbbb-cccc-dddd-111111111111"));
    assert.equal(doc1.page, 2);
    assert.equal(doc1.position, 1);

    const doc2 = result.documents[1];
    assert.equal(doc2.title, "013-2010-PRODUCE/DIGSECOVI-Dsvs");
    assert.ok(doc2.pdfUrl?.includes("aaaa-bbbb-cccc-dddd-222222222222"));
    assert.equal(doc2.position, 2);
  });

  it("returns empty documents for response with no table rows", () => {
    const html =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<partial-response><change id="listarDetalleInfraccionRAAForm:pgLista"><![CDATA[' +
      '<div id="listarDetalleInfraccionRAAForm:pgLista" class="ui-datatable">' +
      '<table id="listarDetalleInfraccionRAAForm:dt"><tbody id="listarDetalleInfraccionRAAForm:dt_data">' +
      "</tbody></table></div>]]></change></partial-response>";
    const session = makeSession();
    const result = parseResults(html, 1, session);

    assert.equal(result.documents.length, 0);
  });

  it("uses totalRecordsFromSearch and totalPagesFromSearch when provided", () => {
    const html = readFixture("oefa-pagination-response.html");
    const session = makeSession();
    const result = parseResults(html, 3, session, 500, 50);

    assert.equal(result.totalRecords, 500);
    assert.equal(result.totalPages, 50);
  });

  it("extracts all field columns correctly", () => {
    const html = readFixture("oefa-search-response.html");
    const session = makeSession();
    const result = parseResults(html, 1, session);

    const doc = result.documents[0];
    assert.equal(doc.fields["N° Expediente"], "891-08-PRODUCE/DIGSECOVI-Dsvs");
    assert.equal(doc.fields["Administrado"], "Corporación del Mar S.A.");
    assert.equal(
      doc.fields["Unidad fiscalizable"],
      "Planta Playa Lado Norte Puerto Malabrigo"
    );
    assert.equal(doc.fields["Sector"], "Pesquería");
    assert.equal(doc.fields["N° Resolución de Apelación"], "264-2012-OEFA/TFA");
  });
});

// ════════════════════════════════════════════════════════════════
//  buildPdfDownloadUrl
// ════════════════════════════════════════════════════════════════

describe("buildPdfDownloadUrl", () => {
  const BASE = "https://publico.oefa.gob.pe/repdig";

  it("extracts UUID from mojarra.jsfcljs onclick", () => {
    const onclick =
      "mojarra.jsfcljs('form',{listarDetalleInfraccionRAAForm:'listarDetalleInfraccionRAAForm'," +
      "'listarDetalleInfraccionRAAForm:dt:0:j_idt63':'listarDetalleInfraccionRAAForm:dt:0:j_idt63'," +
      "'param_uuid':'153a6d2a-cbed-40ef-b8ef-cd2272b19867'},'');return false";
    const url = buildPdfDownloadUrl(onclick, BASE);
    assert.equal(
      url,
      `${BASE}/consulta/descargaPdf.xhtml?param_uuid=153a6d2a-cbed-40ef-b8ef-cd2272b19867`
    );
  });

  it("extracts UUID with different quoting styles", () => {
    const onclick = "mojarra.jsfcljs('f',{param_uuid:\"abc-123-def-456-ghi\"},'')";
    const url = buildPdfDownloadUrl(onclick, BASE);
    assert.ok(url.includes("abc-123-def-456-ghi"));
  });

  it("falls back to generic UUID pattern", () => {
    const onclick = "someAction('a9b8c7d6-e5f4-3210-fedc-ba9876543210')";
    const url = buildPdfDownloadUrl(onclick, BASE);
    assert.ok(url.includes("a9b8c7d6-e5f4-3210-fedc-ba9876543210"));
  });

  it("returns empty string when no UUID found", () => {
    const onclick = "someAction('no-uuid-here')";
    const url = buildPdfDownloadUrl(onclick, BASE);
    assert.equal(url, "");
  });
});

// ════════════════════════════════════════════════════════════════
//  generateId
// ════════════════════════════════════════════════════════════════

describe("generateId", () => {
  it("creates slug from title with page and position", () => {
    const id = generateId("891-08-PRODUCE/DIGSECOVI-Dsvs", 1, 0);
    assert.equal(id, "891-08-produce-digsecovi-dsvs-p1-0");
  });

  it("truncates long titles to 40 chars", () => {
    const long = "A".repeat(100);
    const id = generateId(long, 2, 5);
    assert.ok(id.length < 60);
    assert.ok(id.endsWith("-p2-5"));
  });

  it("lowercases and replaces non-alphanumeric chars", () => {
    const id = generateId("Hello World", 1, 0);
    assert.equal(id, "hello-world-p1-0");
  });
});

// ════════════════════════════════════════════════════════════════
//  makeSafeFilename
// ════════════════════════════════════════════════════════════════

describe("makeSafeFilename", () => {
  it("creates safe filename from doc with special chars", () => {
    const doc: ScrapedDocument = {
      source: "oefa",
      page: 1,
      position: 1,
      id: "123456789012345",
      title: "891-08-PRODUCE/DIGSECOVI-Dsvs",
      fields: {},
      pdfUrl: null,
      pdfFile: null,
      scrapedAt: "",
    };
    const name = makeSafeFilename(doc);
    assert.ok(name.endsWith(".pdf"));
    assert.ok(name.startsWith("891-08-PRODUCEDIGSECOVI-Dsvs"));
    assert.ok(!name.includes("/"));
    assert.ok(!name.includes("\\"));
  });

  it("truncates long titles to 80 chars", () => {
    const doc: ScrapedDocument = {
      source: "oefa",
      page: 1,
      position: 1,
      id: "abc123",
      title: "A".repeat(200),
      fields: {},
      pdfUrl: null,
      pdfFile: null,
      scrapedAt: "",
    };
    const name = makeSafeFilename(doc);
    const slugPart = name.replace(/_[^.]+\.pdf$/, "");
    assert.ok(slugPart.length <= 80);
  });

  it("preserves Spanish accented characters", () => {
    const doc: ScrapedDocument = {
      source: "oefa",
      page: 1,
      position: 1,
      id: "abc123",
      title: "Resolución Ñoño Árbol Épica",
      fields: {},
      pdfUrl: null,
      pdfFile: null,
      scrapedAt: "",
    };
    const name = makeSafeFilename(doc);
    assert.ok(name.includes("Resolución"));
    assert.ok(name.includes("Ñoño"));
  });
});

// ════════════════════════════════════════════════════════════════
//  updateViewStateFromResponse
// ════════════════════════════════════════════════════════════════

describe("updateViewStateFromResponse", () => {
  it("extracts ViewState from partial-response XML", () => {
    const session = makeSession();
    const html =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<partial-response><update id="javax.faces.ViewState">' +
      "<![CDATA[new-view-state-abc123]]>" +
      "</update></partial-response>";

    updateViewStateFromResponse(html, session);
    assert.equal(session.viewState, "new-view-state-abc123");
  });

  it("extracts ViewState with component ID prefix", () => {
    const session = makeSession();
    const html =
      '<partial-response><update id="someForm:javax.faces.ViewState">' +
      "<![CDATA[prefixed-view-state]]>" +
      "</update></partial-response>";

    updateViewStateFromResponse(html, session);
    assert.equal(session.viewState, "prefixed-view-state");
  });

  it("extracts ViewState from full HTML (fallback)", () => {
    const session = makeSession();
    const html =
      '<html><body><form>' +
      '<input type="hidden" name="javax.faces.ViewState" value="html-view-state" />' +
      "</form></body></html>";

    updateViewStateFromResponse(html, session);
    assert.equal(session.viewState, "html-view-state");
  });

  it("does not change ViewState when none found", () => {
    const session = makeSession({ viewState: "original" });
    const html = "<html><body>No ViewState here</body></html>";

    updateViewStateFromResponse(html, session);
    assert.equal(session.viewState, "original");
  });

  it("handles ViewState without CDATA wrapper", () => {
    const session = makeSession();
    const html =
      '<partial-response><update id="javax.faces.ViewState">' +
      "bare-view-state" +
      "</update></partial-response>";

    updateViewStateFromResponse(html, session);
    assert.equal(session.viewState, "bare-view-state");
  });
});

// ════════════════════════════════════════════════════════════════
//  withRetry
// ════════════════════════════════════════════════════════════════

describe("withRetry", () => {
  it("returns success on first attempt", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        return { status: 200, data: "ok", headers: {} } as any;
      },
      { retryMax: 3, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, true);
    assert.equal(result.data, "ok");
    assert.equal(result.attempts, 1);
    assert.equal(attempts, 1);
  });

  it("retries on 429 and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          return { status: 429, data: null, headers: { "retry-after": "1" } } as any;
        }
        return { status: 200, data: "recovered", headers: {} } as any;
      },
      { retryMax: 5, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, true);
    assert.equal(result.data, "recovered");
    assert.equal(result.attempts, 3);
    assert.equal(attempts, 3);
  });

  it("retries on 5xx and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          return { status: 500, data: null, headers: {} } as any;
        }
        return { status: 200, data: "ok-after-500", headers: {} } as any;
      },
      { retryMax: 3, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, true);
    assert.equal(result.data, "ok-after-500");
    assert.equal(result.attempts, 2);
  });

  it("retries on network error and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("ECONNREFUSED");
        }
        return { status: 200, data: "ok-after-network", headers: {} } as any;
      },
      { retryMax: 3, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, true);
    assert.equal(result.data, "ok-after-network");
    assert.equal(result.attempts, 2);
  });

  it("fails after exhausting all retries", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        return { status: 503, data: null, headers: {} } as any;
      },
      { retryMax: 3, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, false);
    assert.equal(result.attempts, 3);
    assert.equal(result.finalStatus, 503);
    assert.ok(result.error?.includes("503"));
  });

  it("does not retry on 400 (non-retryable)", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        return { status: 400, data: null, headers: {} } as any;
      },
      { retryMax: 3, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.finalStatus, 400);
  });

  it("reports attempt count correctly on network errors", async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        throw new Error("ETIMEDOUT");
      },
      { retryMax: 3, backoffMs: 10, label: "test" }
    );

    assert.equal(result.success, false);
    assert.equal(result.attempts, 3);
    assert.ok(result.error?.includes("ETIMEDOUT"));
  });
});

// ════════════════════════════════════════════════════════════════
//  validateJsfResponse — session expiry detection
// ════════════════════════════════════════════════════════════════

describe("validateJsfResponse", () => {
  it("passes for valid JSF response with ViewState", () => {
    const html =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<partial-response><update id="javax.faces.ViewState">' +
      "<![CDATA[valid-view-state-abc123]]>" +
      "</update></partial-response>";
    assert.doesNotThrow(() => validateJsfResponse(html, "test"));
  });

  it("passes for full HTML page with ViewState input", () => {
    const html =
      '<html><body><form>' +
      '<input type="hidden" name="javax.faces.ViewState" value="xyz" />' +
      "</form></body></html>";
    assert.doesNotThrow(() => validateJsfResponse(html, "test"));
  });

  it("throws when ViewState is missing", () => {
    const html = "<html><body><p>No JSF here</p></body></html>";
    assert.throws(
      () => validateJsfResponse(html, "test"),
      /missing ViewState/
    );
  });

  it("throws when response is a login page with password field", () => {
    const html =
      '<html><body><form>' +
      '<input type="hidden" name="javax.faces.ViewState" value="expired-session" />' +
      '<input name="password" />' +
      '<p>Iniciar sesion</p>' +
      "</form></body></html>";
    assert.throws(
      () => validateJsfResponse(html, "test"),
      /login page/
    );
  });

  it("throws for empty response", () => {
    assert.throws(
      () => validateJsfResponse("", "test"),
      /missing ViewState/
    );
  });

  it("does not throw for response with ViewState but no login indicators", () => {
    const html =
      '<partial-response><update id="javax.faces.ViewState">' +
      "<![CDATA[session-ok]]>" +
      "</update></partial-response>";
    assert.doesNotThrow(() => validateJsfResponse(html, "test"));
  });
});

// ════════════════════════════════════════════════════════════════
//  loadExistingJsonlIds — idempotent write support
// ════════════════════════════════════════════════════════════════

describe("loadExistingJsonlIds", () => {
  const tmpDir = path.join(__dirname, "__test_tmp__");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty set for non-existent file", () => {
    const ids = loadExistingJsonlIds(path.join(tmpDir, "nope.jsonl"));
    assert.equal(ids.size, 0);
  });

  it("returns empty set for empty file", () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(filePath, "", "utf-8");
    const ids = loadExistingJsonlIds(filePath);
    assert.equal(ids.size, 0);
  });

  it("extracts IDs from JSONL file", () => {
    const filePath = path.join(tmpDir, "docs.jsonl");
    const lines = [
      JSON.stringify({ id: "doc-1", title: "First" }),
      JSON.stringify({ id: "doc-2", title: "Second" }),
      JSON.stringify({ id: "doc-3", title: "Third" }),
    ].join("\n");
    fs.writeFileSync(filePath, lines, "utf-8");

    const ids = loadExistingJsonlIds(filePath);
    assert.equal(ids.size, 3);
    assert.ok(ids.has("doc-1"));
    assert.ok(ids.has("doc-2"));
    assert.ok(ids.has("doc-3"));
  });

  it("skips malformed lines gracefully", () => {
    const filePath = path.join(tmpDir, "mixed.jsonl");
    const lines = [
      JSON.stringify({ id: "good-1", title: "OK" }),
      "NOT JSON AT ALL",
      JSON.stringify({ id: "good-2", title: "Also OK" }),
      "",
    ].join("\n");
    fs.writeFileSync(filePath, lines, "utf-8");

    const ids = loadExistingJsonlIds(filePath);
    assert.equal(ids.size, 2);
    assert.ok(ids.has("good-1"));
    assert.ok(ids.has("good-2"));
  });

  it("skips lines without id field", () => {
    const filePath = path.join(tmpDir, "no-ids.jsonl");
    const lines = [
      JSON.stringify({ title: "No ID here" }),
      JSON.stringify({ id: "has-id", title: "Has ID" }),
    ].join("\n");
    fs.writeFileSync(filePath, lines, "utf-8");

    const ids = loadExistingJsonlIds(filePath);
    assert.equal(ids.size, 1);
    assert.ok(ids.has("has-id"));
  });
});

// ════════════════════════════════════════════════════════════════
//  PJ parseResults — RichFaces panel parsing
// ════════════════════════════════════════════════════════════════

const PJ_BASE = "https://jurisprudencia.pj.gob.pe";

describe("PJ parseResults", () => {
  it("parses panels with download links and extracts UUIDs", () => {
    const html = readFixture("pj-search-response.html");
    const result = pjParseResults(html, 1, PJ_BASE);

    assert.equal(result.documents.length, 3, "should parse 3 panels");
    assert.equal(result.currentPage, 1);
    assert.equal(result.totalPages, 3);

    // First panel — has PDF link with UUID
    const doc1 = result.documents[0];
    assert.equal(doc1.source, "pj");
    assert.equal(doc1.page, 1);
    assert.equal(doc1.position, 1);
    assert.ok(doc1.pdfUrl?.includes("a1b2c3d4-e5f6-7890-abcd-ef1234567890"));
    assert.equal(doc1.id, "a1b2c3d4-e5f6-7890-abcd-ef1234567890");
    assert.equal(doc1.fields?.["Recurso"], "Casación Laboral");
    assert.equal(doc1.fields?.["Expediente"], "001-2023-CSJL");

    // Second panel — has PDF link
    const doc2 = result.documents[1];
    assert.ok(doc2.pdfUrl?.includes("b2c3d4e5-f6a7-8901-bcde-f12345678901"));

    // Third panel — no download link
    const doc3 = result.documents[2];
    assert.equal(doc3.pdfUrl, null);
    assert.equal(doc3.title, "Queja Laboral 003-2023-CSJT");
  });

  it("returns empty documents for page with no panels", () => {
    const html = readFixture("pj-empty-response.html");
    const result = pjParseResults(html, 1, PJ_BASE);

    assert.equal(result.documents.length, 0);
    assert.equal(result.totalPages, 1);
  });

  it("builds title from Recurso + Expediente fields", () => {
    const html = readFixture("pj-search-response.html");
    const result = pjParseResults(html, 1, PJ_BASE);

    const doc = result.documents[0];
    assert.equal(doc.title, "Casación Laboral 001-2023-CSJL");
  });

  it("extracts pagination info from rf-pg-lbl", () => {
    const html = readFixture("pj-search-response.html");
    const result = pjParseResults(html, 1, PJ_BASE);

    assert.equal(result.totalPages, 3);
    assert.equal(result.currentPage, 1);
  });
});

// ════════════════════════════════════════════════════════════════
//  Checkpoint — save/load/idempotency guard
// ════════════════════════════════════════════════════════════════

describe("OEFA checkpoint", () => {
  const tmpDir = path.join(__dirname, "__test_checkpoint__");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
    return {
      profile: "oefa",
      baseUrl: "https://publico.oefa.gob.pe/repdig",
      searchTerm: "",
      maxPages: 10,
      maxDocuments: 100,
      requestDelayMs: 100,
      requestTimeoutMs: 30000,
      retryMax: 3,
      retryBackoffMs: 1000,
      downloadPdfs: false,
      outputDir: tmpDir,
      ...overrides,
    };
  }

  it("returns null when no checkpoint file exists", () => {
    const cp = loadCheckpoint(makeConfig());
    assert.equal(cp, null);
  });

  it("saves and loads a valid checkpoint", () => {
    const config = makeConfig();
    const checkpoint: Checkpoint = {
      profile: "oefa",
      searchTerm: "test",
      nextPage: 5,
      nextPosition: 3,
      totalDocuments: 43,
      completed: false,
      timestamp: "2024-01-15T10:30:00Z",
    };

    saveCheckpoint(config, checkpoint);
    const loaded = loadCheckpoint(config);

    assert.notEqual(loaded, null);
    assert.equal(loaded?.nextPage, 5);
    assert.equal(loaded?.nextPosition, 3);
    assert.equal(loaded?.totalDocuments, 43);
    assert.equal(loaded?.completed, false);
  });

  it("returns null when checkpoint is completed (prevents re-run)", () => {
    const config = makeConfig();
    saveCheckpoint(config, {
      profile: "oefa",
      searchTerm: "test",
      nextPage: 10,
      nextPosition: 0,
      totalDocuments: 95,
      completed: true,
      timestamp: "2024-01-15T10:30:00Z",
    });

    const cp = loadCheckpoint(config);
    assert.equal(cp, null, "completed checkpoint should return null");
  });

  it("returns null when profile does not match", () => {
    const config = makeConfig();
    saveCheckpoint(config, {
      profile: "pj", // wrong profile
      searchTerm: "test",
      nextPage: 3,
      nextPosition: 0,
      totalDocuments: 20,
      completed: false,
      timestamp: "2024-01-15T10:30:00Z",
    });

    const cp = loadCheckpoint(config);
    assert.equal(cp, null, "mismatched profile should return null");
  });

  it("returns null for malformed JSON", () => {
    const cpPath = path.join(tmpDir, "checkpoint.json");
    fs.writeFileSync(cpPath, "{ broken json", "utf-8");

    const cp = loadCheckpoint(makeConfig());
    assert.equal(cp, null);
  });
});

describe("PJ checkpoint", () => {
  const tmpDir = path.join(__dirname, "__test_checkpoint_pj__");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<AppConfig>): AppConfig {
    return {
      profile: "pj",
      baseUrl: "https://jurisprudencia.pj.gob.pe",
      searchTerm: "despido",
      maxPages: 10,
      maxDocuments: 100,
      requestDelayMs: 100,
      requestTimeoutMs: 30000,
      retryMax: 3,
      retryBackoffMs: 1000,
      downloadPdfs: false,
      outputDir: tmpDir,
      ...overrides,
    };
  }

  it("returns null when checkpoint is completed", () => {
    const config = makeConfig();
    pjSaveCheckpoint(config, {
      profile: "pj",
      searchTerm: "despido",
      nextPage: 5,
      nextPosition: 0,
      totalDocuments: 40,
      completed: true,
      timestamp: "2024-01-15T10:30:00Z",
    });

    const cp = pjLoadCheckpoint(config);
    assert.equal(cp, null);
  });

  it("returns null when searchTerm does not match", () => {
    const config = makeConfig();
    pjSaveCheckpoint(config, {
      profile: "pj",
      searchTerm: "otra cosa", // different search term
      nextPage: 3,
      nextPosition: 0,
      totalDocuments: 20,
      completed: false,
      timestamp: "2024-01-15T10:30:00Z",
    });

    const cp = pjLoadCheckpoint(config);
    assert.equal(cp, null, "mismatched searchTerm should return null");
  });

  it("saves and loads a valid incomplete checkpoint", () => {
    const config = makeConfig();
    pjSaveCheckpoint(config, {
      profile: "pj",
      searchTerm: "despido",
      nextPage: 3,
      nextPosition: 2,
      totalDocuments: 22,
      completed: false,
      timestamp: "2024-01-15T10:30:00Z",
    });

    const cp = pjLoadCheckpoint(config);
    assert.notEqual(cp, null);
    assert.equal(cp?.nextPage, 3);
    assert.equal(cp?.nextPosition, 2);
    assert.equal(cp?.totalDocuments, 22);
  });
});

// ════════════════════════════════════════════════════════════════
//  Excel export — generates valid .xlsx from JSONL
// ════════════════════════════════════════════════════════════════

describe("exportToExcel", () => {
  const tmpDir = path.join(__dirname, "__test_excel__");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no JSONL exists", () => {
    const result = exportToExcel(tmpDir);
    assert.equal(result, null);
  });

  it("generates xlsx from JSONL with valid documents", () => {
    // Create a JSONL with sample documents
    const docs = [
      {
        source: "oefa",
        page: 1,
        position: 1,
        id: "doc-1",
        title: "891-08-PRODUCE",
        fields: {
          "N° Expediente": "891-08-PRODUCE",
          Administrado: "Corporación del Mar S.A.",
          "Unidad fiscalizable": "Planta Playa",
          Sector: "Pesquería",
          "N° Resolución de Apelación": "264-2012-OEFA/TFA",
        },
        pdfUrl: "https://example.com/pdf?param_uuid=abc-123",
        pdfFile: "doc1_abc123.pdf",
        scrapedAt: "2024-01-15T10:00:00Z",
      },
      {
        source: "oefa",
        page: 1,
        position: 2,
        id: "doc-2",
        title: "857-2011-PRODUCE",
        fields: {
          "N° Expediente": "857-2011-PRODUCE",
          Administrado: "Pesquera del Sur S.A.",
          "Unidad fiscalizable": "Embarcación",
          Sector: "Pesquería",
          "N° Resolución de Apelación": "100-2011-OEFA/TFA",
        },
        pdfUrl: null,
        pdfFile: null,
        scrapedAt: "2024-01-15T10:01:00Z",
      },
    ];

    const jsonlPath = path.join(tmpDir, "documents.jsonl");
    const lines = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    fs.writeFileSync(jsonlPath, lines, "utf-8");

    const result = exportToExcel(tmpDir);

    assert.notEqual(result, null, "should return output path");
    assert.ok(result?.endsWith(".xlsx"), "should be .xlsx file");

    // Verify file exists and has content
    const stat = fs.statSync(result!);
    assert.ok(stat.size > 0, "xlsx file should not be empty");

    // Verify the excel directory was created
    const excelDir = path.join(tmpDir, "excel");
    assert.ok(fs.existsSync(excelDir), "excel/ directory should exist");
  });

  it("returns null when JSONL is empty", () => {
    const jsonlPath = path.join(tmpDir, "documents.jsonl");
    fs.writeFileSync(jsonlPath, "", "utf-8");

    const result = exportToExcel(tmpDir);
    assert.equal(result, null);
  });
});

// ════════════════════════════════════════════════════════════════
//  Idempotency orchestration — resume does not duplicate
// ════════════════════════════════════════════════════════════════

describe("Idempotency orchestration", () => {
  const tmpDir = path.join(__dirname, "__test_idempotency__");

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("loadExistingJsonlIds detects docs already written before resume", () => {
    // Simulate: first run wrote 3 docs, got interrupted
    const jsonlPath = path.join(tmpDir, "documents.jsonl");
    const docs = [
      { id: "doc-1", title: "First", source: "oefa" },
      { id: "doc-2", title: "Second", source: "oefa" },
      { id: "doc-3", title: "Third", source: "oefa" },
    ];
    const lines = docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
    fs.writeFileSync(jsonlPath, lines, "utf-8");

    // Load existing IDs (simulating resume)
    const writtenIds = loadExistingJsonlIds(jsonlPath);
    assert.equal(writtenIds.size, 3);
    assert.ok(writtenIds.has("doc-1"));
    assert.ok(writtenIds.has("doc-2"));
    assert.ok(writtenIds.has("doc-3"));

    // Simulate: resume encounters docs 1-5 (docs 1-3 already written)
    const resumeDocs = [
      { id: "doc-1", title: "First" },
      { id: "doc-2", title: "Second" },
      { id: "doc-3", title: "Third" },
      { id: "doc-4", title: "Fourth" },
      { id: "doc-5", title: "Fifth" },
    ];

    // Only write docs not already in the set
    for (const doc of resumeDocs) {
      if (!writtenIds.has(doc.id)) {
        const line = JSON.stringify(doc) + "\n";
        fs.appendFileSync(jsonlPath, line, "utf-8");
        writtenIds.add(doc.id);
      }
    }

    // Verify: file should have exactly 5 lines (3 original + 2 new)
    const raw = fs.readFileSync(jsonlPath, "utf-8").trim();
    const finalLines = raw.split("\n").filter((l) => l.trim());
    assert.equal(finalLines.length, 5, "should have 5 docs total (no duplicates)");

    // Verify all IDs are present
    const finalIds = loadExistingJsonlIds(jsonlPath);
    assert.equal(finalIds.size, 5);
    assert.ok(finalIds.has("doc-4"));
    assert.ok(finalIds.has("doc-5"));
  });

  it("writes zero duplicates when resuming with all docs already present", () => {
    const jsonlPath = path.join(tmpDir, "documents.jsonl");
    const docs = [
      { id: "doc-1", title: "First" },
      { id: "doc-2", title: "Second" },
    ];
    const lines = docs.map((d) => JSON.stringify(d)).join("\n");
    fs.writeFileSync(jsonlPath, lines, "utf-8");

    const writtenIds = loadExistingJsonlIds(jsonlPath);

    // Resume encounters the same docs
    const resumeDocs = [
      { id: "doc-1", title: "First" },
      { id: "doc-2", title: "Second" },
    ];

    for (const doc of resumeDocs) {
      if (!writtenIds.has(doc.id)) {
        const line = JSON.stringify(doc) + "\n";
        fs.appendFileSync(jsonlPath, line, "utf-8");
        writtenIds.add(doc.id);
      }
    }

    // File should still have exactly 2 lines
    const raw = fs.readFileSync(jsonlPath, "utf-8").trim();
    const finalLines = raw.split("\n").filter((l) => l.trim());
    assert.equal(finalLines.length, 2, "should have 2 docs (zero duplicates)");
  });
});
