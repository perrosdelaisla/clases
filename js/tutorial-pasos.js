// =====================================================================
// tutorial-pasos.js — Definición de pasos del tour de la app cliente.
//
// Para agregar/quitar/editar pasos del tutorial, este es EL ÚNICO
// archivo que toca cambiar. El motor (tutorial.js) lee este array y se
// encarga del overlay, el tooltip, la navegación y el TTS.
//
// Esquema de cada paso:
//   {
//     id:        string único (sirve para debug/analytics futuros),
//     tab:       string|null — slug de la tab que se debe activar antes
//                de mostrar el paso (rutina | reservar | mis-citas |
//                salud | mensajes). Si es null no fuerza tab.
//     selector:  string|null — selector CSS del elemento a destacar.
//                Si es null, el paso se muestra centrado, sin foco.
//     titulo:    string — encabezado del tooltip.
//     texto:     string — cuerpo, lo que también se lee con TTS.
//     posicion:  'auto' | 'top' | 'bottom' | 'center' — preferencia
//                de ubicación del tooltip respecto del target. 'auto'
//                deja que el motor decida según el espacio disponible.
//   }
//
// Reglas de copy (importante):
//   · Español neutro / España (NO rioplatense).
//   · Tono cálido, en positivo, enmarcado en bienestar y felicidad.
//   · Vocabulario: "perro" (nunca "peludito"), "clase" (nunca "sesión"),
//     "valor / inversión" (nunca "precio / coste").
// =====================================================================

window.PDLI_TUTORIAL_PASOS = [
    {
        id: 'bienvenida',
        tab: 'rutina',
        selector: null,
        titulo: '¡Bienvenido!',
        texto: 'Esta es tu app para acompañar la felicidad de tu perro día a día. Te enseño en 30 segundos cómo moverte por ella.',
        posicion: 'center',
    },
    {
        id: 'perro-hero',
        tab: 'rutina',
        selector: '#perro-hero',
        titulo: 'Tu perro',
        texto: 'Aquí ves a tu perro, lo que estamos trabajando con él y cuántas clases tienes disponibles.',
        posicion: 'auto',
    },
    {
        id: 'editar-perro',
        tab: 'rutina',
        selector: '#btn-editar-perro',
        titulo: 'Editar datos del perro',
        texto: 'Con este lápiz puedes actualizar el nombre, la edad o cualquier dato que cambie.',
        posicion: 'auto',
    },
    {
        id: 'rutina-subtabs',
        tab: 'rutina',
        selector: '.rutina-subtabs',
        titulo: 'Tu plan semanal',
        texto: 'Aquí tienes lo que toca trabajar esta semana: ejercicios, cambios de rutina, tareas y herramientas.',
        posicion: 'auto',
    },
    {
        id: 'anillo-semana',
        tab: 'rutina',
        selector: '#anillo-semana',
        titulo: 'Cómo va la semana',
        texto: 'Este anillo te muestra lo que llevas cumplido. Cada pequeño paso suma al bienestar de tu perro.',
        posicion: 'auto',
    },
    {
        id: 'tab-reservar',
        tab: 'rutina',
        selector: '[data-tab-target="reservar"]',
        titulo: 'Reservar clase',
        texto: 'Desde aquí reservas tu próxima clase cuando te toque.',
        posicion: 'top',
    },
    {
        id: 'tab-mis-citas',
        tab: 'rutina',
        selector: '[data-tab-target="mis-citas"]',
        titulo: 'Mis citas',
        texto: 'Ves todo lo que tienes agendado y, si necesitas, puedes moverlo.',
        posicion: 'top',
    },
    {
        id: 'tab-salud',
        tab: 'rutina',
        selector: '[data-tab-target="salud"]',
        titulo: 'Salud comportamental',
        texto: 'Una evaluación de cinco minutos que nos ayuda a entender mejor a tu perro y a cuidar su bienestar.',
        posicion: 'top',
    },
    {
        id: 'tab-mensajes',
        tab: 'rutina',
        selector: '[data-tab-target="mensajes"]',
        titulo: 'Mensajes',
        texto: 'Hablas directamente con el adiestrador por aquí. Los avisos importantes también llegan a tu móvil.',
        posicion: 'top',
    },
    {
        id: 'editar-mis-datos',
        tab: 'rutina',
        selector: '#btn-editar-mis-datos',
        titulo: 'Tus datos',
        texto: 'Tu nombre y tu contacto los cambias desde este lápiz, junto al saludo.',
        posicion: 'auto',
    },
    {
        id: 'cierre',
        tab: 'rutina',
        selector: '#btn-tutorial',
        titulo: '¡Listo!',
        texto: 'Si quieres volver a ver este recorrido, está siempre aquí arriba, en este botón con el signo de interrogación.',
        posicion: 'auto',
    },
];
