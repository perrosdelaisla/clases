// =====================================================================
// invitar-cliente — edge function (proyecto sydzfwwiruxqaxojymdz).
//
// Invita a un cliente a la app /clases/ con UN SOLO correo.
//
// El flujo viejo (admin/cliente.js -> signInWithOtp) mandaba 2 correos
// para un email nuevo: el de "Confirm sign up" + el del código. Esta
// función lo unifica:
//   1. verifica que quien llama sea admin,
//   2. UPSERT en invitaciones_pendientes (el trigger handle_new_auth_user
//      la lee al crearse el usuario),
//   3. crea el usuario con la Admin API SIN disparar correos de GoTrue,
//   4. genera el código de 6 dígitos con generateLink (tampoco manda
//      correo),
//   5. manda UN correo propio con el código vía la API HTTP de Brevo.
//
// La service_role y la API key de Brevo viven solo acá, como variables
// de entorno — nunca tocan el cliente.
// =====================================================================

import { createClient } from '@supabase/supabase-js';

const APP_URL = 'https://perrosdelaisla.github.io/clases/';
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const MAIL_FROM = 'clasesperrosdelaisla@gmail.com';
const MAIL_FROM_NAME = 'Perros de la Isla';

// Orígenes permitidos para CORS (producción + servidor local de pruebas).
const ALLOWED_ORIGINS = [
    'https://perrosdelaisla.github.io',
    'http://localhost:5500',
];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildCors(req: Request): Record<string, string> {
    const origin = req.headers.get('Origin') ?? '';
    const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin': allow,
        'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
}

// ¿El error de createUser es "el usuario ya existe"? (caso reinvitación)
function esUsuarioYaExiste(err: { code?: string; message?: string } | null): boolean {
    if (!err) return false;
    const code = (err.code ?? '').toLowerCase();
    const msg = (err.message ?? '').toLowerCase();
    return code === 'email_exists'
        || code === 'user_already_exists'
        || msg.includes('already been registered')
        || msg.includes('already registered')
        || msg.includes('already exists');
}

