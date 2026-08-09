# Documentación — Extracción LinkedIn (55 contactos educación superior)

Proyecto: `linkedin-contact-intelligence`  
Ubicación: `C:\AI\prospeccionvocie\prospeccion\linkedin-contact-intelligence`  
Fecha de ejecución: 2026-08-08

---

## 1. Qué se hizo

Se construyó un pipeline en Node.js para enriquecer 55 contactos de educación superior con datos de LinkedIn vía Apify:

1. Leer el Excel de contactos (sin modificarlo).
2. Normalizar handles desde las URL de LinkedIn.
3. Extraer **perfil completo** y **publicaciones** por contacto.
4. Guardar respuestas crudas, manifiesto y costos.
5. Consolidar perfiles y posts en datasets reutilizables.
6. Descargar fotos de perfil cuando Apify entregó URL.

El lote completo se ejecutó solo tras autorización explícita, con límite de costo y reanudación.

---

## 2. Archivos de entrada

| Recurso | Ruta |
|---|---|
| Excel de contactos | `C:\Users\iloyo\Downloads\contactos_linkedin_educacion_superior_55 (1).xlsx` |
| Hoja usada | `Contactos` |
| Credenciales Apify (solo lectura externa) | `C:\AI\media_download\.env` |

Reglas del `.env`:

- No se copia ni mueve al proyecto.
- No se imprime el token.
- Se indica con `--env-file` o `APIFY_ENV_PATH`.

---

## 3. Actores Apify utilizados

| Uso | Actor (cliente) | Formato HTTP |
|---|---|---|
| Perfil completo | `apimaestro/linkedin-profile-detail` | `apimaestro~linkedin-profile-detail` |
| Publicaciones | `apimaestro/linkedin-profile-posts` | `apimaestro~linkedin-profile-posts` |

### Input confirmado (esquema oficial)

**Perfil**

```json
{
  "username": "<handle-o-url>",
  "includeEmail": false
}
```

**Publicaciones** (hasta 100, paginación automática, desde página 1)

```json
{
  "username": "<handle>",
  "page_number": 1,
  "total_posts": 100
}
```

---

## 4. Comandos del proyecto

```powershell
cd C:\AI\prospeccionvocie\prospeccion\linkedin-contact-intelligence

# Validación sin gastar API
npm run dry-run -- --input "C:\Users\iloyo\Downloads\contactos_linkedin_educacion_superior_55 (1).xlsx" --env-file "C:\AI\media_download\.env"

# Piloto (solo María Consuelo Macari)
npm run pilot -- --input "C:\Users\iloyo\Downloads\contactos_linkedin_educacion_superior_55 (1).xlsx" --env-file "C:\AI\media_download\.env"

# Lote completo (reanudable)
$env:APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN="0.6"
$env:APIFY_MAX_TOTAL_CHARGE_USD_BATCH="30"
npm run extract -- --input "C:\Users\iloyo\Downloads\contactos_linkedin_educacion_superior_55 (1).xlsx" --env-file "C:\AI\media_download\.env" --concurrency 3

# Consolidar sin volver a llamar API
npm run consolidate -- --input "C:\Users\iloyo\Downloads\contactos_linkedin_educacion_superior_55 (1).xlsx"

# Estado del manifiesto
npm run status -- --input "C:\Users\iloyo\Downloads\contactos_linkedin_educacion_superior_55 (1).xlsx"

# Descargar fotos de perfil
npm run download-photos
```

Flags útiles: `--force`, `--profiles-only`, `--posts-only`, `--profile <handle>`, `--concurrency N`.

---

## 5. Controles de costo y seguridad aplicados

| Control | Valor |
|---|---|
| Límite por ejecución | `APIFY_MAX_TOTAL_CHARGE_USD_PER_RUN=0.6` |
| Límite global del lote | `APIFY_MAX_TOTAL_CHARGE_USD_BATCH=30` (default del código: 30) |
| Concurrencia | 3 |
| Reintentos máximos | 2 (solo fallos temporales) |
| Checkpoints | cada 10 contactos en `output/manifests/checkpoints/` |
| Manifiesto | se guarda después de cada ejecución |

Paradas automáticas:

- costo acumulado ≥ USD 30
- error de autenticación o saldo
- resultados estructuralmente distintos al piloto
- cargo por run > límite
- 3 fallos consecutivos no temporales

---

## 6. Flujo ejecutado

