// =====================================================================
// transcribir-escucha — edge function (proyecto sydzfwwiruxqaxojymdz).
// "Jaime escucha la clase" (Fase 1). Recibe { escucha_id }, descarga el
// audio del bucket privado 'escuchas-clase' con service role, lo transcribe
// con la API de OpenAI (whisper-1, español) y guarda el texto en la fila.
//
// Privacidad: tras transcribir con éxito BORRA el audio del bucket y limpia
// audio_path (el audio no se conserva). Si algo falla, la fila queda en
// estado 'error' y el audio se conserva para poder reintentar (basta con
// volver a invocar la función con el mismo escucha_id).
//
// Auth: mismo gate admin que asistente-admin (token → getUser → tabla admins).
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const ALLOWED_ORIGINS = ['https://perrosdelaisla.github.io', 'https://app.perrosdelaisla.es', 'http://localhost:5500'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUCKET = 'escuchas-clase';
const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';

function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  const cors = buildCors(req);
  const json = (payload: unknown, status = 200): Response =>
    new Response(JSON.stringify(payload), { status, headers: { ...cors, 'content-type': 'application/json' } });

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
  const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const OPENAI_API_KEY = Deno.env.get('OPENAI_API_KEY') ?? '';
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) return json({ ok: false, error: 'Función mal configurada (Supabase)' }, 500);
  if (!OPENAI_API_KEY) return json({ ok: false, error: 'Falta el secret OPENAI_API_KEY: cargalo en el proyecto para poder transcribir.' }, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Marca la fila como 'error' sin tirar la request (best-effort).
  const marcarError = async (id: string) => {
    try { await admin.from('escuchas_clase').update({ estado: 'error' }).eq('id', id); } catch (_e) { /* noop */ }
  };

  let escuchaId = '';
  try {
    // ── Gate admin (idéntico a asistente-admin / resumir-clase) ──
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!token) return json({ ok: false, error: 'Falta autenticación' }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ ok: false, error: 'No autorizado' }, 401);
    const { data: adminRow, error: adminErr } = await admin
      .from('admins').select('auth_user_id').eq('auth_user_id', userData.user.id).maybeSingle();
    if (adminErr) return json({ ok: false, error: 'No se pudo verificar el rol de admin' }, 500);
    if (!adminRow) return json({ ok: false, error: 'Solo un administrador puede transcribir' }, 403);

    const body = await req.json().catch(() => null);
    escuchaId = String(body?.escucha_id ?? '').trim();
    if (!UUID_RE.test(escuchaId)) return json({ ok: false, error: 'Falta escucha_id válido' }, 400);

    const { data: fila, error: filaErr } = await admin
      .from('escuchas_clase')
      .select('id, audio_path, estado, transcripcion')
      .eq('id', escuchaId).maybeSingle();
    if (filaErr) return json({ ok: false, error: 'No se pudo leer la escucha' }, 500);
    if (!fila) return json({ ok: false, error: 'Escucha no encontrada' }, 404);

    // Ya transcrita (audio borrado): nada que hacer, idempotente.
    if (fila.estado === 'transcrita' && !fila.audio_path) {
      return json({ ok: true, estado: 'transcrita', ya: true });
    }
    if (!fila.audio_path) {
      await marcarError(escuchaId);
      return json({ ok: false, error: 'La escucha no tiene audio para transcribir' }, 409);
    }

    // ── Descarga del audio (service role) ──
    const { data: blob, error: dlErr } = await admin.storage.from(BUCKET).download(fila.audio_path);
    if (dlErr || !blob) {
      await marcarError(escuchaId);
      return json({ ok: false, error: `No se pudo descargar el audio: ${dlErr?.message ?? 'desconocido'}` }, 502);
    }

    // ── Transcripción con OpenAI (whisper-1, español) ──
    const form = new FormData();
    form.append('file', blob, 'escucha.webm');
    form.append('model', 'whisper-1');
    form.append('language', 'es');
    form.append('response_format', 'json');

    const oaRes = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    if (!oaRes.ok) {
      const detalle = (await oaRes.text().catch(() => '')).slice(0, 300);
      await marcarError(escuchaId);
      return json({ ok: false, error: `Error al transcribir (${oaRes.status})`, detalle }, 502);
    }
    const oaData = await oaRes.json().catch(() => null);
    const transcripcion = String(oaData?.text ?? '').trim();
    if (!transcripcion) {
      await marcarError(escuchaId);
      return json({ ok: false, error: 'La transcripción vino vacía' }, 502);
    }

    // ── Guardar transcripción + estado 'transcrita' ──
    const { error: upErr } = await admin.from('escuchas_clase')
      .update({ transcripcion, estado: 'transcrita' }).eq('id', escuchaId);
    if (upErr) {
      // No marcamos 'error' para no perder el audio; el reintento re-transcribe.
      return json({ ok: false, error: `No se pudo guardar la transcripción: ${upErr.message}` }, 500);
    }

    // ── Privacidad: borrar el audio del bucket y limpiar audio_path ──
    // Si el remove falla, la transcripción ya quedó guardada; el audio será
    // un huérfano tolerable (no rompemos el flujo por eso).
    const { error: rmErr } = await admin.storage.from(BUCKET).remove([fila.audio_path]);
    if (!rmErr) {
      await admin.from('escuchas_clase').update({ audio_path: null }).eq('id', escuchaId);
    }

    return json({ ok: true, estado: 'transcrita', audio_borrado: !rmErr });
  } catch (err) {
    if (escuchaId) await marcarError(escuchaId);
    const msg = err instanceof Error ? err.message : String(err);
    return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
  }
});
