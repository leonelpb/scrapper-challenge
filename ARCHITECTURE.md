# ARQUITECTURA.md — Cómo scrapear un sitio JSF estatal sin navegador

## Contexto

El sitio de la OEFA (Organismo de Evaluación y Fiscalización Ambiental) en `publico.oefa.gob.pe` expone una base de datos de contrataciones públicas con 1.700+ registros. El sitio corre sobre **JavaServer Faces (JSF) 2.0** con **PrimeFaces 6.0** — un framework renderizado server-side y estatal donde cada interacción de usuario (búsqueda, paginación, descarga de PDF) requiere un token de sesión válido (`javax.faces.ViewState`) y una cookie (`JSESSIONID`).

El desafío: extraer estos datos usando **únicamente requests HTTP** — sin navegador headless, sin Selenium, sin Puppeteer.

## Decisión: HTTP-Only vs. Automatización de Navegador

| Enfoque | Ventajas | Desventajas |
|---------|----------|-------------|
| Automatización de navegador (Puppeteer/Playwright) | Fácil; renderiza JS como un navegador | Dependencia pesada, lento, consume recursos, detectable |
| HTTP-only (Axios + Cheerio) | Ligero, rápido, sin navegador | Hay que reverse-engineer el state machine de JSF manualmente |

**Decisión:** HTTP-only. El servidor JSF hace todo el renderizado server-side. Si replicamos la secuencia exacta de HTTP que enviaría un navegador, obtenemos las mismas respuestas HTML — no necesitamos ejecutar JavaScript de nuestro lado.

## El Problema del State Machine de JSF

JSF es un framework **estatal**. A diferencia de las APIs REST donde cada request es independiente, las sesiones de JSF forman una **cadena**:

```
GET página → ViewState₁ → POST búsqueda → ViewState₂ → POST paginación → ViewState₃ → POST descargar PDF → ...
```

Romper la cadena en cualquier punto (ViewState incorrecto, cookie faltante, token obsoleto) hace que el servidor **redirija silenciosamente a la página de login** en vez de retornar un error. No hay HTTP 403 ni mensaje de error — simplemente recibes HTML que parece un formulario de login.

### Insight clave

El servidor nunca te dice "tu sesión es inválida". Simplemente reemplaza tus datos con una página de login. Esto hizo que la depuración fuera extremadamente difícil — tuvimos que comparar respuestas HTML byte por byte para detectar cuándo las sesiones se rompían.

**Solución:** `validateJsfResponse()` verifica dos patrones en cada respuesta:
1. **Presencia de ViewState:** toda respuesta JSF válida contiene `javax.faces.ViewState`. Si no está, la sesión expiró.
2. **Patrones de login:** si la respuesta contiene "iniciar sesión" + campo de password, es una página de login disfrazada de 200.

Se aplica en `initSession()`, `search()` y `goToPage()` de ambos perfiles.

## Arquitectura

### 1. Inicialización de Sesión

```
GET /repdig/consulta/consultaTfa.xhtml
  ↓
Response: HTML con:
  - Set-Cookie: JSESSIONID=abc123
  - <input type="hidden" name="javax.faces.ViewState" value="...base64 largo...">
  ↓
validateJsfResponse() → verificar que hay ViewState y no es página de login
```

El jar de cookies es **obligatorio**. Lo implementamos manualmente via interceptors de Axios:

- **Request interceptor:** lee todas las cookies del jar e inyecta el header `Cookie`
- **Response interceptor:** lee headers `Set-Cookie` y actualiza el jar

Esto nos da estado de sesión persistente en todos los requests sin depender del manejo de cookies de Axios (que puede perder cookies en redirects).

### 2. Búsqueda (PrimeFaces AJAX)

El formulario de búsqueda se envía via AJAX parcial de PrimeFaces. El navegador envía un `POST` con:

```
Content-Type: application/x-www-form-urlencoded
X-Requested-With: XMLHttpRequest
Faces: request

Body:
  listarDetalleInfraccionRAAForm=listarDetalleInfraccionRAAForm
  listarDetalleInfraccionRAAForm:txtNroexp=
  javax.faces.ViewState=<token_actual>
  listarDetalleInfraccionRAAForm:btnBuscar=listarDetalleInfraccionRAAForm:btnBuscar
  javax.faces.partial.ajax=true
  javax.faces.source=listarDetalleInfraccionRAAForm:btnBuscar
  javax.faces.partial.execute=@all
  javax.faces.partial.render=listarDetalleInfraccionRAAForm:pgLista listarDetalleInfraccionRAAForm:txtNroexp
  javax.faces.behavior.event=action
  javax.faces.partial.event=action
```

