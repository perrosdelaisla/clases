// =====================================================================
// admin/catalogo-labels.js — fuente única de verdad para etiquetas y
// orden de las categorías de la tabla `ejercicios`.
//
// Consumido por:
//   - admin/admin.js  (pestaña Catálogo, Bloque 5)
//   - admin/perro.js  (modal "Agregar ejercicios")
//
// Cambiar acá → cambia en toda la UI admin.
// =====================================================================

// Mapping categoria DB → label visible (formato natural).
// Para mayúsculas en headers, aplicar text-transform: uppercase en CSS.
export const CATEGORIA_LABEL = {
    ejercicio: 'Ejercicios',
    cambio_rutina: 'Cambios de rutina',
    tarea: 'Tareas',
    herramienta: 'Herramientas',
};

// Orden de presentación en el catálogo (no es alfabético).
export const ORDEN_CATEGORIAS = ['ejercicio', 'cambio_rutina', 'tarea', 'herramienta'];