async function enviarCorreo(email: string, nombre: string, codigo: string): Promise<void> {
    const apiKey = Deno.env.get('BREVO_API_KEY');
    if (!apiKey) throw new Error('Falta la variable de entorno BREVO_API_KEY');

    const nombrePila = (nombre || '').trim().split(/\s+/)[0] || '';
    const saludo = nombrePila ? `Hola ${nombrePila}:` : 'Hola:';

    // Enlace que abre la app directo en la pantalla de código, con el
    // correo ya cargado (?invite=<email>). NO es un magic link: no lleva
    // token, así que ningún escáner de correo puede invalidar el código.
    const inviteLink = `${APP_URL}?invite=${encodeURIComponent(email)}`;

    const textContent = [
        saludo,
        'Te damos acceso a la app de Perros de la Isla.',
        'Pulsa este enlace para abrir la app con tu correo ya cargado:',
        inviteLink,
        `Y escribe este código de acceso: ${codigo}`,
        'Si no recibes bien el correo, revisa la carpeta de spam.',
        `Si el enlace no funciona, entra en ${APP_URL}, introduce tu correo y luego el código.`,
        'Si no lo has solicitado, puedes ignorar este mensaje.',
        'Un saludo,',
        'El equipo de Perros de la Isla',
    ].join('\n');

    const htmlContent = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#222222;line-height:1.6">
  <p>${saludo}</p>
  <p>Te damos acceso a la app de Perros de la Isla.</p>
  <p>Pulsa este enlace para abrir la app con tu correo ya cargado:<br>
  <a href="${inviteLink}">Abrir la app de Perros de la Isla</a></p>
  <p>Y escribe este código de acceso:</p>
  <p style="font-size:30px;font-weight:bold;letter-spacing:6px;margin:8px 0;color:#111111">${codigo}</p>
  <p>Si no recibes bien el correo, revisa la carpeta de spam.</p>
  <p>Si el enlace no funciona, entra en <a href="${APP_URL}">${APP_URL}</a>, introduce tu correo y luego el código.</p>
  <p>Si no lo has solicitado, puedes ignorar este mensaje.</p>
  <p>Un saludo,<br>El equipo de Perros de la Isla</p>
</div>`;

    const resp = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
            'api-key': apiKey,
            'content-type': 'application/json',
            'accept': 'application/json',
        },
        body: JSON.stringify({
            sender: { email: MAIL_FROM, name: MAIL_FROM_NAME },
            to: [{ email }],
            subject: 'Tu código de acceso — Perros de la Isla',
            textContent,
            htmlContent,
        }),
    });

    if (!resp.ok) {
        const detalle = (await resp.text().catch(() => '')).slice(0, 300);
        throw new Error(`Brevo respondió ${resp.status}. ${detalle}`);
    }
}

Deno.serve(async (req: Request): Promise<Response> => {
    const cors = buildCors(req);
    const json = (payload: unknown, status = 200): Response =>
        new Response(JSON.stringify(payload), {
            status,
            headers: { ...cors, 'content-type': 'application/json' },
        });

    // Preflight CORS.
    if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
    if (req.method !== 'POST') return json({ ok: false, error: 'Método no permitido' }, 405);

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
        return json({ ok: false, error: 'Función mal configurada (faltan variables de Supabase)' }, 500);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
        // 1 — Verificar que quien llama es un admin.
        const authHeader = req.headers.get('Authorization') ?? '';
        const token = authHeader.replace(/^Bearer\s+/i, '').trim();
        if (!token) return json({ ok: false, error: 'Falta autenticación' }, 401);

        const { data: userData, error: userErr } = await admin.auth.getUser(token);
        if (userErr || !userData?.user) {
            return json({ ok: false, error: 'No autorizado' }, 401);
        }
        const caller = userData.user;

        const { data: adminRow, error: adminErr } = await admin
            .from('admins')
            .select('auth_user_id')
            .eq('auth_user_id', caller.id)
            .maybeSingle();
        if (adminErr) {
            return json({ ok: false, error: 'No se pudo verificar el rol de admin' }, 500);
        }
        if (!adminRow) {
            return json({ ok: false, error: 'Solo un administrador puede invitar clientes' }, 403);
        }

        // 2 — Validar el body.
        const body = await req.json().catch(() => null);
        const email = String(body?.email ?? '').trim().toLowerCase();
        const clienteId = String(body?.cliente_id ?? '').trim();
        const nombre = String(body?.nombre ?? '').trim();
        if (!EMAIL_RE.test(email)) return json({ ok: false, error: 'Email inválido' }, 400);
        if (!UUID_RE.test(clienteId)) return json({ ok: false, error: 'Falta el cliente' }, 400);
        if (!nombre) return json({ ok: false, error: 'Falta el nombre del cliente' }, 400);

        // 3 — UPSERT de la invitación. Va ANTES de crear el usuario: el
        // trigger handle_new_auth_user lee esta fila para vincular el
        // usuarios_cliente y, al hacerlo, la borra.
        const { data: existente } = await admin
            .from('invitaciones_pendientes')
            .select('id')
            .eq('email', email)
            .maybeSingle();
        const fueInsert = !existente;

        const { error: upsertErr } = await admin
            .from('invitaciones_pendientes')
            .upsert(
                { email, cliente_id: clienteId, nombre, invitado_por: caller.id },
                { onConflict: 'email' },
            );
        if (upsertErr) {
            return json({ ok: false, error: `No se pudo preparar la invitación: ${upsertErr.message}` }, 500);
        }

        // 4 — Crear el usuario con la Admin API. NO dispara correo de GoTrue.
        // Si ya existía (reinvitación) seguimos: solo hace falta el código.
        const { error: createErr } = await admin.auth.admin.createUser({
            email,
            email_confirm: true,
        });
        if (createErr && !esUsuarioYaExiste(createErr)) {
            // Rollback solo si la invitación la creamos nosotros recién.
            if (fueInsert) {
                await admin.from('invitaciones_pendientes').delete().eq('email', email);
            }
            return json({ ok: false, error: `No se pudo crear el usuario: ${createErr.message}` }, 500);
        }

        // 5 — Generar el código de 6 dígitos. generateLink tampoco manda
        // correo: solo devuelve el OTP en properties.email_otp.
        const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
            type: 'magiclink',
            email,
        });
        const codigo = linkData?.properties?.email_otp;
        if (linkErr || !codigo) {
            return json({ ok: false, error: `No se pudo generar el código: ${linkErr?.message ?? 'sin código'}` }, 500);
        }

        // 6 — Mandar UN correo con el código vía la API HTTP de Brevo.
        try {
            await enviarCorreo(email, nombre, codigo);
        } catch (mailErr) {
            // El usuario ya quedó creado y vinculado (el trigger corrió). No
            // se revierte: el admin reintenta, se regenera el código y se
            // reenvía el correo.
            const msg = mailErr instanceof Error ? mailErr.message : String(mailErr);
            return json({ ok: false, error: `No se pudo enviar el correo: ${msg}` }, 502);
        }

        return json({ ok: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return json({ ok: false, error: `Error inesperado: ${msg}` }, 500);
    }
});
