// =====================================================================
// admin/catalogo/api.js — query del catálogo de ejercicios.
//
// Solo lectura. La pestaña Catálogo del admin no permite crear,
// editar ni borrar; los renombres se hacen por SQL desde Opus.
// Si en el futuro se agregan operaciones de escritura, viven acá.
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
        .select('id, codigo, nombre, descripcion, plantilla, categoria, orden_catalogo')
        .eq('activo', true)
        .order('orden_catalogo', { ascending: true });
    if (error) throw error;
    return data || [];
}
