import { describe, it, beforeEach } from "node:test";
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
} from "./oefa-profile.js";
import { withRetry } from "./http-client.js";
import type { JsfSession, ScrapedDocument } from "./types.js";

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
