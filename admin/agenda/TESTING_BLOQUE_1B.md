# TESTING — Bloque 1.B (cuerpos del módulo `agenda/api.js`)

## Cómo usar este doc

Charly abre browser → https://perrosdelaisla.github.io/clases/admin/
→ login con `clasesperrosdelaisla@gmail.com` → F12 (consola).

En cada test:

1. **Una sola vez al inicio**, importar el módulo y el cliente
   Supabase (necesario para las queries de verificación):
   ```js
   const api = await import('./agenda/api.js');
   const { supabase } = await import('./js/supabase.js');
   // (la ruta './js/supabase.js' funciona si la URL actual es /clases/admin/;
   // si te tira 404 cache stale, hard reload con Ctrl+Shift+R)
   ```
2. Pegar el comando "Llamada".
3. Comparar con "Resultado esperado".
4. Ejecutar la "Verificación adicional" si está documentada.
5. Si el test introdujo datos, ejecutar el "Cleanup" del propio test
   antes de pasar al siguiente.

Si un test falla, Charly avisa, Opus revisa el cuerpo de esa función,
arreglamos, re-testeamos.

⚠️ **Cache busting**: el SW de `/clases/` (scope `/clases/`) cachea
`agenda/api.js`. Tras cada cambio de cuerpo en el Bloque 1.B, hacer
`unregister` del SW antes del nuevo test, o hard-reload con
DevTools → Application → Service Workers → "Update on reload".

---

## 0. Smoke test de auth

Antes de cualquier otra cosa, confirmar que la sesión de Charly está
viva y que la función SQL `es_admin()` reconoce su `auth.uid()`.

```js
// 0.1 — Hay user logueado
const { data: { user } } = await supabase.auth.getUser();
console.log(user?.email);
// Esperado: "clasesperrosdelaisla@gmail.com"
console.log(user?.id);
// Esperado: "b7b26cbc-6883-43fa-81e6-a0617b95aee8"

// 0.2 — Hay fila en admins
const { data: adminRow, error: adminErr } = await supabase
  .from('admins')
  .select('*')
  .eq('auth_user_id', user.id)
  .single();
console.log(adminRow);
// Esperado: { auth_user_id: 'b7b26cbc-...', nombre: 'Charly', ... }

// 0.3 — La función es_admin() devuelve true para el user actual
const { data: esAdmin, error: esAdminErr } = await supabase.rpc('es_admin');
console.log(esAdmin);
// Esperado: true
```

**Si alguno falla**: parar TODO. No seguir con tests de DB hasta
arreglar la sesión / RLS / fila admins.

---

## Pre-requisitos antes de arrancar

- ✅ Estar logueado en `clases/admin/`.
- ✅ Smoke test §0 pasa.
- ✅ La branch `feat/admin-unificado` con `agenda/api.js` está deployada
  o servida localmente (sino el dynamic `import()` tirará 404).
- ✅ Setup de datos ejecutado (ver §1 abajo). Charly anota los IDs/PKs
  generados en una nota aparte para usarlos en los tests.

---

## 1. Setup de datos para testing

⚠️ **Esto lo ejecuta Opus vía MCP al arrancar la sesión Bloque 1.B.**
Charly NO pega esto en la consola — solo recibe los IDs generados
para usarlos en los tests.

Toda fila de prueba lleva prefijo `TEST_` en strings o fechas
≥ `2030-01-01` para que el cleanup pueda identificarlas y borrarlas
sin riesgo a datos reales.

**Conteos baseline (Charly los anota antes del setup):**

```sql
SELECT 'slots'        AS tabla, count(*) FROM slots
UNION ALL SELECT 'bloqueos',     count(*) FROM bloqueos
UNION ALL SELECT 'citas',        count(*) FROM citas
UNION ALL SELECT 'clientes',     count(*) FROM clientes
UNION ALL SELECT 'perros',       count(*) FROM perros
UNION ALL SELECT 'conversaciones', count(*) FROM conversaciones;
```

**Filas a crear** (cada una con su columna `id` capturada en una variable):

