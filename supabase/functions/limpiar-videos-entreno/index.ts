import { createClient } from 'jsr:@supabase/supabase-js@2';

const RETENCION_DIAS = 90;
const BUCKET = 'entrenos-videos';
const ORFANO_MIN_HORAS = 24;

Deno.serve(async (req) => {
  const secret = Deno.env.get('CRON_SECRET');
  if (!secret) return new Response(JSON.stringify({ error: 'CRON_SECRET no configurado' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  if (req.headers.get('x-cron-secret') !== secret) return new Response(JSON.stringify({ error: 'no autorizado' }), { status: 401, headers: { 'Content-Type': 'application/json' } });

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const res = { vencidos: 0, huerfanos: 0, errores: [] as string[] };

  // 1. VENCIDOS (> 90 días)
  const corte = new Date(Date.now() - RETENCION_DIAS * 86400000).toISOString();
  const { data: vencidos, error: e1 } = await supabase
    .from('registros_ejercicio').select('id, video_path')
    .not('video_path', 'is', null).lt('video_subido_en', corte);
  if (e1) res.errores.push('select vencidos: ' + e1.message);
  if (vencidos && vencidos.length) {
    const paths = vencidos.map((r) => r.video_path as string);
    const { error: eRm } = await supabase.storage.from(BUCKET).remove(paths);
    if (eRm) res.errores.push('remove vencidos: ' + eRm.message);
    const ids = vencidos.map((r) => r.id);
    const { error: eUp } = await supabase.from('registros_ejercicio')
      .update({ video_path: null, video_subido_en: null }).in('id', ids);
    if (eUp) res.errores.push('update vencidos: ' + eUp.message);
    else res.vencidos = vencidos.length;
  }

  // 2. HUÉRFANOS (archivo sin fila, > 24h)
  const { data: activos, error: e2 } = await supabase
    .from('registros_ejercicio').select('video_path').not('video_path', 'is', null);
  if (e2) res.errores.push('select activos: ' + e2.message);
  const activosSet = new Set((activos || []).map((r) => r.video_path as string));
  const limite = Date.now() - ORFANO_MIN_HORAS * 3600000;
  const huerfanos: string[] = [];
  const { data: carpetas, error: e3 } = await supabase.storage.from(BUCKET).list('', { limit: 1000 });
  if (e3) res.errores.push('list raiz: ' + e3.message);
  for (const c of (carpetas || [])) {
    if (c.id) continue; // archivo en raíz, no debería; saltar
    const { data: archivos, error: e4 } = await supabase.storage.from(BUCKET).list(c.name, { limit: 1000 });
    if (e4) { res.errores.push('list ' + c.name + ': ' + e4.message); continue; }
    for (const a of (archivos || [])) {
      const full = `${c.name}/${a.name}`;
      const creado = a.created_at ? new Date(a.created_at).getTime() : 0;
      if (!activosSet.has(full) && creado < limite) huerfanos.push(full);
    }
  }
  if (huerfanos.length) {
    const { error: eRmH } = await supabase.storage.from(BUCKET).remove(huerfanos);
    if (eRmH) res.errores.push('remove huerfanos: ' + eRmH.message);
    else res.huerfanos = huerfanos.length;
  }

  return new Response(JSON.stringify(res), { status: 200, headers: { 'Content-Type': 'application/json' } });
});
