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
        id: 'seguimiento',
        tab: 'rutina',
        selector: '#btn-seguimiento',
        titulo: 'Seguimiento de conductas',
        texto: 'Aquí puedes anotar cómo evoluciona cada conducta de tu perro día a día —los paseos, quedarse solo, lo que estéis trabajando— marcando con un color cómo fue cada jornada. Verás el avance de un vistazo.',
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
        id: 'registro-huella',
        tab: 'rutina',
        selector: '.huella-btn',
        titulo: 'Registra cada práctica',
        texto: 'Cuando practiquéis un ejercicio, toca su huella. Un toque equivale a una práctica de ese ejercicio, no a cada repetición. Verás un cartel que te confirma que ha quedado guardado y se encenderá uno de los puntitos de debajo, que son tu objetivo de la semana para ese ejercicio.',
        posicion: 'auto',
    },
    {
        id: 'registro-pausa',
        tab: 'rutina',
        selector: '.huella-btn',
        titulo: 'Con calma',
        texto: 'Después de cada toque la huella se rellena durante unos segundos y no se puede volver a tocar. Así registramos lo que de verdad habéis practicado y tu adiestrador ve el trabajo real.',
        posicion: 'auto',
    },
    {
        id: 'isla-semana',
        tab: 'rutina',
        selector: '#isla-semana',
        titulo: 'La isla de la semana',
        texto: 'La isla florece con el entrenamiento: cuanto más practicáis durante la semana, más verde y más viva la verás. Es tu resumen de un vistazo.',
        posicion: 'auto',
    },
    {
        id: 'mi-progreso',
        tab: 'rutina',
        selector: '.rutina-modo',
        titulo: 'Mi progreso',
        texto: 'En "Mi progreso" tienes el camino del protocolo de tu perro: avanza con cada clase realizada, no con el paso del tiempo. Debajo verás también tu historial de las últimas semanas y las medallas conseguidas.',
        posicion: 'auto',
    },
    {
        id: 'acompanamiento',
        tab: 'rutina',
        selector: null,
        titulo: 'No estás solo en esto',
        texto: 'Cada vez que registras cómo fue un ejercicio, tu adiestrador lo ve y puede responderte. Y si un día cuesta, te invitamos a escribirle para verlo juntos.',
        posicion: 'center',
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
        titulo: 'Bienestar y felicidad',
        texto: 'Una evaluación de cinco minutos que nos ayuda a entender mejor a tu perro y a cuidar su bienestar.',
        posicion: 'top',
    },
    {
        id: 'tab-mensajes',
        tab: 'rutina',
        selector: '[data-tab-target="mensajes"]',
        titulo: 'Mensajes',
        texto: 'Hablas directamente con el adiestrador, y aquí recibes cada semana un resumen de cómo vais. Los avisos importantes llegan a tu móvil.',
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
        selector: '#avatar-btn',
        titulo: '¡Listo!',
        texto: 'Si quieres volver a ver este recorrido, lo tienes en el menú de tu avatar (arriba a la derecha), en "Ver el tutorial".',
        posicion: 'auto',
    },
];
