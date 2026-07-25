#!/usr/bin/env node

/**
 * Scraper Challenge — PJ Peru Jurisprudence + OEFA
 *
 * HTTP-only TypeScript scraper. No Puppeteer, Playwright, or Selenium.
 *
 * Usage:
 *   node dist/index.js --profile pj    # PJ site (requires VPN to Peru)
 *   node dist/index.js --profile oefa  # OEFA site (no VPN needed)
 *
 * Configuration via .env file or environment variables.
 */

import * as dotenv from "dotenv";
import type { ProfileId, CliArgs } from "./types.js";
import { buildConfig } from "./config.js";
import { log } from "./logger.js";

// ── Load .env ───────────────────────────────────────────────────
dotenv.config();

// ── Parse CLI arguments ─────────────────────────────────────────
function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--profile":
        result.profile = args[++i] as ProfileId;
        break;
      case "--query":
      case "--search":
        result.query = args[++i];
        break;
      case "--output":
        result.output = args[++i];
        break;
      case "--start-page":
        result.startPage = parseInt(args[++i], 10);
        break;
      case "--max-pages":
        result.maxPages = parseInt(args[++i], 10);
        break;
      case "--max-documents":
        result.maxDocuments = parseInt(args[++i], 10);
        break;
      case "--delay-ms":
        result.delayMs = parseInt(args[++i], 10);
        break;
      case "--retries":
        result.retries = parseInt(args[++i], 10);
        break;
      case "--no-pdf":
        result.noPdf = true;
        break;
      case "--help":
      case "-h":
        result.help = true;
        break;
    }
  }

  return result;
}

// ── Help text ───────────────────────────────────────────────────
function showHelp(): void {
  console.log(`
  Scraper Challenge — PJ Peru Jurisprudence + OEFA

  USAGE
    node dist/index.js [options]

  OPTIONS
    --profile <pj|oefa>       Target site (default: from .env or "oefa")
    --query <text>            Search term (default: from .env)
    --output <dir>            Output directory (default: output/<profile>)
    --max-pages <n>           Max pages to scrape (default: 3, 0 = all)
    --max-documents <n>       Max documents to scrape (default: 0 = all)
    --delay-ms <n>            Delay between requests in ms (default: 1500)
    --retries <n>             Max retries for failed requests (default: 5)
    --no-pdf                  Skip PDF downloads
    --help, -h                Show this help

  ENVIRONMENT VARIABLES (from .env)
    PROFILE                   Target site: "pj" or "oefa"
    PJ_BASE_URL               PJ base URL
    PJ_SEARCH_TERM            Search term for PJ site
    OEFA_BASE_URL             OEFA base URL
    OEFA_SECTOR               Sector filter for OEFA (empty = all)
    MAX_PAGES                 Max pages (0 = all)
    MAX_DOCUMENTS             Max documents (0 = all)
    REQUEST_DELAY_MS          Delay between requests (ms)
    REQUEST_TIMEOUT_MS        HTTP timeout (ms)
    RETRY_MAX                 Max retries for 429/5xx
    RETRY_BACKOFF_MS          Initial backoff delay (ms)
    DOWNLOAD_PDFS             Set to "0" to skip PDF downloads

  EXAMPLES
    # OEFA: scrape 2 pages, no PDFs
    node dist/index.js --profile oefa --max-pages 2 --no-pdf

    # PJ: scrape with VPN connected
    node dist/index.js --profile pj --query "despido arbitrario" --max-pages 5

    # Resume from checkpoint
    node dist/index.js --profile oefa
  `);
}

// ── Main ────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const cliArgs = parseArgs();

  if (cliArgs.help) {
    showHelp();
    process.exit(0);
  }

  // Build config (env vars + CLI overrides)
  const config = buildConfig(cliArgs.profile);

  // Apply CLI overrides
  if (cliArgs.query) config.searchTerm = cliArgs.query;
  if (cliArgs.output) config.outputDir = cliArgs.output;
  if (cliArgs.maxPages !== undefined)
    config.maxPages = cliArgs.maxPages === 0 ? Infinity : cliArgs.maxPages;
  if (cliArgs.maxDocuments !== undefined)
    config.maxDocuments =
      cliArgs.maxDocuments === 0 ? Infinity : cliArgs.maxDocuments;
  if (cliArgs.delayMs !== undefined) config.requestDelayMs = cliArgs.delayMs;
  if (cliArgs.retries !== undefined) config.retryMax = cliArgs.retries;
  if (cliArgs.noPdf) config.downloadPdfs = false;

  // ── Banner ───────────────────────────────────────────────
  console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║  Scraper Challenge — PJ Peru + OEFA                 ║
  ║  TypeScript · HTTP-only · No browser automation      ║
  ╚══════════════════════════════════════════════════════╝

  Profile:      ${config.profile}
  Base URL:     ${config.baseUrl}
  Search:       "${config.searchTerm || "(empty — all results)"}"
  Max pages:    ${config.maxPages === Infinity ? "unlimited" : config.maxPages}
  Max docs:     ${config.maxDocuments === Infinity ? "unlimited" : config.maxDocuments}
  Delay:        ${config.requestDelayMs}ms
  PDFs:         ${config.downloadPdfs ? "enabled" : "disabled"}
  Output:       ${config.outputDir}
  `);

  // ── Route to profile ─────────────────────────────────────
  const startTime = Date.now();

  try {
    switch (config.profile) {
      case "pj": {
        const pj = await import("./pj-profile.js");
        await pj.scrape(config);
        break;
      }
      case "oefa": {
        const oefa = await import("./oefa-profile.js");
        await oefa.scrape(config);
        break;
      }
      default: {
        console.error(`Unknown profile: ${config.profile}`);
        console.error('Use --profile "pj" or --profile "oefa"');
        process.exit(1);
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Scraping failed: ${message}`);
    process.exit(1);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Done in ${elapsed}s\n`);
}

main();
