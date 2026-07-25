# ARCHITECTURE.md — How We Scraped a Stateful JSF Site Without a Browser

## Context

The OEFA (Organismo de Evaluación y Fiscalización Ambiental) site at `publico.oefa.gob.pe` exposes a public procurement database with 1,700+ records. The site runs on **JavaServer Faces (JSF) 2.0** with **PrimeFaces 6.0** — a server-side rendered, stateful framework where every user interaction (search, pagination, PDF download) requires a valid session token (`javax.faces.ViewState`) and cookie (`JSESSIONID`).

The challenge: extract this data using **only HTTP requests** — no headless browser, no Selenium, no Puppeteer.

## Decision: HTTP-Only vs. Browser Automation

| Approach | Pros | Cons |
|----------|------|------|
| Browser automation (Puppeteer/Playwright) | Easy; renders JS like a browser | Heavy dependency, slow, resource-hungry, detectable |
| HTTP-only (Axios + Cheerio) | Lightweight, fast, no browser needed | Must reverse-engineer JSF state machine manually |

**Decision:** HTTP-only. The JSF server does all rendering server-side. If we can replicate the exact HTTP sequence a browser would send, we get the same HTML responses — no JavaScript execution needed on our end.

## The JSF State Machine Problem

JSF is a **stateful** framework. Unlike REST APIs where each request is independent, JSF sessions form a **chain**:

```
GET page → ViewState₁ → POST search → ViewState₂ → POST paginate → ViewState₃ → POST download PDF → ...
```

Break the chain at any point (wrong ViewState, missing cookie, stale token) and the server **silently redirects to the login page** instead of returning an error. There is no HTTP 403 or error message — you just get HTML that looks like a login form.

### Key insight

The server never tells you "your session is invalid." It silently replaces your data with a login page. This made debugging extremely difficult — we had to compare HTML responses byte-by-byte to detect when sessions broke.

## Architecture

### 1. Session Initialization

```
GET /repdig/consulta/consultaTfa.xhtml
  ↓
Response: HTML with:
  - Set-Cookie: JSESSIONID=abc123
  - <input type="hidden" name="javax.faces.ViewState" value="...long base64...">
```

The cookie jar is **mandatory**. We implemented it manually via Axios interceptors:

- **Request interceptor**: reads all cookies from the jar and injects them as a `Cookie` header
- **Response interceptor**: reads `Set-Cookie` headers and updates the jar

This gives us persistent session state across all requests without relying on Axios's built-in cookie handling (which can drop cookies on redirects).

### 2. Search (PrimeFaces AJAX)

The search form submits via PrimeFaces partial AJAX. The browser sends a `POST` with:

```
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Faces: request

Body:
  listarDetalleInfraccionRAAForm=listarDetalleInfraccionRAAForm
  listarDetalleInfraccionRAAForm:txtNroexp=
  javax.faces.ViewState=<current_token>
  listarDetalleInfraccionRAAForm:btnBuscar=listarDetalleInfraccionRAAForm:btnBuscar
  javax.faces.partial.ajax=true
  javax.faces.source=listarDetalleInfraccionRAAForm:btnBuscar
  javax.faces.partial.execute=@all
  javax.faces.partial.render=listarDetalleInfraccionRAAForm:pgLista listarDetalleInfraccionRAAForm:txtNroexp
  javax.faces.behavior.event=action
  javax.faces.partial.event=action
```

**Critical details discovered through iteration:**

1. The **button name** (`listarDetalleInfraccionRAAForm:btnBuscar`) must appear in the POST body — without it, JSF doesn't process the action
2. `javax.faces.partial.ajax=true` triggers a partial response (XML with CDATA-wrapped HTML updates) instead of a full page
3. The response updates `<update id="listarDetalleInfraccionRAAForm:pgLista">` with the full DataTable HTML
4. A **new ViewState** is included in the response — we extract it and use it for subsequent requests

### 3. Pagination — The Breakthrough

This was the hardest part. We spent 15+ attempts before succeeding.

**The problem:** Clicking "page 2" in the browser sends a request we couldn't replicate. Standard AJAX approaches failed silently.

**The breakthrough:** We downloaded PrimeFaces 6.0's `components.js` directly from the OEFA server and read the minified `Paginator.paginate()` function.

What we found:

