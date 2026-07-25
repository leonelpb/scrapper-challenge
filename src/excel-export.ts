/**
 * Excel Export — convert documents.jsonl to .xlsx
 *
 * Reads a JSONL file (one JSON object per line) and writes a formatted
 * Excel workbook with columns matching the OEFA DataTable structure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as XLSX from "xlsx";
import type { ScrapedDocument } from "./types.js";
import { log } from "./logger.js";

// ── Column definitions ───────────────────────────────────────
interface Column {
  header: string;
  key: string;
  width: number;
}

const COLUMNS: Column[] = [
  { header: "N°", key: "position", width: 6 },
  { header: "Página", key: "page", width: 8 },
  { header: "N° Expediente", key: "expediente", width: 35 },
  { header: "Administrado", key: "administrado", width: 40 },
  { header: "Unidad Fiscalizable", key: "unidadFiscalizable", width: 45 },
  { header: "Sector", key: "sector", width: 18 },
  { header: "N° Resolución", key: "resolucion", width: 30 },
  { header: "UUID", key: "uuid", width: 40 },
  { header: "PDF Descargado", key: "pdfFile", width: 40 },
  { header: "Scrapeado", key: "scrapedAt", width: 22 },
];

// ════════════════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════════════════

/**
 * Read documents.jsonl and export to .xlsx in the excel/ subdirectory.
 * Returns the output file path, or null if no documents found.
 */
export function exportToExcel(outputDir: string): string | null {
  const jsonlPath = path.join(outputDir, "documents.jsonl");
  if (!fs.existsSync(jsonlPath)) {
    log.warn("Excel export: documents.jsonl not found — skipping");
    return null;
  }

  // ── Read JSONL ────────────────────────────────────────────
  const raw = fs.readFileSync(jsonlPath, "utf-8").trim();
  if (!raw) {
    log.warn("Excel export: documents.jsonl is empty — skipping");
    return null;
  }

  const lines = raw.split("\n");
  const docs: ScrapedDocument[] = lines.map((line) => JSON.parse(line));

  log.info(`Excel export: ${docs.length} documents from JSONL`);

  // ── Flatten to rows ──────────────────────────────────────
  const rows = docs.map((doc) => {
    const f = doc.fields ?? {};
    return {
      position: doc.position,
      page: doc.page,
      expediente: f["N° Expediente"] ?? "",
      administrado: f["Administrado"] ?? "",
      unidadFiscalizable: f["Unidad fiscalizable"] ?? "",
      sector: f["Sector"] ?? "",
      resolucion: f["N° Resolución de Apelación"] ?? "",
      uuid: extractUuid(doc.pdfUrl),
      pdfFile: doc.pdfFile ?? "",
      scrapedAt: doc.scrapedAt ?? "",
    };
  });

  // ── Build workbook ───────────────────────────────────────
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows, {
    header: COLUMNS.map((c) => c.key),
  });

  // Set column headers + widths
  ws["!cols"] = COLUMNS.map((c) => ({ wch: c.width }));

  // Overwrite header row with display names (json_to_sheet uses keys)
  for (let i = 0; i < COLUMNS.length; i++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c: i });
    if (ws[cellRef]) {
      ws[cellRef].v = COLUMNS[i].header;
    }
  }

  // Freeze header row
  ws["!freeze"] = { xSplit: 0, ySplit: 1 };

  XLSX.utils.book_append_sheet(wb, ws, "OEFA Documentos");

  // ── Write file ───────────────────────────────────────────
  const excelDir = path.join(outputDir, "excel");
  fs.mkdirSync(excelDir, { recursive: true });
  const outputPath = path.join(excelDir, "export.xlsx");

  XLSX.writeFile(wb, outputPath);

  log.success(
    `Excel export: ${rows.length} rows → ${outputPath}`
  );
  return outputPath;
}

// ════════════════════════════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════════════════════════════

function extractUuid(pdfUrl: string | null): string {
  if (!pdfUrl) return "";
  const match = pdfUrl.match(/param_uuid=([^&]+)/);
  return match ? match[1] : "";
}