| # | Tabla     | Datos                                                                                              | Variable doc            |
|---|-----------|----------------------------------------------------------------------------------------------------|-------------------------|
| 1 | `slots`   | `dia_semana=2`, `hora='03:15:00'`, `activo=true`                                                   | `SLOT_TEST_A_ID`        |
| 2 | `slots`   | `dia_semana=4`, `hora='04:30:00'`, `activo=true`                                                   | `SLOT_TEST_B_ID`        |
| 3 | `bloqueos`| `fecha='2030-12-31'`, `hora=null`, `motivo='TEST_setup_dia_completo'`                              | `BLOQ_TEST_DIA_ID`      |
| 4 | `clientes`| `nombre='TEST_Cliente_Setup'`, `telefono='+34 600 000 001'`, `estado='consulta'`, `zona='TEST'`    | `CLIENTE_TEST_ID`       |
| 5 | `perros`  | `cliente_id=CLIENTE_TEST_ID`, `nombre='TEST_Perro_Setup'`, `raza='TEST_raza'`                      | `PERRO_TEST_ID`         |
| 6 | `citas`   | `cliente_id=CLIENTE_TEST_ID`, `fecha='2030-06-15'`, `hora='10:00:00'`, `estado='confirmada'`, `confirmada=true`, `notas='TEST_setup_cita'` | `CITA_TEST_ID` |

**Conteos esperados después del setup**: cada tabla afectada = baseline + cantidad insertada.

---

## 2. Tests por función — orden de ejecución

EL ORDEN IMPORTA. Va de menos invasivo a más invasivo.

### Fase A — Lecturas puras (SELECT, no mutan nada)

#### 1. `obtenerPlantilla()`

**Tabla(s) Supabase:** `slots` (SELECT)
**RLS requerido:** `es_admin() = true`
**Fase:** A

**Llamada:**
```js
const r = await api.obtenerPlantilla();
console.log(r);
console.log(`${r.length} slots`);
```

**Resultado esperado:**
- Array de objetos `{ id, dia_semana, hora, activo }`.
- Ordenado por `dia_semana ASC, hora ASC`.
- Debe incluir las dos filas de TEST creadas en setup (`hora='03:15:00'` y `'04:30:00'`).
- Longitud = baseline_slots + 2.

**Verificación adicional:**
```js
const testSlots = r.filter(s => s.hora === '03:15:00' || s.hora === '04:30:00');
console.log(testSlots.length);   // 2
```

**Cleanup:** ninguno (lectura pura).

**Si falla:**
- 401/403 → revisar RLS sobre `slots` (policy debería permitir SELECT a `es_admin()`).
- Array vacío → confirmar que el setup corrió y los IDs existen.
- `TypeError` → cuerpo del 1.B no devolvió `data`, devolvió el wrapper completo `{data, error}`.

---

#### 2. `obtenerBloqueos()`

**Tabla(s) Supabase:** `bloqueos` (SELECT con filtro `fecha >= hoy`)
**RLS requerido:** `es_admin() = true`
**Fase:** A

**Llamada:**
```js
const r = await api.obtenerBloqueos();
console.log(r);
```

**Resultado esperado:**
- Array de `{ id, fecha, hora, motivo }`.
- Ordenado por `fecha ASC`.
- TODAS las filas tienen `fecha >= hoy` (no aparecen bloqueos pasados).
- Incluye el bloqueo del setup `fecha='2030-12-31'`, `motivo='TEST_setup_dia_completo'`, `hora=null`.

**Verificación adicional:**
```js
const testBloq = r.find(b => b.motivo === 'TEST_setup_dia_completo');
console.log(testBloq);
console.log(testBloq.hora === null);   // true → bloqueo de día completo
```

**Cleanup:** ninguno.

**Si falla:**
- Trae bloqueos pasados → el filtro `fecha >= hoy` no se aplicó en el cuerpo.
- No trae el del setup → revisar que `2030-12-31` se interpretó como string ISO, no como Date local.

---

#### 3. `obtenerCitasAdminConReportado()`

**Tabla(s) Supabase:** `citas` (SELECT con join `clientes(perros)`), `conversaciones` (SELECT)
**RLS requerido:** `es_admin() = true` en ambas
**Fase:** A

**Llamada:**
```js
const r = await api.obtenerCitasAdminConReportado();
console.log(r);
console.log(`${r.length} citas`);
```

**Resultado esperado:**
- Array de citas con shape:
  ```
  {
    id, fecha, hora, estado, modalidad, zona, notas, confirmada, cliente_id,
    clientes: { nombre, telefono, zona, perros: [{ nombre, raza, edad, problematica }] },
    reportado: string|null
  }
  ```
