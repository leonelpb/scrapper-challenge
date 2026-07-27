# Scraper Challenge — PJ Perú Jurisprudencia + OEFA

Scraper HTTP-only en TypeScript que extrae datos de sitios de contrataciones públicas del Perú. Sin Puppeteer, Playwright, Selenium ni navegador embebido.

## Sitios

| Perfil | URL | Framework JS | VPN Requerida |
|--------|-----|-------------|---------------|
| `oefa` | publico.oefa.gob.pe | JSF + PrimeFaces 6.0 | No |
| `pj` | jurisprudencia.pj.gob.pe | JSF + RichFaces | Sí (nodo de salida Perú) |

## Requisitos

- Node.js >= 20
- npm
- Para el perfil `pj`: VPN con nodo de salida en Perú

## Instalación

```bash
git clone <repo-url>
cd scraper-challenge
npm install
cp .env.example .env
```

## Configuración

Editar `.env` para controlar el comportamiento:

```env
PROFILE=oefa              # "pj" o "oefa"
MAX_PAGES=3               # 0 = todas las páginas
MAX_DOCUMENTS=0           # 0 = sin límite
REQUEST_DELAY_MS=1500     # Retardo entre requests
REQUEST_TIMEOUT_MS=60000  # Timeout HTTP
RETRY_MAX=5               # Reintentos en 429/5xx
RETRY_BACKOFF_MS=1000     # Base de backoff exponencial
DOWNLOAD_PDFS=1           # 0 = omitir descarga de PDFs
```

O pasar flags directamente:

```bash
node dist/index.js --profile oefa --max-pages 2 --no-pdf
```

## Uso

### OEFA (sin VPN)

```bash
# Compilar
npm run build

# Scrapear 2 páginas, sin PDFs
node dist/index.js --profile oefa --max-pages 2 --no-pdf

# Scrapear con PDFs (se detiene en MAX_PDFS_TO_DOWNLOAD)
npm run scrape:oefa

# Reanudar desde checkpoint
node dist/index.js --profile oefa
```

### PJ (con VPN conectada)

```bash
npm run scrape:pj -- --query "despido arbitrario" --max-pages 5
```

### Opciones CLI

```
node dist/index.js [opciones]

Opciones:
  --profile <pj|oefa>       Sitio objetivo (default: desde .env)
  --query <texto>           Término de búsqueda
  --output <directorio>     Directorio de salida
  --max-pages <n>           Máximo de páginas (0 = ilimitado)
  --max-documents <n>       Máximo de documentos (0 = ilimitado)
  --delay-ms <n>            Retardo entre requests (ms)
  --retries <n>             Máximo de reintentos
  --no-pdf                  Omitir descarga de PDFs
  --help, -h                Mostrar ayuda
```

### Tests

```bash
npm test
```

55 tests unitarios cubriendo: parseResults (OEFA y PJ), buildPdfDownloadUrl, generateId, makeSafeFilename, updateViewStateFromResponse, withRetry, validateJsfResponse, loadExistingJsonlIds, checkpoints (OEFA y PJ), exportToExcel, e idempotencia de escritura.

## Estructura de Salida

```
output/<perfil>/
├── documents.jsonl          # Un JSON por línea con todos los campos
├── checkpoint.json          # Punto de reanudación
├── failed-downloads.jsonl   # PDFs que fallaron tras reintentos
├── excel/
│   └── export.xlsx          # Exportación Excel (auto-generada)
└── pdfs/
    └── <nombre>.pdf         # PDFs descargados
```

### Formato de Documento

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

## Estructura del Código Fuente

```
src/
├── index.ts              # Punto de entrada + parser de argumentos CLI
├── config.ts             # Construye AppConfig desde variables de entorno
├── types.ts              # Interfaces TypeScript (ScrapedDocument, JsfSession, AppConfig, etc.)
├── http-client.ts        # Instancia Axios con jar de cookies, retry, backoff + jitter, validación JSF
├── logger.ts             # Logging coloreado en consola (info/success/warn/error/progress/download)
├── oefa-profile.ts       # Scraper OEFA: init sesión, search, paginación PrimeFaces, descarga PDF, Excel
├── pj-profile.ts         # Scraper PJ: init sesión, search, paginación RichFaces, descarga PDF
├── excel-export.ts       # Convierte documents.jsonl → libro .xlsx formateado
├── oefa-profile.test.ts  # 55 tests unitarios (Node test runner + tsx)
└── __fixtures__/         # Fixtures HTML para tests de parseResults
    ├── oefa-search-response.html
    ├── oefa-pagination-response.html
    ├── pj-search-response.html
    └── pj-empty-response.html
```

### Responsabilidades por Archivo

