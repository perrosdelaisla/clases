# admin/agenda/ — módulo de la pestaña Agenda

## Propósito

Port de `hola/supabase.js` al SDK `supabase-js` con sesión Auth real.
Reemplaza el wrapper REST + anon key embebida del repo viejo por
queries autenticadas que respetan RLS (`es_admin()`) en el proyecto
Victoria (`sydzfwwiruxqaxojymdz`).

Este módulo expone la capa de datos que va a consumir la pestaña
"Agenda" del admin unificado en `feat/admin-unificado` (futuras
sub-tareas: UI, integración con `index.html`, tests).

## Funciones exportadas (15)

| # | Firma | Qué hace |
|---|-------|----------|
| 1 | `obtenerPlantilla()` | Lista los slots de la plantilla semanal, ordenados por día y hora. |
| 2 | `añadirSlotPlantilla(dia_semana, hora)` | Inserta un slot nuevo (idempotente — devuelve el existente si ya hay match). |
| 3 | `eliminarSlotPlantilla(id)` | Borra físicamente un slot por id. |
| 4 | `toggleSlotActivo(id, activo)` | Pausa o reanuda un slot sin borrarlo. |
| 5 | `obtenerBloqueos()` | Lista bloqueos vigentes (fecha >= hoy), ordenados por fecha. |
| 6 | `bloquearDia(fecha, motivo='', hora=null)` | Crea bloqueo de día completo (hora=null) o de slot puntual. |
| 7 | `eliminarBloqueo(id)` | Borra un bloqueo por id. |
| 8 | `obtenerCitasAdminConReportado()` | Cita + cliente + perros + resumen `reportado` extraído de conversaciones. |
| 9 | `confirmarCita(citaId)` | Marca cita como `'confirmada'`. |
| 10 | `cancelarCita(citaId)` | Marca cita como `'cancelada'` (no borra). |
| 11 | `marcarCitaRealizada(citaId)` | Marca cita como `'realizada'` (✅ vs 🟡 en iCal). |
| 12 | `eliminarCita(citaId)` | DELETE físico de la cita. |
| 13 | `crearCitaManual(datos)` | Crea cliente+perro+cita+bloqueo en cadena con rollback. Devuelve `{ ok, … }` — no tira. |
| 14 | `obtenerNombresCitasPorIds(citaIds)` | Mapa `{ uuid → nombreCliente }` para resolver UUIDs en UI. |
| 15 | `obtenerSesionesParaStats(desde, hasta)` | Sesiones del chatbot en rango (defensivo: error → `[]`). |

Detalles completos (params, returns, ejemplos, tablas tocadas, RLS,
equivalencia con `hola/supabase.js`) en el JSDoc de cada función en
`api.js`.

## Estado actual

**Bloque 1.A esqueleto.** Las 15 firmas están definidas y exportadas
con JSDoc completo, pero el cuerpo de cada función lanza:

```js
throw new Error('NOT_IMPLEMENTED — Bloque 1.B pendiente: …');
```

**Bloque 1.B pendiente:** implementar cuerpos con queries SDK
(`supabase.from('…').select/insert/update/delete`), preservando la
firma y el contrato documentado.

## Cómo testear cuando esté implementado

> **TODO** — definir en próxima sesión junto con Charly.

(Ideas a discutir: tests manuales contra la DB real con un usuario
admin de prueba, dataset semilla idempotente, harness `node` o página
HTML de smoke-test, etc.)

## Observaciones detectadas durante el esqueleto

1. **Firmas idénticas a `hola/supabase.js`.** Defaults preservados:
   `bloquearDia(fecha, motivo='', hora=null)`. No se cambió ningún
   nombre, orden ni default — el port es mecánico.

2. **3 funciones de `hola/supabase.js` quedaron FUERA de este módulo
   por no ser usadas por `hola/admin/admin.js`:**
   - `obtenerSlotsDisponibles()` (línea 32) — usada por el chatbot
     Victoria, no por el admin. Vive en `hola/supabase.js` mientras
     exista el chatbot.
   - `obtenerCitasAdmin()` (línea 172) — versión sin `reportado`,
     reemplazada en producción por `obtenerCitasAdminConReportado()`.
   - `desbloquearDia(fecha)` (línea 159) — el admin usa
     `eliminarBloqueo(id)`, no esta variante por fecha.

   Si en algún momento la UI las necesita, se agregan en su propio
   bloque y se documenta el alcance.

3. **`crearCitaManual` no es transaccional.** Anotado en
   `DEUDA_TECNICA.md` ítem 1. La firma defensiva
   (`{ ok, ... } | { ok:false, error }`) se preserva tal cual; el
   port al SDK no soluciona la atomicidad (eso es un RPC/Postgres
   function, fuera de alcance de la unificación).

4. **`obtenerSesionesParaStats` traga errores y devuelve `[]`.**
   Comportamiento defensivo del original. Se preserva en el port
   para no cambiar el contrato con `_cargarDatosStats` del admin
   viejo.

5. **`eliminarSlotPlantilla` con id inexistente** — el original no
   distingue "borré 1 fila" de "no había nada que borrar". El Bloque
   1.B debería decidir si tratamos eso como error explícito o como
   no-op silencioso (recomendable lo segundo, alineado al
   comportamiento histórico).