- Ordenado por `fecha ASC, hora ASC`. Solo `fecha >= hoy`.
- Debe incluir la cita TEST del setup con `notas='TEST_setup_cita'`,
  `clientes.nombre='TEST_Cliente_Setup'`, `clientes.perros[0].nombre='TEST_Perro_Setup'`.
- Para la cita TEST `reportado` será `null` (no hay conversación asociada).

**Confirmado:** `perros.edad_meses` (integer). El SELECT de
`obtenerCitasAdminConReportado()` debe traer `edad_meses`, no `edad`.
Verificado vía MCP el 2026-05-07.

**Verificación adicional:**
```js
const testCita = r.find(c => c.notas === 'TEST_setup_cita');
console.log(testCita);
console.log(testCita.clientes?.nombre);     // "TEST_Cliente_Setup"
console.log(testCita.clientes?.perros?.[0]?.nombre);  // "TEST_Perro_Setup"
console.log(testCita.reportado);             // null
```

Charly también anota `testCita.id` para usarlo en tests B-08/09/10:
```js
window.CITA_TEST_ID_RUNTIME = testCita.id;
```

**Cleanup:** ninguno.

**Si falla:**
- Devuelve citas sin `clientes` → el embebido del select no funcionó (revisar foreign key).
- Devuelve citas sin `reportado` → la 2da query a `conversaciones` no se hizo o no se mergeó.
- 403 → RLS de `conversaciones` no permite SELECT a admin (policy faltante).

---

#### 4. `obtenerSesionesParaStats(desde, hasta)`

**Tabla(s) Supabase:** `sesiones` (SELECT con filtros `inicio`, `es_prueba=false`)
**RLS requerido:** `es_admin() = true`
**Fase:** A

**Llamada:**
```js
const r = await api.obtenerSesionesParaStats('2026-01-01', '2026-12-31');
console.log(r);
console.log(`${r.length} sesiones en 2026`);
```

**Resultado esperado:**
- Array de filas de `sesiones` (`select=*`). Forma exacta no auditada
  acá — el llamador real (`_cargarDatosStats` del admin viejo) sabe qué
  columnas leer.
- Ordenado por `inicio DESC`.
- Si la query falla, devuelve `[]` (NUNCA tira). Verificable forzando
  un rango imposible:
  ```js
  const r2 = await api.obtenerSesionesParaStats('1990-01-01', '1990-01-02');
  console.log(r2);   // []
  ```

**Verificación adicional:**
```js
const tieneEsPrueba = r.every(s => s.es_prueba === false);
console.log(tieneEsPrueba);   // true
```

**Cleanup:** ninguno.

**Si falla:**
- Tira excepción → el cuerpo no envolvió en try/catch (incumple
  contrato defensivo del original).
- Trae sesiones con `es_prueba=true` → el filtro no se aplicó.

---

#### 5. `obtenerNombresCitasPorIds(citaIds)`

**Tabla(s) Supabase:** `citas` (SELECT con `clientes(nombre)`)
**RLS requerido:** `es_admin() = true`
**Fase:** A

**Llamada (usando IDs de la fase A-3):**
```js
// Tomá 2-3 IDs de citas reales del paso anterior
const ids = [window.CITA_TEST_ID_RUNTIME];   // o más
const r = await api.obtenerNombresCitasPorIds(ids);
console.log(r);
```

**Resultado esperado:**
- Objeto plano `{ [citaId]: nombreCliente }`.
- Para `CITA_TEST_ID` debe devolver `'TEST_Cliente_Setup'`.
- Si una cita no tiene cliente con nombre, NO aparece en el mapa.

**Caso borde — array vacío:**
```js
const r0 = await api.obtenerNombresCitasPorIds([]);
console.log(r0);   // {} (no hace query)
```

**Cleanup:** ninguno.

**Si falla:**
- Devuelve array en lugar de objeto → revisar reduce/forEach del cuerpo.
- Devuelve `{ [id]: null }` para IDs sin cliente → debería omitir, no
  poner null (contrato del JSDoc).

---

### Fase B — Toggles e UPDATEs (revertibles fácil)

#### 6. `toggleSlotActivo(id, false)` — pausar slot TEST

**Tabla(s) Supabase:** `slots` (UPDATE)
**RLS requerido:** `es_admin() = true`
**Fase:** B