| Archivo | Rol |
|---------|-----|
| `index.ts` | Entrada CLI: parsea args, construye config, enruta al scraper del perfil |
| `config.ts` | Lee `.env` + overrides CLI en `AppConfig` tipado |
| `types.ts` | Todas las interfaces: `ScrapedDocument`, `JsfSession`, `AppConfig`, `Checkpoint`, `RetryResult`, `CliArgs` |
| `http-client.ts` | `createSessionClient()` (jar de cookies via interceptors), `withRetry()` (backoff exponencial + jitter), `validateJsfResponse()` (detección de sesión expirada), `sleep()` |
| `logger.ts` | Salida coloreada con timestamps: INFO/OK/WARN/ERROR/PDF/progress |
| `oefa-profile.ts` | Pipeline OEFA completo: `initSession()` → `search()` → `parseResults()` → `goToPage()` → `downloadPdf()` → `exportToExcel()`. Escrituras idempotentes via `loadExistingJsonlIds()`. Checkpoint guard en `loadCheckpoint()`. |
| `pj-profile.ts` | Pipeline PJ completo: misma estructura que OEFA pero para RichFaces. Escritura única post-descarga PDF (sin duplicados). |
| `excel-export.ts` | Lee `documents.jsonl`, aplana campos anidados, escribe `.xlsx` formateado con anchos de columna y header congelado |
| `oefa-profile.test.ts` | Tests de parsing, construcción de URLs, generación de IDs, sanitización de filenames, extracción de ViewState, retry, validación JSF, checkpoints, exportación Excel e idempotencia |

## Stack Tecnológico

| Dependencia | Versión | Propósito |
|------------|---------|-----------|
| TypeScript | ^5.7.2 | Código fuente tipado |
| Node.js | >= 20 | Runtime |
| Axios | ^1.7.9 | Cliente HTTP con interceptors |
| Cheerio | ^1.0.0 | Parsing HTML (API tipo jQuery) |
| xlsx | ^0.18.5 | Exportación Excel (SheetJS) |
| dotenv | ^16.4.7 | Carga de variables de entorno |
| tsx | ^4.23.1 | Ejecución de TypeScript para tests |

## Manejo de Errores

### Reintentos con Backoff Exponencial + Jitter

```
intento 1: esperar 1000ms ± 25%
intento 2: esperar 2000ms ± 25%
intento 3: esperar 4000ms ± 25%
intento 4: esperar 8000ms ± 25%
intento 5: esperar 16000ms ± 25%
```

**Reintentado en:** 429 (rate limit), 408 (timeout), 5xx (error de servidor), errores de red.
**No reintentado en:** 4xx (excepto 408/429) — son fallos permanentes.

Respeta el header `Retry-After` cuando el servidor lo envía.

### Detección de Sesión Expirada

JSF retorna HTTP 200 incluso cuando la sesión expiró — simplemente sirve la página de login. `validateJsfResponse()` detecta esto verificando:

1. **Presencia de ViewState:** toda respuesta JSF válida contiene `javax.faces.ViewState`. Si no está, la sesión expiró.
2. **Patrones de login:** si la respuesta contiene "iniciar sesión" + campo de password, es una página de login disfrazada de 200.

Se aplica en `initSession()`, `search()` y `goToPage()` de ambos perfiles (OEFA y PJ).

### Validación de PDFs

Se verifican los magic bytes `%PDF-` — no solo el Content-Type, porque las respuestas de error a veces retornan HTML con status 200.

## Checkpoint / Reanudación

El scraper guarda `checkpoint.json` después de cada página. Si se interrumpe, re-ejecutar reanuda automáticamente desde la última página completada.

**Idempotencia:** al reanudar, el scraper carga los IDs de documentos ya escritos en el JSONL (`loadExistingJsonlIds()`) y los almacena en un `Set`. Antes de escribir cada documento, verifica si el ID ya existe. Si existe, lo salta. Esto garantiza que re-ejecutar nunca duplica registros.

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

**Reglas del checkpoint:**
- Si `completed: true`, el checkpoint se ignora (el scraping ya terminó).
- Si el `profile` no coincide, se ignora.
- Si el `searchTerm` no coincide (PJ), se ignora.
- Si el JSON está malformado, se ignora.

## Escritura Única de Documentos

Cada documento se escribe al JSONL **una sola vez**, después del intento de descarga PDF. Esto garantiza que el campo `pdfFile` ya está seteado en el registro y no hay duplicados.

**Antes (bug):** escribir → descargar PDF → escribir otra vez con `pdfFile` = 2 registros por documento.
**Ahora:** descargar PDF → escribir una vez con `pdfFile` = 1 registro por documento.

## Uso Responsable

- Mantener delays >= 1000ms entre requests
- Sin concurrencia agresiva
- Respetar los límites del servidor
- Usar `--max-pages` y `--max-documents` durante desarrollo

## Licencia

MIT