1. **Dry-run**: 55 contactos, 55 handles únicos, 0 URL inválidas, actores confirmados.
2. **Piloto** — María Consuelo Macari Prats:
   - Perfil: 1 registro, ~USD 0.005
   - Posts: 49 registros, ~USD 0.245
   - Total piloto: ~USD 0.25
3. **Extract autorizado** del lote pendiente (piloto omitido por ya exitoso).
4. Parada intermedia por wrapper `No posts found...` (tratado como 0 publicaciones, no error).
5. Reanudación hasta completar los 55.
6. Reconciliación de costos Apify.
7. Consolidación y descarga de fotos.

---

## 7. Resultados finales

| Métrica | Valor |
|---|---|
| Contactos procesados | 55 / 55 |
| Ejecuciones exitosas | 110 / 110 (perfil + posts) |
| Fallos finales | 0 |
| Publicaciones consolidadas | 3 135 |
| Duplicados de posts eliminados | 25 |
| Perfiles sin publicaciones | 4 |
| Fotos descargadas | 49 |
| Perfiles sin URL de foto | 6 |
| Costo total reconciliado | **USD 16.095** |

### Perfiles sin publicaciones

- `ivonne-castro-bustos`
- `karen-radonich-36114a2b0`
- `catherine-troncoso-silva`
- `valeria-aguayo-martinez-601ab712b`

### Perfiles sin foto en Apify

- `ignacio-pérez-tuesta-09024310b`
- `nicolás-dubo-s-6b090660`
- `javiera-sanhueza`
- `vanessaheufemann`
- `soraya-madriaza-ciocca`
- `carolinaobregon`

---

## 8. Estructura de salida

```text
output/
  raw/
    profiles/{handle}.json          # respuesta cruda perfil
    posts/{handle}.json             # respuesta cruda posts
  consolidated/
    linkedin_profiles_consolidated.json
    linkedin_posts_consolidated.json
    linkedin_posts_consolidated.ndjson
    linkedin_posts_flat.csv
    contact_intelligence_dataset.json
    coverage_summary.json
  media/
    profile_photos/{handle}.jpg     # fotos descargadas
  manifests/
    extraction_manifest.csv         # trazabilidad por ejecución
    profile_photos_manifest.json
    checkpoints/checkpoint_XXX.json
  logs/
```

### Columnas del manifiesto de extracción

`handle`, `nombre`, `institución`, `cargo`, `prioridad`, `tipo_extracción`, `actor_id`, `estado`, `intentos`, `run_id`, `dataset_id`, `inicio`, `término`, `duración_segundos`, `registros`, `costo_usd`, `archivo_local`, `error`

Estados: `pending` · `running` · `succeeded` · `failed` · `skipped`

---

## 9. Normalización de handles

Desde la URL LinkedIn:

1. Quitar dominio (`linkedin.com`, `www.`, `cl.`, `pe.`, etc.)
2. Quitar `/in/`
3. Quitar barras finales
4. Quitar query/fragmento
5. Decodificar `%C3%AD` → `í`
6. Conservar Unicode
7. Deduplicar sin distinguir variantes de dominio

---

## 10. Notas operativas

- El Excel original **no se modifica**.
- Los JSON crudos **no se transforman** en consolidación; se generan archivos nuevos.
- Cero publicaciones **no** se marca automáticamente como error.
- Los cargos pay-per-event a veces se liquidan segundos después del run; el pipeline espera y, al final, se reconciliaron costos contra Apify.
- Para reanudar un lote incompleto: volver a ejecutar `npm run extract` (omite exitosos salvo `--force`).

---

## 11. Archivos clave del código

| Archivo | Rol |
|---|---|
| `src/cli.js` | Entrada de comandos |
| `src/excel.js` | Lectura/validación del Excel |
| `src/handles.js` | Normalización de handles |
| `src/apify.js` | Cliente Apify, costos, espera de runs |
| `src/extract.js` | Extracción, reanudación, límites, checkpoints |
| `src/consolidate.js` | Consolidación y dedupe de posts |
| `src/download-photos.js` | Descarga de fotos de perfil |
| `src/schema.js` | Validación estructural vs piloto |

---

## 12. Estado al cierre

- Manifiesto: **110 succeeded · 0 pending · 0 failed**
- Consolidación: completa
- Fotos: 49 descargadas en `output/media/profile_photos/`
- Costo bajo el tope global de USD 30