**Detalles críticos descubiertos por iteración:**

1. El **nombre del botón** (`listarDetalleInfraccionRAAForm:btnBuscar`) debe aparecer en el body del POST — sin él, JSF no procesa la acción
2. `javax.faces.partial.ajax=true` activa una respuesta parcial (XML con updates envueltos en CDATA) en vez de una página completa
3. La respuesta actualiza `<update id="listarDetalleInfraccionRAAForm:pgLista">` con el HTML completo del DataTable
4. Se incluye un **nuevo ViewState** en la respuesta — lo extraemos y usamos para requests subsecuentes

### 3. Paginación — El Avance Decisivo

Esta fue la parte más difícil. Gastamos 15+ intentos antes de tener éxito.

**El problema:** Hacer clic en "página 2" en el navegador envía un request que no podíamos replicar. Los enfoques AJAX estándar fallaban silenciosamente.

**El avance:** Descargamos el `components.js` de PrimeFaces 6.0 directamente del servidor OEFA y leímos la función minificada `Paginator.paginate()`.

Lo que encontramos:

```javascript
// PrimeFaces 6.0 Paginator.paginate() envía:
{
  [DT]_pagination: "true",
  [DT]_first: rowOffset,      // ¡NO es número de página! Índice de fila (página 2 = _first=10)
  [DT]_rows: 10,              // Filas por página
  [DT]_skipChildren: "true",
  [DT]_encodeFeature: "true",
}
// Source/process/update = ID del DataTable (¡NO el del paginador!)
```

Donde `[DT]` = `listarDetalleInfraccionRAAForm:dt` (el ID del componente DataTable).

**Descubrimientos clave:**

| Hallazgo | Impacto |
|----------|---------|
| `_first` es un **offset de fila**, no un número de página | Página 2 → `_first=10`, no `_first=2` |
| Source/update debe ser el **ID del DataTable**, no el del paginador | Usar ID del paginador → falla silenciosa |
| La respuesta actualiza `<update id="{DT}">` con elementos `<tr>` crudos | Sin texto de paginador en respuestas de paginación — diferente a la respuesta de búsqueda |
| Cheerio descarta `<tr>` fuera de `<table>` | Hay que envolver la respuesta cruda en tags `<table>` antes de parsear |

### 4. Descarga de PDF

Los links de PDF usan `mojarra.jsfcljs()` — un postback no-AJAX:

```javascript
// Handler onclick del navegador:
mojarra.jsfcljs('listarDetalleInfraccionRAAForm', {
  'listarDetalleInfraccionRAAForm:dt:0:j_idt63': 'listarDetalleInfraccionRAAForm:dt:0:j_idt63',
  'param_uuid': '153a6d2a-cbed-40ef-b8ef-cd2272b19867'
}, '')
```

Lo simulamos como un form POST:

```
POST /repdig/consulta/consultaTfa.xhtml

Body:
  listarDetalleInfraccionRAAForm=listarDetalleInfraccionRAAForm
  listarDetalleInfraccionRAAForm:dt:0:j_idt63=listarDetalleInfraccionRAAForm:dt:0:j_idt63
  param_uuid=153a6d2a-cbed-40ef-b8ef-cd2272b19867
  javax.faces.ViewState=<token_actual>
```

El servidor responde con HTTP 302 → `/repdig/download.xhtml` → binario PDF.

**Validación:** Verificamos magic bytes `%PDF-`, no solo Content-Type, porque las respuestas de error a veces retornan HTML con status 200.

## Recuperación de Errores

### Reintentos con Backoff Exponencial + Jitter

```
intento 1: esperar 1000ms ± 25%
intento 2: esperar 2000ms ± 25%
intento 3: esperar 4000ms ± 25%
intento 4: esperar 8000ms ± 25%
intento 5: esperar 16000ms ± 25%
```

**Reintentado en:** 429 (rate limit), 408 (timeout), 5xx (error de servidor), errores de red sin respuesta.
**No reintentado en:** 4xx (excepto 408/429) — son fallos permanentes.

Respeta el header `Retry-After` cuando el servidor lo envía.

### Detección de Sesión Expirada

El problema más insidioso de JSF: el servidor retorna HTTP 200 incluso cuando la sesión expiró. Simplemente sirve la página de login en vez de los datos.

`validateJsfResponse()` intercepta esto verificando:

1. **ViewState ausente:** si la respuesta no contiene `javax.faces.ViewState`, la sesión ya no es válida.
2. **Patrón de login:** si la respuesta tiene "iniciar sesión" + campo de password, es una página de login.