**Llamada:**
```js
const r = await api.toggleSlotActivo(SLOT_TEST_A_ID, false);
console.log(r);   // undefined (void)
```

**Resultado esperado:** void / undefined.

**Verificación adicional:**
```js
const { data } = await supabase.from('slots').select('activo').eq('id', SLOT_TEST_A_ID).single();
console.log(data.activo);   // false
```

**Cleanup:** se revierte en test 7.

**Si falla:**
- Slot sigue con `activo=true` → el UPDATE no se ejecutó (revisar `.eq('id', id)`).
- 403 → RLS sobre UPDATE de slots no permite a admin.

---

#### 7. `toggleSlotActivo(id, true)` — reactivar slot TEST

**Llamada:**
```js
await api.toggleSlotActivo(SLOT_TEST_A_ID, true);
const { data } = await supabase.from('slots').select('activo').eq('id', SLOT_TEST_A_ID).single();
console.log(data.activo);   // true
```

**Resultado esperado:** void; `activo=true` tras la llamada.

**Cleanup:** ninguno (queda como antes del test 6).

---

#### 8. `confirmarCita(citaId)` — estado='confirmada'

**Tabla(s) Supabase:** `citas` (UPDATE estado)
**RLS requerido:** `es_admin() = true`
**Fase:** B

**Setup previo (necesario porque la cita TEST ya está en estado='confirmada'):**
```js
// Forzamos a 'pendiente' (o lo que use el schema) para que confirmar tenga efecto
await supabase.from('citas').update({ estado: 'pendiente' }).eq('id', CITA_TEST_ID);
```

**Confirmado:** `text` con default `'pendiente'`. Sin enum/constraint en DB.
Estados válidos en uso: `pendiente` | `confirmada` | `cancelada` | `realizada`.
Para el setup, crear cita con `estado='pendiente'` EXPLÍCITO. Verificado vía
MCP el 2026-05-07.

**Llamada:**
```js
await api.confirmarCita(CITA_TEST_ID);
const { data } = await supabase.from('citas').select('estado').eq('id', CITA_TEST_ID).single();
console.log(data.estado);   // 'confirmada'
```

**Resultado esperado:** void; `estado='confirmada'` tras la llamada.

**Cleanup:** se sobreescribe en test 9.

---

#### 9. `cancelarCita(citaId)` — estado='cancelada'

**Llamada:**
```js
await api.cancelarCita(CITA_TEST_ID);
const { data } = await supabase.from('citas').select('estado').eq('id', CITA_TEST_ID).single();
console.log(data.estado);   // 'cancelada'
```

**Resultado esperado:** void; `estado='cancelada'`.

**Cleanup:** se sobreescribe en test 10.

---

#### 10. `marcarCitaRealizada(citaId)` — estado='realizada'

**Llamada:**
```js
await api.marcarCitaRealizada(CITA_TEST_ID);
const { data } = await supabase.from('citas').select('estado').eq('id', CITA_TEST_ID).single();
console.log(data.estado);   // 'realizada'
```

**Resultado esperado:** void; `estado='realizada'`.

**Cleanup:** restaurar `estado='confirmada'` para que el cleanup final pueda borrar limpio:
```js
await supabase.from('citas').update({ estado: 'confirmada' }).eq('id', CITA_TEST_ID);
```

---

### Fase C — INSERTs y DELETEs simples

#### 11. `añadirSlotPlantilla(dia_semana, hora)` — crea slot nuevo

**Tabla(s) Supabase:** `slots` (SELECT preflight + INSERT si no existe)
**RLS requerido:** `es_admin() = true`
**Fase:** C

**Llamada:**
```js
const r = await api.añadirSlotPlantilla(5, '05:45');
console.log(r);
window.SLOT_NUEVO_ID = r.id;   // anotar para test 12
```

**Resultado esperado:**
- Objeto `{ id, dia_semana: 5, hora: '05:45:00', activo: true }`.
- `hora` normalizada a `'HH:MM:SS'` aunque entró como `'HH:MM'`.

**Verificación adicional:**
```js
const { data } = await supabase.from('slots').select('*').eq('id', r.id).single();
console.log(data);
```

**Idempotencia (caso preflight match):**
```js
const r2 = await api.añadirSlotPlantilla(5, '05:45');
console.log(r2.id === r.id);   // true → devolvió el preexistente sin crear duplicado
```

