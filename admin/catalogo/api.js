// =====================================================================
// admin/catalogo/api.js — query del catálogo de ejercicios.
//
// Lectura + edición + creación. La pestaña Catálogo del admin permite
// editar y crear ejercicios (modales de edición / nuevo). No permite
// archivar ni borrar: si un ejercicio queda obsoleto, se edita el
// existente (decisión de Charly).
// =====================================================================

import { getSupabase } from '../../js/supabase.js';
const supabase = getSupabase('admin');

/**
 * Lista todos los ejercicios activos del catálogo, ordenados por
 * orden_catalogo ascendente. La agrupación por categoría la hace
 * el llamador (admin.js renderCatalogoAdmin) usando ORDEN_CATEGORIAS
 * de catalogo-labels.js.
 *
 * @returns {Promise<Array<{
 *   id: string,
 *   codigo: string,
 *   nombre: string,
 *   descripcion: string|null,
 *   plantilla: number,
 *   categoria: 'ejercicio'|'cambio_rutina'|'tarea'|'herramienta',
 *   orden_catalogo: number
 * }>>}
 *
 * Tabla(s) Supabase: ejercicios (SELECT con activo=true)
 * RLS requerido: es_admin() = true
 */
export async function obtenerCatalogo() {
    const { data, error } = await supabase
        .from('ejercicios')
        .select('id, codigo, nombre, descripcion, como_se_hace, instrucciones, video_url, plantilla, categoria, orden_catalogo')
        .eq('activo', true)
        .order('orden_catalogo', { ascending: true });
    if (error) throw error;
    return data || [];
}

/**
 * Actualiza los campos editables de un ejercicio del catálogo.
 * Tabla: ejercicios (UPDATE). RLS: es_admin() = true.
 */
export async function actualizarEjercicio(id, campos) {
    const { error } = await supabase
        .from('ejercicios')
        .update({
            nombre: campos.nombre,
            categoria: campos.categoria,
            descripcion: campos.descripcion,
            como_se_hace: campos.como_se_hace,
            instrucciones: campos.instrucciones,
            video_url: campos.video_url,
        })
        .eq('id', id);
    if (error) throw error;
}

/**
 * Crea un ejercicio nuevo en el catálogo. orden_catalogo se autoasigna
 * como MAX(orden_catalogo) + 1 (dos round-trips: SELECT max + INSERT,
 * sin RPC para mantenerlo simple).
 *
 * @param {{
 *   codigo: string,
 *   nombre: string,
 *   plantilla: number,
 *   categoria: 'ejercicio'|'cambio_rutina'|'tarea'|'herramienta',
 *   descripcion?: string|null,
 *   instrucciones?: string|null,
 *   video_url?: string|null,
 * }} campos
 *
 * @returns {Promise<{id:string}>}  Fila creada (sólo el id).
 *
 * @throws {Error} `error.code === 'codigo_duplicado'` si el INSERT viola
 *   el UNIQUE de `codigo` (Postgres 23505). El resto de errores se
 *   re-lanzan tal cual.
 *
 * Tabla: ejercicios (SELECT max + INSERT). RLS: es_admin() = true.
 */
export async function crearEjercicio(campos) {
    const { data: maxRow, error: errMax } = await supabase
        .from('ejercicios')
        .select('orden_catalogo')
        .order('orden_catalogo', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (errMax) throw errMax;
    const ordenNuevo = (maxRow?.orden_catalogo ?? 0) + 1;

    const { data, error } = await supabase
        .from('ejercicios')
        .insert({
            codigo: campos.codigo,
            nombre: campos.nombre,
            plantilla: campos.plantilla,
            categoria: campos.categoria,
            descripcion: campos.descripcion,
            como_se_hace: campos.como_se_hace,
            instrucciones: campos.instrucciones,
            video_url: campos.video_url,
            orden_catalogo: ordenNuevo,
            activo: true,
        })
        .select('id')
        .single();
    if (error) {
        if (error.code === '23505') {
            const err = new Error('codigo_duplicado');
            err.code = 'codigo_duplicado';
            throw err;
        }
        throw error;
    }
    return data;
}
