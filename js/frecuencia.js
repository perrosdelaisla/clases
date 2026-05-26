// =====================================================================
// frecuencia.js — Helper compartido entre admin/perro.js y js/app.js.
//
// Encapsula la nueva semántica de frecuencia de ejercicios:
//   · min_semanal: objetivo mínimo de veces por semana.
//   · max_diario:  tope por día.
//
// La fuente de verdad para el chip de progreso es:
//   · total_semana = registros en los últimos 7 días (rolling, count_7d).
//   · tope_semanal = max_diario * 7  (cuando hay tope diario).
//
// Estado del chip (3 colores + sin):
//   · 'sin'      → no hay ningún target (chip oculto en consumidores).
//   · 'debajo'   🔴 → min_semanal definido y total_semana < min_semanal.
//   · 'en_zona'  🟢 → entre min_semanal y tope_semanal inclusive
//                     (o ≥ min_semanal si no hay max_diario).
//   · 'encima'   🔵 → total_semana > tope_semanal (sólo aplica si hay max_diario).
//
// Notas de borde:
//   · Si min_semanal es null, no hay rojo posible: arranca en verde y
//     pasa a azul si supera el tope_semanal.
//   · Si max_diario es null, no hay azul posible: rojo o verde según
//     min_semanal.
//   · Si ambos son null, devolvemos 'sin' (el chip no se pinta).
//
// =====================================================================

/**
 * Devuelve el estado del chip para un ejercicio asignado.
 * @param {number|null} min_semanal
 * @param {number|null} max_diario
 * @param {number|null} count_7d
 * @returns {'sin'|'debajo'|'en_zona'|'encima'}
 */
export function estadoChipFrecuencia(min_semanal, max_diario, count_7d) {
    const tieneMin = (min_semanal != null && min_semanal > 0);
    const tieneMax = (max_diario != null && max_diario > 0);
    if (!tieneMin && !tieneMax) return 'sin';

    const total = Number(count_7d) || 0;
    const topeSemanal = tieneMax ? (max_diario * 7) : null;

    if (tieneMax && total > topeSemanal) return 'encima';
    if (tieneMin && total < min_semanal) return 'debajo';
    return 'en_zona';
}

/**
 * Mapea el estado a la clase CSS / color del chip.
 */
export const COLOR_CHIP_FRECUENCIA = {
    sin:     'sin',
    debajo:  'rojo',
    en_zona: 'verde',
    encima:  'azul',
};

/**
 * Texto que va DEBAJO DEL NOMBRE de un ejercicio en la app cliente.
 * Variantes según qué targets tenga:
 *   · ambos:        "4 / semana (máx 2 por día)"
 *   · sólo min:     "4 / semana"
 *   · sólo max:     "máx 2 por día"
 *   · ninguno:      ""  (consumidores lo deben omitir)
 *
 * @param {number|null} min_semanal
 * @param {number|null} max_diario
 * @returns {string}
 */
export function textoObjetivoBajoNombre(min_semanal, max_diario) {
    const tieneMin = (min_semanal != null && min_semanal > 0);
    const tieneMax = (max_diario != null && max_diario > 0);
    if (tieneMin && tieneMax) return `${min_semanal} / semana (máx ${max_diario} por día)`;
    if (tieneMin)             return `${min_semanal} / semana`;
    if (tieneMax)             return `máx ${max_diario} por día`;
    return '';
}

/**
 * Texto compacto para el chip mismo (lo que se muestra ADENTRO del chip).
 * El chip vive en la card de rutina y muestra cuántos en los últimos 7 días
 * frente al objetivo / tope. Ejemplos:
 *   · ambos:    "3/4 sem"        (verde si entre 4 y 14, rojo si <4, azul si >14)
 *   · sólo min: "3/4 sem"
 *   · sólo max: "5 últ. 7d"      (verde si ≤14, azul si >14)
 *
 * @param {number|null} min_semanal
 * @param {number|null} max_diario
 * @param {number|null} count_7d
 * @returns {string}
 */
export function textoChipFrecuencia(min_semanal, max_diario, count_7d) {
    const tieneMin = (min_semanal != null && min_semanal > 0);
    const tieneMax = (max_diario != null && max_diario > 0);
    const total = Number(count_7d) || 0;
    if (tieneMin) return `${total}/${min_semanal} sem`;
    if (tieneMax) return `${total} últ. 7d`;
    return '';
}

/**
 * Validación blanda para el admin: si el mínimo semanal supera lo que
 * el cliente podría llegar a hacer respetando el tope diario.
 *
 * Devuelve un string con el warning si aplica, o null si no hay nada
 * que decir. El admin puede ignorarlo (es informativo).
 *
 * @param {number|null} min_semanal
 * @param {number|null} max_diario
 * @returns {string|null}
 */
export function warningMinSupeaTope(min_semanal, max_diario) {
    if (min_semanal == null || max_diario == null) return null;
    if (min_semanal <= 0 || max_diario <= 0) return null;
    if (min_semanal > max_diario * 7) {
        return `Con un máximo de ${max_diario} por día, el cliente no podría llegar al mínimo de ${min_semanal} por semana (tope alcanzable: ${max_diario * 7}).`;
    }
    return null;
}