**Cleanup:** se borra en test 12.

**Si falla:**
- Crea duplicado en la 2da llamada → el SELECT preflight no se ejecutó.
- `hora` queda como `'05:45'` (sin segundos) → el cuerpo no normalizó.

---

#### 12. `eliminarSlotPlantilla(id)` — borra el slot recién creado

**Llamada:**
```js
await api.eliminarSlotPlantilla(window.SLOT_NUEVO_ID);
const { data } = await supabase.from('slots').select('*').eq('id', window.SLOT_NUEVO_ID);
console.log(data);   // []
```

**Resultado esperado:** void; el SELECT post-delete devuelve `[]`.

**Caso borde — id inexistente:**
```js
await api.eliminarSlotPlantilla('00000000-0000-0000-0000-000000000000');
// Esperado: NO tira (no-op silencioso, alineado al original).
// Si tira → revisar contrato (decisión del Bloque 1.B sobre cómo
// tratar id inexistente; ver Observación 5 del README).
```

**Cleanup:** ninguno.

---

#### 13. `bloquearDia(fecha, motivo, hora)` — crea bloqueo

**Tabla(s) Supabase:** `bloqueos` (INSERT)
**RLS requerido:** `es_admin() = true`
**Fase:** C

**Caso A — bloqueo de día completo (sin hora):**
```js
await api.bloquearDia('2030-11-30', 'TEST_bloqueo_completo');
const { data: a } = await supabase.from('bloqueos')
  .select('*').eq('fecha', '2030-11-30').eq('motivo', 'TEST_bloqueo_completo');
console.log(a);
window.BLOQ_NUEVO_A_ID = a[0].id;
```

**Esperado:** 1 fila con `fecha='2030-11-30'`, `motivo='TEST_bloqueo_completo'`, `hora=null`.

**Caso B — bloqueo de slot puntual con `'HH:MM'`:**
```js
await api.bloquearDia('2030-11-29', 'TEST_bloqueo_slot', '14:00');
const { data: b } = await supabase.from('bloqueos')
  .select('*').eq('fecha', '2030-11-29').eq('motivo', 'TEST_bloqueo_slot');
console.log(b);
console.log(b[0].hora);   // '14:00:00' (normalizado)
window.BLOQ_NUEVO_B_ID = b[0].id;
```

**Caso C — defaults (motivo='', sin hora):**
```js
await api.bloquearDia('2030-11-28');
const { data: c } = await supabase.from('bloqueos')
  .select('*').eq('fecha', '2030-11-28');
console.log(c[0].motivo);   // '' (string vacío, no null — convención del original)
console.log(c[0].hora);     // null
window.BLOQ_NUEVO_C_ID = c[0].id;
```

**Cleanup:** se borra en test 14 (los 3).

**Si falla:**
- `hora` guardada como `'14:00'` → no se normalizó a `HH:MM:SS`.
- `motivo` guardado como `null` → el default `''` no se respetó.

---

#### 14. `eliminarBloqueo(id)` — borra los 3 bloqueos del test 13

**Llamada:**
```js
await api.eliminarBloqueo(window.BLOQ_NUEVO_A_ID);
await api.eliminarBloqueo(window.BLOQ_NUEVO_B_ID);
await api.eliminarBloqueo(window.BLOQ_NUEVO_C_ID);

const { data } = await supabase.from('bloqueos')
  .select('*').in('id', [window.BLOQ_NUEVO_A_ID, window.BLOQ_NUEVO_B_ID, window.BLOQ_NUEVO_C_ID]);
console.log(data);   // []
```

**Resultado esperado:** void; los 3 IDs ya no existen.

**Cleanup:** ninguno.

---

### Fase D — La compleja (toca 4 tablas con rollback)

#### 15. `crearCitaManual(datos)` — caso feliz

**Tabla(s) Supabase:** `clientes` (INSERT), `perros` (INSERT), `citas`
(INSERT), `bloqueos` (INSERT best-effort)
**RLS requerido:** `es_admin() = true` en las 4
**Fase:** D

**Caso 15.a — feliz: todos los campos completos**

