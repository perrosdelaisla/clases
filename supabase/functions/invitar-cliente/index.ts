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

const APP_URL = 'https://app.perrosdelaisla.es/clases/';
const LOGO_URL = 'https://perrosdelaisla.github.io/clases/img/icon-192.png';
const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
const MAIL_FROM = 'hola@perrosdelaisla.es';
const MAIL_FROM_NAME = 'Perros de la Isla';
// hola@ no tiene buzón: si alguien responde, la respuesta va al Gmail del equipo.
const MAIL_REPLY_TO = { email: 'clasesperrosdelaisla@gmail.com', name: 'Perros de la Isla' };

// Orígenes permitidos para CORS (producción + servidor local de pruebas).
const ALLOWED_ORIGINS = [
    'https://perrosdelaisla.github.io',
    'https://app.perrosdelaisla.es',
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
        'Te damos acceso a la app de clases de Perros de la Isla.',
        'Para entrar necesitas hacer 3 cosas. Te llevará un minuto.',
        '',
        'Paso 1 — Copia este código:',
        codigo,
        '(mantén el dedo pulsado sobre él para copiarlo)',
        '',
        'Paso 2 — Abre la app desde este enlace:',
        inviteLink,
        '',
        'Paso 3 — La app se abrirá con tu correo ya puesto. Pega el código en la casilla y pulsa Entrar.',
        '',
        'Si no recibes bien el correo, revisa la carpeta de spam.',
        'Si no has solicitado esto, puedes ignorar este mensaje.',
        '',
        'Un saludo,',
        'El equipo de Perros de la Isla',
    ].join('\n');

    // Plantilla HTML de Design — 3 pasos numerados. Los placeholders
    // ({{CODIGO}}, {{ENLACE_INVITE}}, {{LOGO_URL}}) van interpolados; el
    // saludo se agrega como primer párrafo del cuerpo, antes del <h1>.
    const htmlContent = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <title>Te damos acceso a la app de clases</title>
  <!--[if mso]>
  <style>
    table, td, div, h1, p { font-family: Arial, Helvetica, sans-serif !important; }
    .btn-mso { padding: 18px 0 !important; }
  </style>
  <![endif]-->
  <style>
    /* Email-safe: only used by clients that support <style>. Everything visual is also inlined below. */
    @media (max-width: 620px) {
      .container { width: 100% !important; }
      .px { padding-left: 24px !important; padding-right: 24px !important; }
      .code-num { font-size: 40px !important; letter-spacing: 8px !important; }
      .btn a { font-size: 17px !important; padding: 18px 24px !important; }
      .step-row td.num-cell { width: 44px !important; }
      .step-num { width: 36px !important; height: 36px !important; line-height: 36px !important; font-size: 18px !important; }
    }
    a { color: #C8102E; }
    .code-num::selection { background: #C8102E; color: #F5EFE0; }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#F5EFE0; -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">

  <!-- Preheader -->
  <div style="display:none; font-size:1px; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden; mso-hide:all; color:#F5EFE0;">
    Tu código de acceso a la app de clases. Tres pasos sencillos. Un minuto.
  </div>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5EFE0;">
    <tr>
      <td align="center" style="padding: 32px 16px 48px 16px;">

        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px; max-width:600px; background-color:#F5EFE0;">

          <!-- LOGO -->
          <tr>
            <td align="center" style="padding: 8px 24px 18px 24px;">
              <img src="${LOGO_URL}" width="88" height="88" alt="Perros de la Isla" style="display:block; width:88px; height:88px; border:0; outline:none; text-decoration:none;">
            </td>
          </tr>

          <!-- Brand lockup -->
          <tr>
            <td align="center" style="padding: 0 24px 6px 24px;">
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:22px; line-height:1.1; font-weight:700; letter-spacing:3px; text-transform:uppercase; color:#C8102E;">
                Perros de la Isla
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0 24px 22px 24px;">
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:13px; line-height:1.3; font-weight:600; letter-spacing:1.5px; text-transform:uppercase; color:#1A1A1A;">
                Adiestramiento canino profesional
              </p>
            </td>
          </tr>

          <!-- Red accent line -->
          <tr>
            <td align="center" style="padding: 0 24px 24px 24px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:36px; height:2px; background-color:#C8102E; font-size:0; line-height:0;">&nbsp;</td></tr></table>
            </td>
          </tr>

          <!-- HEADER COPY -->
          <tr>
            <td class="px" align="left" style="padding: 0 40px 8px 40px;">
              <p style="margin:0 0 14px 0; font-family: Arial, Helvetica, sans-serif; font-size:17px; line-height:1.55; color:#1A1A1A;">
                ${saludo}
              </p>
              <h1 style="margin:0 0 14px 0; font-family: Arial, Helvetica, sans-serif; font-size:26px; line-height:1.25; font-weight:700; color:#1A1A1A; letter-spacing:-0.2px;">
                Te damos acceso a la app de clases.
              </h1>
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:17px; line-height:1.55; color:#1A1A1A;">
                Para entrar a la app necesitas hacer <strong style="font-weight:700;">3 cosas</strong>.<br>
                Te llevará un minuto.
              </p>
            </td>
          </tr>

          <tr><td style="font-size:0; line-height:0; height:32px;">&nbsp;</td></tr>

          <!-- PASO 1 -->
          <tr>
            <td class="px" style="padding: 0 40px;">
              <table role="presentation" class="step-row" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="num-cell" valign="top" width="56" style="width:56px;">
                    <div class="step-num" style="width:40px; height:40px; line-height:40px; background-color:#C8102E; color:#F5EFE0; font-family: Arial, Helvetica, sans-serif; font-size:20px; font-weight:700; text-align:center; border-radius:999px;">1</div>
                  </td>
                  <td valign="top" style="padding:4px 0 0 0;">
                    <p style="margin:0 0 6px 0; font-family: Arial, Helvetica, sans-serif; font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#6B7A3A;">Paso 1</p>
                    <h2 style="margin:0 0 10px 0; font-family: Arial, Helvetica, sans-serif; font-size:20px; line-height:1.3; font-weight:700; color:#1A1A1A;">Copia este código.</h2>
                    <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:16px; line-height:1.55; color:#1A1A1A;">
                      Mantén el dedo pulsado sobre él hasta que aparezca la opción de copiar.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Code box -->
          <tr>
            <td class="px" align="center" style="padding: 18px 40px 0 96px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#EBE2CD; border:1px solid #D9CFB6; border-radius:10px;">
                <tr>
                  <td align="center" style="padding: 22px 16px;">
                    <div class="code-num" style="font-family: 'Courier New', Courier, monospace; font-size:44px; line-height:1; font-weight:700; color:#1A1A1A; letter-spacing:12px; padding-left:12px;">${codigo}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr><td style="font-size:0; line-height:0; height:36px;">&nbsp;</td></tr>
          <tr><td class="px" style="padding: 0 40px;"><div style="border-top:1px solid #E2D8BF; font-size:0; line-height:0; height:1px;">&nbsp;</div></td></tr>
          <tr><td style="font-size:0; line-height:0; height:36px;">&nbsp;</td></tr>

          <!-- PASO 2 -->
          <tr>
            <td class="px" style="padding: 0 40px;">
              <table role="presentation" class="step-row" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="num-cell" valign="top" width="56" style="width:56px;">
                    <div class="step-num" style="width:40px; height:40px; line-height:40px; background-color:#C8102E; color:#F5EFE0; font-family: Arial, Helvetica, sans-serif; font-size:20px; font-weight:700; text-align:center; border-radius:999px;">2</div>
                  </td>
                  <td valign="top" style="padding:4px 0 0 0;">
                    <p style="margin:0 0 6px 0; font-family: Arial, Helvetica, sans-serif; font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#6B7A3A;">Paso 2</p>
                    <h2 style="margin:0 0 10px 0; font-family: Arial, Helvetica, sans-serif; font-size:20px; line-height:1.3; font-weight:700; color:#1A1A1A;">Abre la app.</h2>
                    <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:16px; line-height:1.55; color:#1A1A1A;">
                      Pulsa este botón para abrir la app.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Bulletproof button -->
          <tr>
            <td class="px" align="center" style="padding: 20px 40px 0 96px;">
              <table role="presentation" class="btn" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;">
                <tr>
                  <td align="center" bgcolor="#C8102E" style="background-color:#C8102E; border-radius:10px; mso-padding-alt:0;">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${inviteLink}" style="height:56px;v-text-anchor:middle;width:420px;" arcsize="18%" stroke="f" fillcolor="#C8102E">
                      <w:anchorlock/>
                      <center style="color:#FFFFFF;font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:700;">Abrir la app</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-- -->
                    <a href="${inviteLink}" target="_blank" style="display:block; padding:20px 28px; font-family: Arial, Helvetica, sans-serif; font-size:18px; font-weight:700; line-height:1; color:#FFFFFF; text-decoration:none; border-radius:10px; background-color:#C8102E; mso-hide:all;">
                      Abrir la app
                    </a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr><td style="font-size:0; line-height:0; height:36px;">&nbsp;</td></tr>
          <tr><td class="px" style="padding: 0 40px;"><div style="border-top:1px solid #E2D8BF; font-size:0; line-height:0; height:1px;">&nbsp;</div></td></tr>
          <tr><td style="font-size:0; line-height:0; height:36px;">&nbsp;</td></tr>

          <!-- PASO 3 -->
          <tr>
            <td class="px" style="padding: 0 40px;">
              <table role="presentation" class="step-row" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td class="num-cell" valign="top" width="56" style="width:56px;">
                    <div class="step-num" style="width:40px; height:40px; line-height:40px; background-color:#C8102E; color:#F5EFE0; font-family: Arial, Helvetica, sans-serif; font-size:20px; font-weight:700; text-align:center; border-radius:999px;">3</div>
                  </td>
                  <td valign="top" style="padding:4px 0 0 0;">
                    <p style="margin:0 0 6px 0; font-family: Arial, Helvetica, sans-serif; font-size:13px; font-weight:700; letter-spacing:1.5px; text-transform:uppercase; color:#6B7A3A;">Paso 3</p>
                    <h2 style="margin:0 0 10px 0; font-family: Arial, Helvetica, sans-serif; font-size:20px; line-height:1.3; font-weight:700; color:#1A1A1A;">Pega el código y entra.</h2>
                    <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:16px; line-height:1.55; color:#1A1A1A;">
                      La app se abrirá con tu correo ya puesto. Pega el código en la casilla y pulsa <strong style="font-weight:700;">Entrar</strong>.
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr><td style="font-size:0; line-height:0; height:48px;">&nbsp;</td></tr>

          <!-- CLOSING NOTES -->
          <tr>
            <td class="px" align="left" style="padding: 0 40px;">
              <p style="margin:0 0 10px 0; font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.55; color:#5B5B5B;">
                Si no recibes bien el correo, revisa la carpeta de spam.
              </p>
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:14px; line-height:1.55; color:#5B5B5B;">
                Si no has solicitado esto, puedes ignorar este mensaje.
              </p>
            </td>
          </tr>

          <tr><td style="font-size:0; line-height:0; height:32px;">&nbsp;</td></tr>

          <!-- SIGNATURE -->
          <tr>
            <td class="px" align="left" style="padding: 0 40px;">
              <p style="margin:0 0 4px 0; font-family: Arial, Helvetica, sans-serif; font-size:16px; line-height:1.55; color:#1A1A1A;">Un saludo,</p>
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:16px; line-height:1.55; color:#1A1A1A; font-weight:700;">El equipo de Perros de la Isla</p>
            </td>
          </tr>

          <tr><td style="font-size:0; line-height:0; height:40px;">&nbsp;</td></tr>

          <!-- FOOTER -->
          <tr>
            <td class="px" align="center" style="padding: 0 40px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="width:24px; height:2px; background-color:#C8102E; font-size:0; line-height:0;">&nbsp;</td></tr></table>
            </td>
          </tr>
          <tr><td style="font-size:0; line-height:0; height:14px;">&nbsp;</td></tr>
          <tr>
            <td class="px" align="center" style="padding: 0 40px;">
              <p style="margin:0; font-family: Arial, Helvetica, sans-serif; font-size:12px; line-height:1.5; letter-spacing:1px; text-transform:uppercase; color:#8A8A8A;">
                Perros de la Isla &middot; Adiestramiento canino &middot; Mallorca
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;

    const resp = await fetch(BREVO_ENDPOINT, {
        method: 'POST',
        headers: {
            'api-key': apiKey,
            'content-type': 'application/json',
            'accept': 'application/json',
        },
        body: JSON.stringify({
            sender: { email: MAIL_FROM, name: MAIL_FROM_NAME },
            replyTo: MAIL_REPLY_TO,
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
