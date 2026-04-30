# CLAUDE.md — Clases (Perros de la Isla)

## Resumen del proyecto

Plataforma de seguimiento de clases para clientes activos de **Perros de la Isla** (escuela de adiestramiento canino, Palma de Mallorca). Tercera app del catálogo, junto a **Paseos Seguros** y **Victoria** — cada una en su propio repo y proyecto Supabase, sin acoplamiento entre ellas.

Slogan oficial: **"Tu perro merece ser feliz hoy"** (no inventar variantes).

## Stack y decisiones técnicas

- **Frontend**: Vanilla JS puro. Sin framework, sin build step, sin npm. Solo HTML estático + CSS + JS + Service Worker + `manifest.json`.
- **Hosting**: GitHub Pages — repo `github.com/perrosdelaisla/clases`, Pages ya activado.
- **Backend**: Supabase, proyecto `pdli-clases` en `https://bchlhvgddguhjtgfenmo.supabase.co`. La publishable key vive como placeholder en `js/supabase.js` y la rellena Charly manualmente.
- **Auth**: Supabase Auth, email + contraseña.
- **Notificaciones**: ntfy.sh — pendiente, se integra más adelante.
- **SDK Supabase**: importado desde CDN como ES module (`https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm`).

## Brand voice

- **Tipografías**: Bebas Neue para titulares (siempre en mayúsculas), Inter para texto corrido.
- **Colores**: fondo `#111`, rojo principal `#c0392b`, verde acento `#9cb64b`.
- **Estilo visual**: dark mode minimalista, líneas finas, transiciones cuidadas.

## Reglas de lenguaje (estrictas)

Aplican a **todo** el texto visible en la app — UI, copy, mensajes, errores, emails. Excepción: textos legales y de facturación pueden usar terminología estándar.

| Nunca usar | Siempre usar |
|---|---|
| precio, coste, tarifa, cuánto cuesta | **valor** o **inversión** |
| peludito, peludo, amigo peludo, bolita de pelo, colita feliz | **perro** (o **perrito** ocasional) |
| sesión (cuando el tono lo permita) | **clase** |

## Reglas de trabajo

1. **Nunca** hacer push automático a GitHub sin permiso explícito de Charly.
2. Antes de cualquier cambio destructivo (DELETE, DROP, eliminar archivos), enseñar qué se va a tocar y esperar OK.
3. Al editar archivos grandes, mostrar solo el bloque modificado, no el archivo entero.
4. Antes de eliminar funciones que parezcan no usadas, hacer `grep` para confirmar que no se referencian.
5. Si una operación de escritura en Supabase no tiene efecto visible, sospechar primero de **RLS**.
6. Tras cualquier cambio de código, bumpear cache: `?v=N` en `index.html` y `CACHE_VERSION` en `service-worker.js`.
7. Charly aprueba manualmente cada acción ("Yes" individual). No usar "allow all session".
8. **No improvisar sobre adiestramiento canino** — la metodología (ejercicios, plantillas de registro, protocolo de ansiedad, modelo de datos detallado) está cerrada en otro contexto. Si surge una duda metodológica, preguntar antes de escribir código.

## Pendientes y notas

_(vacío — se irá llenando)_