```js
const datos15a = {
  cliente: { nombre: 'TEST_CrearManual_15a', telefono: '+34 600 000 015' },
  perro:   { nombre: 'TEST_Perro_15a', raza: 'Mestizo', edad_meses: 24, peso_kg: 12.5, es_ppp: false },
  cita:    { fecha: '2030-07-20', hora: '11:00', modalidad: 'presencial', zona: 'Palma', notas: 'TEST_15a_caso_feliz' }
};
const r = await api.crearCitaManual(datos15a);
console.log(r);
// Esperado: { ok: true, clienteId: '...', perroId: '...', citaId: '...' }

window.CASO_15A = r;   // anotar para cleanup
```

**Verificación adicional:**
```js
// Cliente creado con estado='consulta' y zona heredada de cita.zona
const { data: cli } = await supabase.from('clientes').select('*').eq('id', r.clienteId).single();
console.log(cli.estado, cli.zona);   // 'consulta', 'Palma'

// Perro vinculado al cliente
const { data: perro } = await supabase.from('perros').select('*').eq('id', r.perroId).single();
console.log(perro.cliente_id === r.clienteId);   // true
console.log(perro.edad_meses);   // 24

// Cita con estado='confirmada' y confirmada=true
const { data: cita } = await supabase.from('citas').select('*').eq('id', r.citaId).single();
console.log(cita.estado);       // 'confirmada'
console.log(cita.confirmada);   // true
console.log(cita.hora);         // '11:00:00' (normalizada)

// Bloqueo auto-generado con motivo "Auto: cita {citaId}"
const { data: bloq } = await supabase.from('bloqueos')
  .select('*').eq('motivo', `Auto: cita ${r.citaId}`);
console.log(bloq);   // 1 fila
window.CASO_15A_BLOQ_ID = bloq[0]?.id;
```

**Cleanup del 15.a:** se borra en test 16 + cleanup final (DELETE
del bloqueo, perro y cliente).

**Si falla:**
- Devuelve `{ ok: false, ... }` → mirar `r.error`. Probable RLS sobre
  alguna de las 4 tablas o constraint.
- Tira excepción → el cuerpo no envolvió en try/catch (incumple
  contrato defensivo).
- Cita creada pero sin bloqueo → comportamiento aceptable según JSDoc
  (bloqueo es best-effort), pero anotarlo y revisar la tabla.

---

#### 15.b — error de validación: falta nombre del cliente

```js
const datos15b = {
  cliente: { telefono: '+34 600 000 016' },   // sin nombre
  perro:   { nombre: 'TEST_Perro_15b' },
  cita:    { fecha: '2030-07-21', hora: '12:00' }
};
const r = await api.crearCitaManual(datos15b);
console.log(r);
// Esperado: { ok: false, error: 'Faltan datos de cliente' }
```

**Verificación adicional — la DB NO debe tener nada nuevo:**
```js
const { count } = await supabase.from('clientes')
  .select('*', { count: 'exact', head: true })
  .eq('nombre', 'TEST_Perro_15b');
console.log(count);   // 0

const { data } = await supabase.from('citas')
  .select('*').eq('fecha', '2030-07-21');
console.log(data);   // []
```

**Cleanup del 15.b:** ninguno (no se creó nada).

**Si falla:**
- Devuelve `{ ok: true }` → el guard de validación al inicio no se ejecutó.
- Devuelve `{ ok: false }` PERO la DB tiene filas → el código creó algo
  antes de validar.

---

> **NO testear** el rollback fallando en INSERT 3 (cita) — requiere
> romper la conexión a propósito o desactivar RLS de citas
> momentáneamente. Fuera de alcance del Bloque 1.B. Queda anotado en
> `DEUDA_TECNICA.md` ítem 1.

---

#### 16. `eliminarCita(citaId)` — borra la cita del 15.a

**Tabla(s) Supabase:** `citas` (DELETE)
**RLS requerido:** `es_admin() = true`
**Fase:** D

**Llamada:**
```js
await api.eliminarCita(window.CASO_15A.citaId);
const { data } = await supabase.from('citas').select('*').eq('id', window.CASO_15A.citaId);
console.log(data);   // []
```

**Resultado esperado:** void; la cita ya no existe.

**NOTA:** dejamos el bloqueo + perro + cliente del 15.a vivos a propósito
para que el cleanup final los limpie (probando que el cleanup vía
prefijo `TEST_` funciona).

---

## 3. Cleanup final (después de todos los tests)

Lista de operaciones que Opus ejecuta vía MCP para dejar la DB
exactamente como estaba antes del setup. EL ORDEN IMPORTA (FK
dependencies):

