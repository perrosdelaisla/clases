// =====================================================================
// admin/catalogo/api.js — query del catálogo de ejercicios.
//
// Lectura + edición. La pestaña Catálogo del admin permite editar
// nombre, descripción e instrucciones de cada ejercicio (modal de
// edición). No permite crear ni borrar ejercicios.
// =====================================================================

import { supabase } from '../../js/supabase.js';

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
        .select('id, codigo, nombre, descripcion, instrucciones, plantilla, categoria, orden_catalogo')
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
            descripcion: campos.descripcion,
            instrucciones: campos.instrucciones,
        })
        .eq('id', id);
    if (error) throw error;
}
