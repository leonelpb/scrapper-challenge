# Scraper Challenge — PJ Peru Jurisprudence + OEFA

HTTP-only TypeScript scraper that extracts data from Peruvian government procurement sites. No Puppeteer, Playwright, Selenium, or any embedded browser.

## Sites

| Profile | URL | JS Framework | VPN Required |
|---------|-----|-------------|-------------|
| `oefa` | publico.oefa.gob.pe | JSF + PrimeFaces 6.0 | No |
| `pj` | jurisprudencia.pj.gob.pe | JSF + RichFaces | Yes (Peru exit node) |

## Requirements

- Node.js >= 20
- npm
- For `pj` profile: VPN with a Peru exit node

## Installation

```bash
git clone <repo-url>
cd scraper-challenge
npm install
cp .env.example .env
```

## Configuration

Edit `.env` to control behavior:

```env
PROFILE=oefa              # "pj" or "oefa"
MAX_PAGES=3               # 0 = all pages
MAX_DOCUMENTS=0           # 0 = unlimited
REQUEST_DELAY_MS=1500     # Delay between requests
REQUEST_TIMEOUT_MS=60000  # HTTP timeout
RETRY_MAX=5               # Retries on 429/5xx
RETRY_BACKOFF_MS=1000     # Exponential backoff base
DOWNLOAD_PDFS=1           # 0 = skip PDF downloads
```

Or pass flags directly:

```bash
node dist/index.js --profile oefa --max-pages 2 --no-pdf
```

## Usage

### OEFA (no VPN)

```bash
# Build
npm run build

# Scrape 2 pages, no PDFs
node dist/index.js --profile oefa --max-pages 2 --no-pdf

# Scrape with PDFs (stops at MAX_PDFS_TO_DOWNLOAD)
npm run scrape:oefa

# Resume from checkpoint
node dist/index.js --profile oefa
```

### PJ (VPN connected)

```bash
npm run scrape:pj -- --query "despido arbitrario" --max-pages 5
```

### CLI Options

```
node dist/index.js [options]

Options:
  --profile <pj|oefa>       Target site (default: from .env)
  --query <text>            Search term
  --output <dir>            Output directory
  --max-pages <n>           Max pages (0 = unlimited)
  --max-documents <n>       Max documents (0 = unlimited)
  --delay-ms <n>            Delay between requests (ms)
  --retries <n>             Max retries
  --no-pdf                  Skip PDF downloads
  --help, -h                Show help
```

### Tests

```bash
npm test
```

27 unit tests covering: parseResults, buildPdfDownloadUrl, generateId, makeSafeFilename, updateViewStateFromResponse, withRetry.

## Output Structure

```
output/<profile>/
├── documents.jsonl          # One JSON per line with all fields
├── checkpoint.json          # Resume point
├── failed-downloads.jsonl   # PDFs that failed after retries
├── excel/
│   └── export.xlsx          # Excel export (auto-generated)
└── pdfs/
    └── <filename>.pdf       # Downloaded PDFs
```

### Document Format

```json
{
  "source": "oefa",
  "page": 1,
  "position": 1,
  "id": "1",
  "title": "891-08-PRODUCE/DIGSECOVI-Dsvs",
  "fields": {
    "N° Expediente": "891-08-PRODUCE/DIGSECOVI-Dsvs",
    "Administrado": "Corporación del Mar S.A.",
    "Unidad fiscalizable": "Planta Playa Lado Norte Puerto Malabrigo",
    "Sector": "Pesquería",
    "N° Resolución de Apelación": "264-2012-OEFA/TFA"
  },
  "pdfUrl": "https://publico.oefa.gob.pe/repdig/consulta/descargaPdf.xhtml?param_uuid=...",
  "pdfFile": "891-08-PRODUCEDIGSECOVI-Dsvs_1.pdf",
  "scrapedAt": "2026-07-25T15:32:51.990Z"
}
```

## Source Structure

```
src/
├── index.ts              # Entry point + CLI argument parser
├── config.ts             # Builds AppConfig from env vars
├── types.ts              # TypeScript interfaces (ScrapedDocument, JsfSession, AppConfig, etc.)
├── http-client.ts        # Axios instance with cookie jar, retry, backoff + jitter
├── logger.ts             # Colored console logging (info/success/warn/error/progress/download)
├── oefa-profile.ts       # OEFA scraper: session init, search, PrimeFaces pagination, PDF download, Excel export
├── pj-profile.ts         # PJ scraper: session init, search, RichFaces pagination, PDF download
├── excel-export.ts       # Converts documents.jsonl → formatted .xlsx workbook
├── oefa-profile.test.ts  # 27 unit tests (Node built-in test runner + tsx)
└── __fixtures__/         # HTML fixtures for parseResults tests
    ├── oefa-search-response.html
    └── oefa-pagination-response.html
```

### File Responsibilities

| File | Role |
|------|------|
| `index.ts` | CLI entry: parses args, builds config, routes to profile scraper |
| `config.ts` | Reads `.env` + CLI overrides into typed `AppConfig` |
| `types.ts` | All TypeScript interfaces: `ScrapedDocument`, `JsfSession`, `AppConfig`, `Checkpoint`, `RetryResult`, `CliArgs` |
| `http-client.ts` | `createSessionClient()` (cookie jar via interceptors), `withRetry()` (exponential backoff + jitter), `sleep()` |
| `logger.ts` | Timestamped colored output: INFO/OK/WARN/ERROR/PDF/progress |
| `oefa-profile.ts` | Full OEFA pipeline: `initSession()` → `search()` → `parseResults()` → `goToPage()` → `downloadPdf()` → `exportToExcel()` |
| `pj-profile.ts` | Full PJ pipeline: same structure as OEFA but for RichFaces framework |
| `excel-export.ts` | Reads `documents.jsonl`, flattens nested fields, writes formatted `.xlsx` with column widths and frozen header |
| `oefa-profile.test.ts` | Tests for parsing, URL building, ID generation, filename sanitization, ViewState extraction, retry logic |

## Tech Stack

| Dependency | Version | Purpose |
|------------|---------|---------|
| TypeScript | ^5.7.2 | Type-safe source code |
| Node.js | >= 20 | Runtime |
| Axios | ^1.7.9 | HTTP client with interceptors |
| Cheerio | ^1.0.0 | HTML parsing (jQuery-like API) |
| xlsx | ^0.18.5 | Excel export (SheetJS) |
| dotenv | ^16.4.7 | Environment variable loading |
| tsx | ^4.23.1 | TypeScript execution for tests |

## Error Handling

- **429 Too Many Requests**: Exponential backoff with jitter, respects `Retry-After` header
- **408/5xx**: Retried with same backoff strategy
- **Network errors**: Retried without delay escalation
- **PDF validation**: Magic bytes `%PDF-` checked (not just Content-Type)
- **Non-retryable errors** (4xx except 408/429): Fail immediately

## Checkpoint / Resume

The scraper saves `checkpoint.json` after each page. If interrupted, re-running automatically resumes from the last completed page.

## Responsible Use

- Keep delays >= 1000ms between requests
- No aggressive concurrency
- Respect server limits
- Use `--max-pages` and `--max-documents` during development

## License

MIT