```sql
-- 1) Borrar bloqueos auto-generados ("Auto: cita ...") y los TEST_*
DELETE FROM bloqueos WHERE motivo LIKE 'TEST_%';
DELETE FROM bloqueos WHERE fecha = '2030-12-31' AND motivo = 'TEST_setup_dia_completo';
DELETE FROM bloqueos WHERE motivo LIKE 'Auto: cita %' AND fecha BETWEEN '2030-01-01' AND '2030-12-31';

-- 2) Borrar citas TEST_*
DELETE FROM citas WHERE notas LIKE 'TEST_%';
DELETE FROM citas WHERE fecha BETWEEN '2030-01-01' AND '2030-12-31';

-- 3) Borrar perros TEST_*
DELETE FROM perros WHERE nombre LIKE 'TEST_%';

-- 4) Borrar clientes TEST_*
DELETE FROM clientes WHERE nombre LIKE 'TEST_%';

-- 5) Borrar slots TEST_* (las horas raras del setup + cualquier residuo)
DELETE FROM slots WHERE hora IN ('03:15:00', '04:30:00', '05:45:00');
```

**Verificación final** — los conteos deben coincidir con el baseline
del §1:

```sql
SELECT 'slots'        AS tabla, count(*) FROM slots
UNION ALL SELECT 'bloqueos',     count(*) FROM bloqueos
UNION ALL SELECT 'citas',        count(*) FROM citas
UNION ALL SELECT 'clientes',     count(*) FROM clientes
UNION ALL SELECT 'perros',       count(*) FROM perros
UNION ALL SELECT 'conversaciones', count(*) FROM conversaciones;
```

Charly compara contra los conteos baseline. Si alguna tabla tiene
+1/+2 residuales, identificar la fila huérfana con un `SELECT *
WHERE created_at > <inicio_sesión>` y borrar a mano.

---

## 4. Anexo: tabla de smoke checks rápidos

Para verificar de un vistazo que el setup salió bien antes de empezar
los tests. Pegar todo en consola tras setup:

```js
// slots
const { count: nSlots } = await supabase.from('slots')
  .select('*', { count: 'exact', head: true })
  .in('hora', ['03:15:00', '04:30:00']);
console.log('slots TEST:', nSlots);   // 2

// bloqueos
const { data: bloqs } = await supabase.from('bloqueos')
  .select('*').eq('fecha', '2030-12-31');
console.log('bloqueos 2030-12-31:', bloqs);   // 1 fila

// clientes
const { data: clis } = await supabase.from('clientes')
  .select('*').like('nombre', 'TEST_%');
console.log('clientes TEST:', clis);   // 1 fila

// perros
const { data: perros } = await supabase.from('perros')
  .select('*').like('nombre', 'TEST_%');
console.log('perros TEST:', perros);   // 1 fila

// citas
const { data: citas } = await supabase.from('citas')
  .select('*').like('notas', 'TEST_%');
console.log('citas TEST:', citas);   // 1 fila
```

Si algún conteo no cuadra, el setup fue incompleto: parar y revisar
con Opus antes de avanzar a los tests.

---

## 5. Estado al cerrar este doc

- **Documento generado el** 2026-05-07.
- **Branch:** `feat/admin-unificado` (commit base: `c3ea3d5`).
- **Pendiente:**
  1. Opus ejecuta el setup §1 vía MCP cuando arranque la sesión Bloque 1.B.
  2. Charly anota los IDs generados en la consola (variables `SLOT_TEST_*`, etc.).
  3. Se itera función por función: implementar cuerpo en `api.js`, push, ejecutar
     test correspondiente, validar, pasar al siguiente.
  4. Cleanup final §3 al cerrar la sesión.
- **TODOs resueltos** (2026-05-07, vía MCP):
  - **§A-3 ✅:** `perros.edad_meses` (integer). El SELECT embebido de
    `obtenerCitasAdminConReportado` usa `edad_meses`. La columna `edad`
    (text) es legacy con 0 registros — anotada en `DEUDA_TECNICA.md` ítem 7.
  - **§B-08 ✅:** `citas.estado` es `text` con default `'pendiente'`, sin
    enum. Estados en uso: `pendiente` | `confirmada` | `cancelada` |
    `realizada`. Setup de tests B-08/09/10 fuerza `estado='pendiente'`
    explícito antes de `confirmarCita`.
