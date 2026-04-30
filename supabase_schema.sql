-- =====================================================================
-- supabase_schema.sql
-- Schema inicial de la app "Clases" — Perros de la Isla.
--
-- Pegar manualmente en el SQL Editor de Supabase. NO ejecutar
-- automáticamente desde código.
--
-- Todas las tablas se crean con RLS HABILITADO pero SIN policies.
-- Mientras no se añadan policies, las tablas no son accesibles a través
-- de las claves anon/authenticated (solo service_role bypasses RLS).
-- Las policies se definen en una segunda pasada.
-- =====================================================================


-- pgcrypto provee gen_random_uuid(). Supabase suele tenerlo habilitado
-- por defecto en el schema "extensions"; este IF NOT EXISTS es
-- idempotente y no hace nada si ya está instalado.
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;


-- =====================================================================
-- 1) clientes
-- =====================================================================
-- Hogares cliente. Un hogar puede tener múltiples perros y múltiples usuarios.
CREATE TABLE IF NOT EXISTS clientes (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre_hogar        text NOT NULL,
    telefono_principal  text,
    notas_admin         text,
    activo              boolean NOT NULL DEFAULT true,
    creado_en           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 2) perros
-- =====================================================================
-- Perros asociados a un cliente. Un cliente puede tener múltiples perros.
CREATE TABLE IF NOT EXISTS perros (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    cliente_id  uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    nombre      text NOT NULL,
    raza        text,
    edad_anios  int,
    peso_kg     numeric(5,2),
    notas       text,
    creado_en   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE perros ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 3) usuarios_cliente
-- =====================================================================
-- Vincula cuentas de Supabase Auth con un cliente.
-- Soporta múltiples usuarios por hogar con rol principal o secundario.
CREATE TABLE IF NOT EXISTS usuarios_cliente (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    cliente_id      uuid NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
    nombre_visible  text NOT NULL,
    rol             text NOT NULL CHECK (rol IN ('principal','secundario')),
    creado_en       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (auth_user_id, cliente_id)
);

ALTER TABLE usuarios_cliente ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 4) planes_caso
-- =====================================================================
-- Plan activo de un perro. Un único registro por perro (UNIQUE en perro_id).
CREATE TABLE IF NOT EXISTS planes_caso (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    perro_id              uuid NOT NULL UNIQUE REFERENCES perros(id) ON DELETE CASCADE,
    protocolo_principal   text,
    fase_actual           text,
    zona_critica          text,
    estimulo_1            text,
    estimulo_2            text,
    estimulo_3            text,
    notas_plan            text,
    actualizado_en        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE planes_caso ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 5) ejercicios
-- =====================================================================
-- Catálogo global de ejercicios. Compartido entre todos los perros,
-- mantenido por administración. No pertenece a ningún cliente.
CREATE TABLE IF NOT EXISTS ejercicios (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre              text NOT NULL,
    descripcion_corta   text,
    descripcion_larga   text,
    plantilla_registro  text NOT NULL CHECK (plantilla_registro IN ('A','B','C','D','E')),
    bloque              text,
    orden_catalogo      int NOT NULL DEFAULT 0,
    activo              boolean NOT NULL DEFAULT true,
    creado_en           timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ejercicios ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 6) ejercicios_asignados
-- =====================================================================
-- Ejercicios del catálogo asignados a un perro concreto, con sus
-- parámetros y orden dentro de la rutina.
CREATE TABLE IF NOT EXISTS ejercicios_asignados (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    perro_id          uuid NOT NULL REFERENCES perros(id) ON DELETE CASCADE,
    ejercicio_id      uuid NOT NULL REFERENCES ejercicios(id) ON DELETE CASCADE,
    posicion_rutina   int NOT NULL DEFAULT 0,
    parametros        jsonb DEFAULT '{}'::jsonb,
    notas_admin       text,
    activo            boolean NOT NULL DEFAULT true,
    actualizado_en    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ejercicios_asignados ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 7) sesiones_rutina
-- =====================================================================
-- Sesión de trabajo iniciada por un usuario del cliente con un perro.
-- usuario_cliente_id usa ON DELETE SET NULL para preservar la sesión
-- aunque se borre el usuario que la inició (única excepción al CASCADE
-- general del schema).
CREATE TABLE IF NOT EXISTS sesiones_rutina (
    id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    perro_id                    uuid NOT NULL REFERENCES perros(id) ON DELETE CASCADE,
    usuario_cliente_id          uuid REFERENCES usuarios_cliente(id) ON DELETE SET NULL,
    iniciada_en                 timestamptz NOT NULL DEFAULT now(),
    cerrada_en                  timestamptz,
    estimulo_disparado_inicio   boolean NOT NULL DEFAULT false,
    espacio_calma_contador      int NOT NULL DEFAULT 0,
    apoyos_usados               text[] NOT NULL DEFAULT ARRAY[]::text[],
    nota_cierre                 text
);

ALTER TABLE sesiones_rutina ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 8) registros_ejercicio
-- =====================================================================
-- Registro de un ejercicio ejecutado dentro de una sesión.
-- datos_registro almacena los datos específicos según la plantilla del ejercicio.
CREATE TABLE IF NOT EXISTS registros_ejercicio (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sesion_id                uuid NOT NULL REFERENCES sesiones_rutina(id) ON DELETE CASCADE,
    ejercicio_asignado_id    uuid NOT NULL REFERENCES ejercicios_asignados(id) ON DELETE CASCADE,
    datos_registro           jsonb NOT NULL DEFAULT '{}'::jsonb,
    tranquilidad             int CHECK (tranquilidad BETWEEN 1 AND 5),
    nota                     text,
    registrado_en            timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE registros_ejercicio ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- 9) cambios_fase
-- =====================================================================
-- Histórico de cambios de fase del plan de un perro. Auditoría de progresión.
CREATE TABLE IF NOT EXISTS cambios_fase (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    perro_id        uuid NOT NULL REFERENCES perros(id) ON DELETE CASCADE,
    fase_anterior   text,
    fase_nueva      text NOT NULL,
    nota            text,
    cambiado_en     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cambios_fase ENABLE ROW LEVEL SECURITY;


-- =====================================================================
-- Índices
-- =====================================================================

CREATE INDEX IF NOT EXISTS idx_perros_cliente_id
    ON perros(cliente_id);

CREATE INDEX IF NOT EXISTS idx_usuarios_cliente_auth_user_id
    ON usuarios_cliente(auth_user_id);

CREATE INDEX IF NOT EXISTS idx_usuarios_cliente_cliente_id
    ON usuarios_cliente(cliente_id);

CREATE INDEX IF NOT EXISTS idx_ejercicios_asignados_perro_id
    ON ejercicios_asignados(perro_id);

CREATE INDEX IF NOT EXISTS idx_sesiones_rutina_perro_iniciada
    ON sesiones_rutina(perro_id, iniciada_en DESC);

CREATE INDEX IF NOT EXISTS idx_registros_ejercicio_sesion
    ON registros_ejercicio(sesion_id);

CREATE INDEX IF NOT EXISTS idx_registros_ejercicio_asignado
    ON registros_ejercicio(ejercicio_asignado_id);

CREATE INDEX IF NOT EXISTS idx_cambios_fase_perro_cambiado
    ON cambios_fase(perro_id, cambiado_en DESC);