Lanza un error descriptivo que permite al caller decidir (nueva sesión, retry, etc.).

### Checkpoint / Reanudación

Después de cada página, guardamos:
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

Al re-ejecutar, el scraper carga el checkpoint y reanuda desde la última página guardada. Como la cadena de sesiones se re-establece desde cero (GET → búsqueda → paginar hasta la página objetivo), no necesitamos persistir cookies — solo el contador de progreso.

**Idempotencia:** al reanudar, el scraper carga los IDs de documentos ya escritos en el JSONL (`loadExistingJsonlIds()`) y los almacena en un `Set<string>`. Antes de escribir cada documento, verifica si el ID ya existe. Si existe, lo salta. Esto garantiza que re-ejecutar nunca duplica registros.

**Reglas del checkpoint:**
- `completed: true` → se ignora (el scraping ya terminó)
- `profile` no coincide → se ignora
- `searchTerm` no coincide (PJ) → se ignora
- JSON malformado → se ignora

### Escritura Única de Documentos

Cada documento se escribe al JSONL **una sola vez**, después del intento de descarga PDF. Esto garantiza que el campo `pdfFile` ya está seteado en el registro.

```
Descargar PDF → Verificar ID no existe → Escribir una vez → done
```

**Antes (bug):** escribir → descargar PDF → escribir otra vez con `pdfFile` = 2 registros por documento.
**Ahora:** descargar PDF → escribir una vez con `pdfFile` = 1 registro por documento.

### Exportación Excel en Todos los Paths de Salida

El scraper puede terminar anticipadamente por dos razones:
1. Se alcanzó el límite de `maxDocuments`
2. Se alcanzó el límite de descargas PDF

En ambos casos, `exportToExcel()` se ejecuta via `try/finally`, garantizando que el archivo `.xlsx` se genera siempre, incluso en early exit.

## Resumen de Decisiones de Arquitectura

| Decisión | Justificación |
|----------|---------------|
| HTTP-only (sin navegador) | JSF es server-rendered; todos los datos están en respuestas HTML |
| Jar de cookies manual via interceptors | Las cookies de Axios pueden perderse en redirects; JSF requiere JSESSIONID consistente |
| Cheerio para parsing HTML | API tipo jQuery ligera; no se necesita renderizado DOM |
| Descargar source JS de PrimeFaces | Única forma de descubrir el formato exacto del payload de paginación |
| Escritura única de JSONL | Cada documento se escribe una vez (post-intento PDF), no dos veces |
| Validación de magic bytes para PDFs | El header Content-Type es poco confiable; `%PDF-` es la verdad absoluta |
| Checkpoint = solo progreso | La sesión se re-establece al reanudar; no hay necesidad de persistir ViewState |
| Detección de sesión expirada | JSF retorna 200 en login; `validateJsfResponse()` intercepta esto |
| Idempotencia via Set de IDs | Re-ejecutar nunca duplica documentos ya escritos |
| Excel en try/finally | La exportación se ejecuta siempre, incluso en early exit |
| Early-stop en N PDFs | Evita descargar el dataset completo cuando solo se necesita una muestra |

## Lecciones Aprendidas

1. **Los fallos silenciosos de JSF son la peor experiencia de depuración.** Sin códigos de error, sin logs — solo una página de login donde deberían estar tus datos. Cada intento fallido parece un éxito hasta que comparas el HTML.

2. **Leer el código fuente del framework > adivinar.** 15+ intentos de paginación fallaron. Leer `components.js` de PrimeFaces lo resolvió en un solo intento.

3. **Cheerio no es un navegador.** `<tr>` crudo fuera de `<table>` se descarta silenciosamente. Envolver todo.

4. **ViewState es la sesión.** Sin un ViewState válido, el servidor ignora tu request y redirige. Extraerlo de cada respuesta y usarlo en cada request.

5. **Los nombres de botón importan en JSF.** El body del POST debe incluir el ID del componente del botón como trigger de submit — de lo contrario JSF no procesa la acción.

6. **JSF miente con los status codes.** HTTP 200 no significa éxito — puede ser una página de login. Siempre validar la presencia de ViewState.

7. **Idempotencia no es opcional en scrapers.** Un scraper que puede duplicar datos al re-ejecutar no es confiable. El Set de IDs escritos es la garantía mínima.

8. **El orden de escritura importa.** Escribir antes de descargar el PDF genera registros incompletos. Descargar primero, escribir después, una sola vez.