```javascript
// PrimeFaces 6.0 Paginator.paginate() sends:
{
  [DT]_pagination: "true",
  [DT]_first: rowOffset,      // NOT page number! Row index (page 2 = _first=10)
  [DT]_rows: 10,              // Rows per page
  [DT]_skipChildren: "true",
  [DT]_encodeFeature: "true",
}
// Source/process/update = DataTable ID (NOT paginator ID)
```

Where `[DT]` = `listarDetalleInfraccionRAAForm:dt` (the DataTable component ID).

**Key discoveries:**

| Finding | Impact |
|---------|--------|
| `_first` is a **row offset**, not a page number | Page 2 → `_first=10`, not `_first=2` |
| Source/update must be the **DataTable ID**, not the paginator | Using paginator ID → silent failure |
| Response updates `<update id="{DT}">` with raw `<tr>` elements | No paginator text in pagination responses — different from search response |
| Cheerio drops `<tr>` elements outside `<table>` | Must wrap raw response in `<table>` tags before parsing |

### 4. PDF Download

PDF links use `mojarra.jsfcljs()` — a non-AJAX postback:

```javascript
// Browser onclick handler:
mojarra.jsfcljs('listarDetalleInfraccionRAAForm', {
  'listarDetalleInfraccionRAAForm:dt:0:j_idt63': 'listarDetalleInfraccionRAAForm:dt:0:j_idt63',
  'param_uuid': '153a6d2a-cbed-40ef-b8ef-cd2272b19867'
}, '')
```

We simulate this as a form POST:

```
POST /repdig/consulta/consultaTfa.xhtml

Body:
  listarDetalleInfraccionRAAForm=listarDetalleInfraccionRAAForm
  listarDetalleInfraccionRAAForm:dt:0:j_idt63=listarDetalleInfraccionRAAForm:dt:0:j_idt63
  param_uuid=153a6d2a-cbed-40ef-b8ef-cd2272b19867
  javax.faces.ViewState=<current_token>
```

The server responds with HTTP 302 → `/repdig/download.xhtml` → PDF binary.

**Validation:** We check `%PDF-` magic bytes, not just Content-Type, because error responses sometimes return HTML with a 200 status.

## Error Recovery

### Retry with Exponential Backoff + Jitter

```
attempt 1: wait 1000ms ± 25%
attempt 2: wait 2000ms ± 25%
attempt 3: wait 4000ms ± 25%
attempt 4: wait 8000ms ± 25%
attempt 5: wait 16000ms ± 25%
```

Retried on: 429 (rate limit), 408 (timeout), 5xx (server error), network errors.
Not retried on: 4xx (except 408/429) — these are permanent failures.

Respects `Retry-After` header when the server sends it.

### Checkpoint / Resume

After each page, we save:
```json
{
  "profile": "oefa",
  "nextPage": 3,
  "nextPosition": 0,
  "totalDocuments": 20,
  "completed": false,
  "timestamp": "2026-07-25T15:34:08.489Z"
}
```

On re-run, the scraper loads the checkpoint and resumes from the last saved page. Since the session chain is re-established from scratch (GET → search → paginate to target page), we don't need to persist cookies — only the progress counter.

## Architecture Decisions Summary

| Decision | Rationale |
|----------|-----------|
| HTTP-only (no browser) | JSF is server-rendered; all data is in HTML responses |
| Manual cookie jar via interceptors | Axios built-in cookies can be lost on redirects; JSF requires consistent JSESSIONID |
| Cheerio for HTML parsing | Lightweight jQuery-like API; no DOM rendering needed |
| Download PrimeFaces source JS | Only way to discover exact pagination payload format |
| Single-write JSONL pattern | Each document written once (after PDF attempt), not twice |
| Magic bytes validation for PDFs | Content-Type header is unreliable; `%PDF-` is ground truth |
| Checkpoint = progress only | Session is re-established on resume; no need to persist ViewState |
| Early-stop at N PDFs | Avoids downloading entire dataset when only sample is needed |

## Lessons Learned

1. **JSF silent failures are the worst debugging experience.** No error codes, no logs — just a login page where your data should be. Every failed attempt looks like success until you compare HTML.

2. **Reading framework source code > guessing.** 15+ pagination attempts failed. Reading PrimeFaces `components.js` solved it in one try.

3. **Cheerio is not a browser.** Raw `<tr>` outside `<table>` is silently dropped. Wrap everything.

4. **ViewState is the session.** Without a valid ViewState, the server ignores your request and redirects. Extract it from every response and use it in every request.

5. **Button names matter in JSF.** The POST body must include the button component ID as a submit trigger — otherwise JSF doesn't process the action.
