/* Vigía — pronóstico multi-modelo para todo Chile (Arica a la Antártica).
   Datos: Open-Meteo (CC BY 4.0). Observaciones: DMC + red OMM (NOAA).
   Sin claves, sin tracking, sin CDNs. */
'use strict';

// ── Configuración ──────────────────────────────────────────────

const API = 'https://api.open-meteo.com/v1/forecast';
const API_ENS = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const API_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const API_AIRE = 'https://air-quality-api.open-meteo.com/v1/air-quality';
const TZ = 'America/Santiago';

// index.html precarga vendor/leaflet.css con <link rel="preload"> (no bloquea
// el render); acá se aplica como stylesheet real. Para cuando este script
// (defer) corre, el archivo ya está en la caché del navegador por el
// preload, así que no hay una espera de red nueva ni un salto visible.
document.head.appendChild(Object.assign(document.createElement('link'), {
  rel: 'stylesheet', href: 'vendor/leaflet.css',
}));

// ── ICAP: índice de calidad del aire chileno (D.S. 12/2011 MMA) ──
// La concentración de MP2,5 (promedio móvil 24 h) se mapea a un índice por
// tramos lineales; los puntos de quiebre 50/80/110/170 µg/m³ son los umbrales
// oficiales de norma, alerta, preemergencia y emergencia.
const ICAP_BP = [
  [0, 50, 0, 100], [50, 80, 100, 200], [80, 110, 200, 300], [110, 170, 300, 500],
];
function mp25ToIcap(c) {
  if (c == null) return null;
  for (const [cl, ch, il, ih] of ICAP_BP) {
    if (c <= ch) return Math.round(il + ((c - cl) / (ch - cl)) * (ih - il));
  }
  return Math.min(999, Math.round(500 + (c - 170) * 1.5));
}
const ICAP_NIVELES = [
  { max: 100, n: 'Buena',         c: '#2eae00', cls: 'icap-0', consejo: 'Aire limpio. Ideal para actividades al aire libre.' },
  { max: 200, n: 'Regular',       c: '#d6c200', cls: 'icap-1', consejo: 'Aceptable. Personas muy sensibles podrían reducir el esfuerzo prolongado al aire libre.' },
  { max: 300, n: 'Alerta',        c: '#ff7e00', cls: 'icap-2', consejo: 'Grupos sensibles (niños, adultos mayores, enfermos respiratorios) deben evitar el esfuerzo al aire libre.' },
  { max: 500, n: 'Preemergencia', c: '#e3000f', cls: 'icap-3', consejo: 'Evita la actividad física al aire libre. Los grupos sensibles deben permanecer en interiores.' },
  { max: Infinity, n: 'Emergencia', c: '#7e0023', cls: 'icap-4', consejo: 'Toda la población debe evitar actividad al aire libre y mantener puertas y ventanas cerradas.' },
];
const icapNivel = (icap) => ICAP_NIVELES.find((x) => icap < x.max) || ICAP_NIVELES[ICAP_NIVELES.length - 1];

const MODELS = [
  { id: 'ecmwf_ifs025',         name: 'IFS',    org: 'ECMWF · Europa' },
  { id: 'gfs_seamless',         name: 'GFS',    org: 'NOAA · EE.UU.' },
  { id: 'icon_seamless',        name: 'ICON',   org: 'DWD · Alemania' },
  { id: 'gem_seamless',         name: 'GEM',    org: 'ECCC · Canadá' },
  { id: 'meteofrance_seamless', name: 'ARPEGE', org: 'Météo-France' },
  { id: 'ecmwf_aifs025_single', name: 'AIFS',   org: 'ECMWF · IA' },
];

const MODEL_COLORS = {
  light: ['#2456c9', '#0e9888', '#b07d10', '#8b4ac2', '#c8451f', '#c2317e'],
  dark:  ['#6f9bff', '#3fc4b1', '#d9a83a', '#b685e0', '#ff7a4d', '#ff6fb0'],
};

const PLACES = [
  { region: 'Chile', items: [
    { name: 'Arica',        lat: -18.478, lon: -70.321 },
    { name: 'Iquique',      lat: -20.214, lon: -70.152 },
    { name: 'Antofagasta',  lat: -23.650, lon: -70.400 },
    { name: 'Calama',       lat: -22.456, lon: -68.924 },
    { name: 'Copiapó',      lat: -27.366, lon: -70.332 },
    { name: 'La Serena',    lat: -29.904, lon: -71.249 },
    { name: 'Valparaíso',   lat: -33.046, lon: -71.620 },
    { name: 'Viña del Mar', lat: -33.024, lon: -71.552 },
    { name: 'Santiago',     lat: -33.437, lon: -70.650 },
    { name: 'Rancagua',     lat: -34.171, lon: -70.744 },
    { name: 'Talca',        lat: -35.427, lon: -71.655 },
    { name: 'Chillán',      lat: -36.606, lon: -72.104 },
    { name: 'Concepción',   lat: -36.827, lon: -73.050 },
    { name: 'Temuco',       lat: -38.736, lon: -72.590 },
    { name: 'Valdivia',     lat: -39.814, lon: -73.246 },
    { name: 'Puerto Montt', lat: -41.469, lon: -72.943 },
    { name: 'Coyhaique',    lat: -45.571, lon: -72.068 },
    { name: 'Punta Arenas', lat: -53.163, lon: -70.917 },
  ]},
];

// WMO weather_code → [descripción, icono]
const WMO = {
  0: ['Despejado', '☀️'], 1: ['Mayormente despejado', '🌤️'], 2: ['Parcialmente nublado', '⛅'],
  3: ['Nublado', '☁️'], 45: ['Niebla', '🌫️'], 48: ['Niebla con escarcha', '🌫️'],
  51: ['Llovizna débil', '🌦️'], 53: ['Llovizna', '🌦️'], 55: ['Llovizna intensa', '🌧️'],
  56: ['Llovizna helada', '🌧️'], 57: ['Llovizna helada intensa', '🌧️'],
  61: ['Lluvia débil', '🌧️'], 63: ['Lluvia', '🌧️'], 65: ['Lluvia intensa', '🌧️'],
  66: ['Lluvia helada', '🌧️'], 67: ['Lluvia helada intensa', '🌧️'],
  71: ['Nieve débil', '🌨️'], 73: ['Nieve', '🌨️'], 75: ['Nieve intensa', '❄️'],
  77: ['Cinarra', '🌨️'], 80: ['Chubascos débiles', '🌦️'], 81: ['Chubascos', '🌧️'],
  82: ['Chubascos violentos', '⛈️'], 85: ['Chubascos de nieve', '🌨️'],
  86: ['Chubascos de nieve intensos', '❄️'], 95: ['Tormenta eléctrica', '⛈️'],
  96: ['Tormenta con granizo', '⛈️'], 99: ['Tormenta con granizo intenso', '⛈️'],
};

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const DAYS_FULL = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

const OBS_LABELS = {
  temperature_2m: ['Temperatura', '°C'],
  dew_point_2m: ['Punto de rocío', '°C'],
  relative_humidity_2m: ['Humedad relativa', '%'],
  pressure_msl: ['Presión (nivel del mar)', 'hPa'],
  wind_speed_10m: ['Viento (prom. 10 min)', 'km/h'],
  wind_gusts_10m: ['Ráfagas (máx)', 'km/h'],
  wind_direction_10m: ['Dirección del viento', '°'],
  visibility: ['Visibilidad', 'm'],
  cloud_cover: ['Nubosidad', '%'],
  precipitation_6h: ['Precipitación últimas 6 h', 'mm'],
};

// Explicación en lenguaje claro por texto del evento SENAPRED (primer match gana).
// Los específicos van antes que "evento meteorológico", que es el genérico.
const EXPLICA_EVENTO = [
  [/zoosanitario/i, 'Vigilancia del SAG por una enfermedad animal (por ejemplo influenza aviar) detectada en la zona. No es un riesgo directo para las personas: evita tocar aves o animales muertos o enfermos y repórtalos al SAG (2 2345 1100).'],
  [/alteraci[oó]n sanitaria/i, 'Situación sanitaria bajo vigilancia de la autoridad (agua, plagas o brotes). Sigue las indicaciones de la SEREMI de Salud de tu región.'],
  [/crecida/i, 'Ríos o esteros de la zona vienen creciendo por lluvia o deshielo. No cruces cauces ni te acerques a las riberas; si vives cerca de un río, prepara una salida.'],
  [/remoci[oó]n|aluvi[oó]n|deslizamiento/i, 'Riesgo de deslizamientos de tierra o aluviones por lluvia en laderas. Aléjate de quebradas y cauces; si escuchas ruido de piedras o agua creciendo, sube a terreno firme y alto.'],
  [/altas temperaturas|ola de calor/i, 'Calor inusual para la zona. Hidrátate, evita el sol del mediodía y vigila a personas mayores, niños y mascotas. Sube el riesgo de incendios: evita cualquier fuego.'],
  [/helada/i, 'Temperaturas bajo cero esperadas. Protege cañerías, cultivos, mascotas y personas en situación de calle (llama al 800 104 777 — Código Azul).'],
  [/viento/i, 'Viento fuerte esperado. Asegura techumbres, toldos y objetos sueltos; precaución al conducir vehículos altos y aléjate de árboles y tendido eléctrico.'],
  [/volc[aá]n/i, 'El volcán muestra actividad sobre lo normal y está bajo vigilancia reforzada de SERNAGEOMIN. Infórmate de tus vías de evacuación (capa 🏃 Evacuación del mapa) y respeta los perímetros.'],
  [/incendio|forestal/i, 'Condiciones favorables para incendios forestales o fuego activo en la zona. No enciendas fuego, reporta humo al 130 (CONAF) y prepárate para evacuar temprano si estás cerca.'],
  [/meteorol[oó]gico/i, 'Sistema frontal u otro evento del tiempo significativo para la zona (lluvia, viento o nieve). Revisa el pronóstico de tu comuna aquí mismo y evita desplazamientos innecesarios en lo peor del evento.'],
];
const EXPLICA_EVENTO_DEFAULT = 'Alerta oficial de SENAPRED para la zona. Revisa senapred.cl para el detalle del evento.';

function explicaEvento(evento) {
  const hit = EXPLICA_EVENTO.find(([re]) => re.test(evento || ''));
  return hit ? hit[1] : EXPLICA_EVENTO_DEFAULT;
}

// Explicación en lenguaje claro por nivel de alerta SENAPRED.
const EXPLICA_NIVEL = {
  temprana_preventiva: 'Temprana Preventiva: la autoridad vigila de cerca una amenaza que PODRÍA escalar; no exige acción inmediata de tu parte, solo mantenerte informado.',
  amarilla: 'Amarilla: la amenaza crece y los equipos de emergencia se alistan; ten a mano lo esencial y revisa tus rutas.',
  roja: 'Roja: la amenaza está en desarrollo y puede requerir evacuación u otra acción inmediata; sigue YA las instrucciones oficiales.',
};

// ── Explicaciones (simple primero, ciencia después) ────────────

const INFO = {
  actual: {
    title: '¿Qué significa cada dato?',
    html: `
<p><strong>Temperatura y sensación.</strong> La temperatura es la del aire a 2 metros del suelo. La «sensación» corrige ese número por el viento y la humedad: el viento le roba calor a tu piel (te enfría) y la humedad alta impide que el sudor evapore (te acalora). Por eso un día de 5 °C con viento fuerte se siente bajo cero.</p>
<p><strong>Humedad relativa.</strong> Cuánto vapor de agua tiene el aire respecto del máximo que podría tener a esa temperatura. 100 % = aire saturado (niebla o rocío probables); bajo 30 % = aire muy seco.</p>
<p><strong>Viento.</strong> Velocidad y <em>de dónde viene</em> (un viento SO viene desde el suroeste). En la costa de la V Región el viento SO de la tarde es la clásica brisa marina.</p>
<p><strong>Presión al nivel del mar.</strong> El peso de la atmósfera, normalizado al nivel del mar para poder comparar ciudades a distinta altura. Sobre ~1020 hPa suele dominar el buen tiempo (anticiclón); si cae rápido, se acerca un sistema frontal.</p>
<p class="info-fine">Cuando hay una <strong>central de monitoreo cerca</strong> de tu ubicación (≤25 km), este panel muestra su <strong>medición real</strong> —no un pronóstico—: lo indica con "medido en …". Son las mismas estaciones del mapa (aeropuertos de la red OMM y estaciones de la Dirección Meteorológica de Chile). Si no hay ninguna cerca, cae a la estimación interpolada del modelo y lo señala como "estimación de modelo".</p>`,
  },
  aire: {
    title: 'Calidad del aire: MP2,5 y el índice ICAP',
    html: `
<p><strong>En simple:</strong> el número grande es el <strong>ICAP</strong>, el índice oficial chileno de calidad del aire. Mientras más alto, peor el aire. Bajo 100 es bueno; sobre 300 es preemergencia. El color y el consejo siguen la norma del Ministerio del Medio Ambiente.</p>
<p><strong>¿Qué es el MP2,5?</strong> Material particulado fino: partículas de 2,5 micrones o menos —30 veces más delgadas que un cabello—. Son tan pequeñas que esquivan las defensas de la nariz, llegan al fondo del pulmón y pasan a la sangre. Es el contaminante más dañino para la salud y el que dispara las emergencias ambientales.</p>
<p><strong>Por qué importa tanto en Chile central:</strong> en invierno, el aire frío queda atrapado bajo una capa de aire más cálido (inversión térmica) y el humo de la calefacción a leña y los vehículos no logra dispersarse. Por eso Santiago y el valle central tienen episodios críticos de mayo a agosto.</p>
<p><strong>Los niveles oficiales</strong> (según el ICAP, sobre el promedio de 24 horas de MP2,5):</p>
<p class="info-fine">Buena 0–99 · Regular 100–199 · Alerta 200–299 · Preemergencia 300–499 · Emergencia 500+. Concentraciones de quiebre: 50 µg/m³ (norma diaria), 80 (alerta), 110 (preemergencia), 170 (emergencia).</p>
<p class="info-fine"><strong>El dato grande es real, no pronóstico:</strong> cuando hay una estación de la red oficial <strong>SINCA</strong> (Ministerio del Medio Ambiente) cerca de tu ubicación, mostramos su medición y su ICAP oficial. El gráfico de 48 h es el pronóstico del modelo CAMS de Copernicus (vía Open-Meteo). Si no hay estación cercana, todo el panel usa CAMS.</p>`,
  },
  mapa: {
    title: '¿De dónde salen estas mediciones?',
    html: `
<p>Cada punto es una <strong>estación meteorológica real</strong> midiendo ahora mismo, no un pronóstico: cerca de 150 estaciones que cubren las 16 regiones de Chile, de Arica a la Antártica, más Isla de Pascua y Juan Fernández.</p>
<p><strong>Aeropuertos (METAR).</strong> Observaciones oficiales que los aeródromos publican cada hora a la red mundial de la Organización Meteorológica Mundial, con estándares de aviación.</p>
<p><strong>Estaciones automáticas (EMA) de la Dirección Meteorológica de Chile.</strong> Sensores que reportan minuto a minuto a lo largo de todo el país, de cordillera a costa.</p>
<p><strong>Más capas sobre el mismo mapa.</strong> Además de temperatura y aire puedes activar sismos, incendios, alertas, volcanes y avisos meteorológicos derivados, la capa ⛰️ Remociones (catastro histórico SENAPRED de flujos, deslizamientos y caídas de rocas ya ocurridos — no es un pronóstico, pero el terreno con historial es terreno que puede repetir; ante lluvia intensa, aléjate de quebradas y laderas marcadas), la capa 🌊 Ríos (pronóstico de crecidas GloFAS/Copernicus, modelo global de referencia — no reemplaza a la DGA ni a SENAPRED), y —para una emergencia— la capa 🏃 Evacuación (vías de evacuación y zona de inundación ante tsunami y volcán) y la capa 🚑 Emergencia (infraestructura como salud, bomberos y carabineros). Cada capa declara su fuente (u origen, si es propia) justo debajo del mapa.</p>
<p class="info-fine">¿Por qué una estación puede diferir del «ahora» del panel superior? Porque el panel es un modelo interpolado a tu punto exacto y la estación es un sensor físico en SU punto exacto — comparar ambos es justamente cómo medimos la calidad del pronóstico (ver «¿Cuánto acierta cada modelo?»).</p>`,
  },
  ensamble: {
    title: 'La banda de incertidumbre (ensamble)',
    html: `
<p><strong>En simple:</strong> el futuro de la atmósfera no se puede conocer con exactitud, así que el centro europeo ECMWF corre su modelo <strong>51 veces</strong>, cada vez partiendo de condiciones iniciales levemente distintas. La banda muestra dónde cae el 80 % de esos 51 futuros posibles. Banda angosta = los escenarios coinciden, alta confianza. Banda ancha = la atmósfera está «difícil», cualquier número exacto sería una falsa promesa.</p>
<p><strong>La ciencia:</strong> la atmósfera es un sistema caótico — errores diminutos en el estado inicial crecen exponencialmente (el famoso «efecto mariposa» que describió Edward Lorenz en 1963). El pronóstico por ensambles es la respuesta operativa de la meteorología moderna a ese caos: en vez de fingir certeza, se cuantifica la incertidumbre. La línea segmentada es la mediana (la mitad de los escenarios está arriba y la mitad abajo).</p>
<p class="info-fine">Las líneas finas de colores son los 6 modelos <em>deterministas</em> (5 centros mundiales — IFS y AIFS son ambos de ECMWF) — si además de la banda los modelos discrepan entre sí, la incertidumbre es doble.</p>`,
  },
  precipitacion: {
    title: '¿Qué significa «70 % de probabilidad de lluvia»?',
    html: `
<p><strong>Lo que SÍ significa:</strong> de 10 situaciones atmosféricas como la pronosticada, en 7 cae al menos 0,1 mm de agua en esa hora y en ese punto. Es una frecuencia esperada, igual que «este dado tiene 1/6 de probabilidad de salir 6».</p>
<p><strong>Lo que NO significa:</strong> ni que lloverá el 70 % del tiempo, ni que lloverá en el 70 % de la ciudad, ni que la lluvia será «fuerte al 70 %».</p>
<p><strong>¿De dónde sale el número?</strong> Principalmente de contar miembros del ensamble: si 36 de los 51 escenarios dan lluvia a esa hora, la probabilidad ronda el 70 %. Por eso probabilidad e intensidad son cosas distintas: puede haber 90 % de probabilidad de una llovizna de 0,2 mm, o 20 % de un chubasco de 15 mm.</p>
<p class="info-fine">Las barras muestran la intensidad esperada (mm por hora); la línea segmentada, la probabilidad. Para decidir si llevar paraguas, mira la probabilidad; para saber si se inunda el patio, mira los milímetros.</p>`,
  },
  diario: {
    title: 'Cómo leer la franja semanal',
    html: `
<p>Cada tarjeta resume un día: ícono del tiempo predominante, temperatura <strong>máxima</strong> (grande) y <strong>mínima</strong> (gris), y abajo la lluvia: milímetros acumulados esperados y la probabilidad más alta del día.</p>
<p><strong>Toca cualquier día</strong> para abrir su detalle hora a hora, con la comparación entre modelos cuando está disponible.</p>
<p class="info-fine">Ten presente que la confianza decae con el plazo: el pronóstico para mañana es mucho más firme que el del día 7. Es física, no defecto: el caos atmosférico pone un límite duro de ~10-14 días a cualquier pronóstico determinista, por mucho computador que se le ponga.</p>`,
  },
  modelos: {
    title: '¿Qué es un modelo meteorológico y por qué difieren?',
    html: `
<p><strong>En simple:</strong> un modelo numérico divide la atmósfera del planeta en una grilla 3D de celdas (de ~10 a 25 km de lado según el modelo) y resuelve las ecuaciones de la física — movimiento, calor, humedad — hacia adelante en el tiempo, en algunos de los supercomputadores más grandes del mundo.</p>
<p><strong>Los seis que mostramos:</strong> IFS del centro europeo ECMWF (el de mayor prestigio mundial en verificaciones), GFS de la NOAA estadounidense, ICON del servicio alemán DWD, GEM del canadiense ECCC, ARPEGE de Météo-France y AIFS —el modelo de <strong>inteligencia artificial</strong> del propio ECMWF, que aprendió de décadas de datos en vez de resolver a mano las ecuaciones de la física—.</p>
<p><strong>¿Por qué no dicen lo mismo?</strong> Difieren en la resolución de su grilla, en cómo representan procesos más pequeños que una celda (una nube, una quebrada de la cordillera) y en cómo digieren las observaciones iniciales. Chile es terreno difícil: el salto del Pacífico a los Andes en ~150 km es más angosto que una celda de algunos modelos.</p>
<p class="info-fine">La fila «dispersión» es información valiosa: si los 6 modelos coinciden, puedes confiar; si difieren en 6 °C o en 10 mm de lluvia, la atmósfera está genuinamente impredecible y quien te dé un solo número te está simplificando de más.</p>`,
  },
  verificacion: {
    title: '¿Cómo medimos el acierto?',
    html: `
<p><strong>El método:</strong> guardamos cada pronóstico en el momento en que se emite. Cuando llega la hora pronosticada, lo comparamos con lo que <em>realmente midieron</em> las cerca de 150 estaciones de la red nacional (aeropuertos + DMC). Nadie puede retocar el pronóstico después: queda archivado.</p>
<p>Comparamos <strong>6 modelos</strong>, incluido el modelo de inteligencia artificial de ECMWF (AIFS): la tabla de abajo muestra con datos cuál acierta más en Chile, no cuál promete más.</p>
<p><strong>MAE (error absoluto medio):</strong> el tamaño típico del error, en grados. «MAE 1,5 °C a 1 día» significa que, en promedio, la temperatura pronosticada para el día siguiente difirió 1,5 °C de la observada. Mientras más chico, mejor.</p>
<p><strong>Sesgo:</strong> el error <em>con signo</em>. Un sesgo de +1 °C significa que el modelo tiende a pronosticar más calor del que llega; −1 °C, más frío. Conocer el sesgo de cada modelo en cada lugar es la base para corregirlo — exactamente lo que hará nuestro modelo de calibración local.</p>
<p><strong>Los plazos:</strong> «a 1 día» evalúa pronósticos emitidos 24 h antes; «a 4 días», 96 h antes. El error crece con el plazo — eso también lo puedes ver aquí, transparente.</p>
<p><strong>Persistencia (referencia):</strong> el pronóstico más simple que existe — asumir que el clima sigue igual a como estaba hace tantas horas como el plazo evaluado. No es un modelo, es la vara mínima: cualquier modelo serio debería superarla. El porcentaje junto al MAE de cada modelo (ej. «+34%») es su <em>skill</em>: cuánto menor es su error frente al de la persistencia en ese mismo plazo — positivo, le gana; negativo, pierde contra la comparación más ingenua posible.</p>
<p class="info-fine">Ventana móvil: últimos 14 días, todas las estaciones, todas las horas. El número «n» son los pares pronóstico-observación evaluados: con n chico las cifras bailan; con miles, se estabilizan. Este archivo partió el 9 de junio de 2026 y mejora solo con cada hora que pasa.</p>`,
  },
  'avisos-verif': {
    title: '¿Qué significan POD, FAR y CSI?',
    html: `
<p><strong>El método:</strong> los avisos propios de Vigía (no los oficiales) también se archivan al emitirse y se comparan después con lo que las estaciones realmente midieron, con una tolerancia de ±3 h.</p>
<p><strong>POD — detección:</strong> de los eventos que de verdad ocurrieron (la observación cruzó el umbral), en cuántos ya habíamos avisado antes. Más alto es mejor: 90% significa que solo se nos escapó 1 de cada 10.</p>
<p><strong>FAR — falsas alarmas:</strong> de los avisos que emitimos, cuántos NO se llegaron a concretar. Más bajo es mejor: 30% significa que 3 de cada 10 avisos fueron una alarma sin evento real después.</p>
<p><strong>CSI:</strong> un solo número que resume ambos a la vez (aciertos sobre el total de aciertos + falsas alarmas + eventos no avisados). 1,0 sería perfecto; 0 sería no acertar nunca.</p>
<p class="info-fine">Ventana móvil: últimos 14 días. Solo se verifican los tipos con una variable observable directamente en la red (viento, helada, calor, ola de calor/frío, caída de presión, lluvia): nieve, ráfagas, tormenta, UV y los avisos compuestos (aluvional, incendio, nieve en cota baja) no tienen un dato de estación equivalente y quedan fuera por ahora. Con pocos avisos evaluados (n chico) la cifra puede cambiar mucho con el próximo aviso — esas filas se muestran atenuadas.</p>`,
  },
  riesgos: {
    title: '¿De dónde salen estos datos?',
    html: `
<p><strong>Sismos (CSN).</strong> El Centro Sismológico Nacional de la Universidad de Chile es la autoridad oficial en sismología del país: publica cada evento con magnitud, profundidad y ubicación apenas queda procesado. Se complementa con el catálogo de USGS para eventos recientes que el CSN todavía no ha revisado.</p>
<p><strong>Alertas (SENAPRED).</strong> El Servicio Nacional de Prevención y Respuesta ante Desastres declara las alertas oficiales —roja, amarilla o temprana preventiva— por evento meteorológico, aluvión, incendio forestal u otro riesgo, con las comunas exactas bajo alerta.</p>
<p><strong>Volcanes (SERNAGEOMIN).</strong> El Servicio Nacional de Geología y Minería opera la Red Nacional de Vigilancia Volcánica (RNVV) y publica el semáforo técnico de cada volcán activo: verde, amarilla, naranja o roja.</p>
<p><strong>Incendios (NASA FIRMS).</strong> Focos de calor detectados por satélite (sensor VIIRS, 375 m de resolución) en las últimas 48 horas — no todo foco es un incendio confirmado en terreno.</p>
<p><strong>Avisos Vigía (no oficiales).</strong> A diferencia de las fuentes anteriores, estos avisos de viento, helada, lluvia, calor, nieve, riesgo aluvional e incendio NO vienen de un organismo oficial: los calculamos nosotros aplicando umbrales propios —inspirados en los criterios públicos de la DMC (y, para incendio, en la regla 30-30-30 de manejo del fuego), pero sin relación operativa con ellos— a la mediana de nuestro propio pronóstico multi-modelo. El aviso aluvional combina lluvia intensa con una isoterma 0° alta: cuando la nieve que normalmente retendría el agua en la cordillera cae como lluvia, las cuencas reciben agua líquida de golpe y crece el riesgo de crecidas repentinas y aluviones en quebradas y laderas. Cada aviso muestra además el acuerdo entre los modelos individuales (cuántos, por sí solos, cruzan el mismo umbral) como señal de confianza. Trátalos como una señal de alerta temprana, no como un aviso oficial.</p>
<p><strong>Cortes de luz (SEC, best effort).</strong> El listado de interrupciones en línea de la Superintendencia de Electricidad y Combustibles no es una API pública documentada: la leemos igual porque es el dato más cercano a tiempo real que existe, pero puede fallar o quedar desactualizada sin aviso previo de la SEC. Se obtiene desde un equipo fuera del VPS (bloqueos de IP de datacenter) y se refresca cada 15 minutos cuando todo funciona.</p>
<p class="info-fine">Los sismos no se pueden predecir: mostramos lo ya ocurrido y, tras un sismo mayor, la tasa estadística esperada de réplicas (ley de Omori) — nunca una proyección de cuándo o dónde ocurrirá el próximo.</p>
<p><strong>Los tres niveles de alerta SENAPRED:</strong></p>
<p class="info-fine">${EXPLICA_NIVEL.temprana_preventiva}<br>${EXPLICA_NIVEL.amarilla}<br>${EXPLICA_NIVEL.roja}</p>`,
  },
  costa: {
    title: 'Marea, oleaje y alerta de tsunami: ¿qué mostramos y qué no?',
    html: `
<p><strong>La marea que ves</strong> viene de un modelo global (Open-Meteo Marine, ~8 km de resolución) que estima el nivel del mar, el oleaje y la temperatura superficial en 32 puntos de la costa chilena.</p>
<p><strong>Lo que NO es:</strong> una tabla de marea oficial. Para navegación, pesca o cualquier decisión que dependa de la hora exacta de pleamar o bajamar, la referencia es el <strong>SHOA</strong> (shoa.cl), que mide con mareógrafos reales en cada puerto.</p>
<p><strong>El estado de tsunami</strong> de arriba de la página combina los boletines del <strong>PTWC</strong> (Centro de Alerta de Tsunamis del Pacífico, NOAA) con nuestro propio catálogo sísmico. La autoridad oficial en Chile es el <strong>SHOA</strong> a través del <strong>SNAM</strong> (Sistema Nacional de Alarma de Maremotos).</p>
<p><strong>El aviso de marejadas</strong> también es propio (no oficial): lo calculamos cuando el modelo proyecta olas de 3,5 m o más en las próximas 48 h. Las marejadas oficiales las declara el <strong>SHOA</strong>/Armada de Chile.</p>
<p class="info-fine">Regla de autoprotección: si sientes un sismo fuerte y prolongado estando en la costa, evacúa a terreno alto de inmediato — no esperes ninguna alerta oficial, puede llegar después de que la ola toque tierra.</p>`,
  },
};

// ── Estado ─────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const charts = {};            // canvasId → instancia Chart
let lastData = null;          // { best, multi, ens } para redibujar
let verifData = null;
let verifBucket = '24';
let estacionesData = null;
let aireStations = [];   // estaciones SINCA oficiales (calidad del aire)
let aireData = null;     // aire.json completo (solo para su `updated`; las estaciones viven en aireStations)
let sismosData = null;   // catálogo sísmico CSN + USGS
let incendiosData = null; // focos de calor VIIRS (NASA FIRMS)
let alertasData = null;   // alertas naturales vigentes (SENAPRED)
let volcanesData = null;  // alerta técnica volcánica (SERNAGEOMIN RNVV)
let avisosData = null;   // avisos meteo derivados del pronóstico propio (NO oficiales)
let mareaData = null;    // marea, oleaje y temperatura del mar por punto costero (Open-Meteo Marine, no oficial)
let tsunamiData = null;  // estado de amenaza de tsunami (PTWC + catálogo sísmico propio)
let emergenciaData = null; // infraestructura de emergencia (SENAPRED), carga lazy
let emergenciaPromise = null; // promesa del fetch en vuelo, para que llamadas concurrentes la esperen en vez de perderla
let farmaciasData = null; // farmacias de turno (MINSAL/Farmanet, vía satélite), capa propia 'farmacias' Y categoría 'farmacia' dentro de emergenciaData
let farmaciasPromise = null; // promesa del fetch en vuelo, compartida entre loadFarmacias() y loadEmergencia() para no duplicar el fetch
let tsunamiViasData = null; // vías de evacuación tsunami+volcán (SENAPRED), capa 'evacuacion', carga lazy junto con emergenciaData
let tsunamiAreasData = null; // áreas de evacuación ante tsunami (SENAPRED), capa 'evacuacion', carga lazy junto con emergenciaData
let remocionesData = null; // catastro de remociones en masa (SENAPRED), capa 'remociones', carga lazy propia
let crecidasData = null; // pronóstico de crecidas GloFAS/Copernicus (Open-Meteo Flood, no oficial), capa 'crecidas', carga lazy propia
let cortesData = null;   // cortes de luz SEC (best effort, vía satélite en omen)
let esvalData = null;    // cortes de agua Esval, V Región (best effort, vía satélite en omen)
let combustibleData = null; // precios de combustible en línea (CNE), capa 'combustible', carga lazy propia; dormida sin CNE_API_KEY
let biasData = null;     // correcciones de sesgo por estación/modelo/lead
let biasStation = null;  // estación de calibración más cercana a `place` (o null)
// Claves de capa cuyo último fetch falló y todavía no tienen ningún dato que
// mostrar en su lugar: se llenan en el catch/HTTP-error de cada loader, se
// limpian apenas ese mismo loader vuelve a traer datos. El reintento es el
// ciclo de refresco que ya existe (refreshAll, ver "Refresco en vivo") — sin
// timer ni botón propios. Honestidad de frescura (regla 8 de CLAUDE.md):
// "sin eventos" y "no se pudo cargar" deben leerse distinto, nunca el mismo
// silencio (ver textoVacio/notaFallo en "Utilidades").
const cargasFallidas = new Set();
let map = null;
let tileLayer = null;
// Capa satelital GOES-East: tileLayers persistentes fuera de layerGroups
// (ver nota crítica junto a renderMapa) para sobrevivir al clearLayers() de
// cada render sin parpadeo. sateliteFrames es la ventana de los últimos
// timestamps disponibles (ascendente, el más reciente al final).
let sateliteFrames = [];
let sateliteLayers = new Map(); // timestamp ISO (o 'default') → L.tileLayer
let sateliteFrameIdx = -1;
let sateliteTimer = null;
// Capa de solo-etiquetas de CARTO sobre el satélite: sus tiles horneados
// tapan el rotulado del mapa base. Vive fuera de layerGroups por la misma
// razón que sateliteLayers (sobrevivir al clearLayers() de cada render).
let sateliteLabelsLayer = null;
// Marcador de "mi ubicación" (botón 📍 Centrar): vive fuera de layerGroups,
// igual que los tileLayers del satélite, para sobrevivir al clearLayers()
// de cada renderMapa(); se reemplaza entero cada vez que se vuelve a tocar
// el botón (nunca se acumulan marcadores viejos).
let miUbicacionLayer = null;

function savedPlace() {
  try {
    const raw = localStorage.getItem('sinoptica.place');
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.lat === 'number' && typeof p.lon === 'number' && p.name) return p;
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return PLACES[0].items.find((p) => p.name === 'Santiago') || PLACES[0].items[0]; // Santiago
}

let place = savedPlace();
// Código de región (comunas.json, ej. 'V', 'RM') del lugar seleccionado.
// Cacheado para no recorrer las 345 comunas por cada ítem del panel de
// riesgo; se recalcula en setPlace y al terminar de cargar comunas.json
// (ver actualizarPlaceRegion, más abajo junto a enAmbito).
let placeRegionCod = null;

// ── Utilidades ─────────────────────────────────────────────────

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDark = () => document.documentElement.dataset.tema === 'dark' ||
  (document.documentElement.dataset.tema !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
const modelColors = () => MODEL_COLORS[isDark() ? 'dark' : 'light'];
const wmo = (code) => WMO[code] || ['—', '·'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
// Normaliza para comparar texto sin tildes ni mayúsculas ("Ñuñoa" ~ "nunoa").
const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Estado del catastro de comunas (se llena en cargarComunas, más abajo).
// Declarado aquí arriba porque CAPAS.alertas.tieneData() lo lee durante la
// restauración de capas al cargar el script (TDZ si estuviera después).
let comunasData = null;
let comunasCargando = false;

function fetchJSON(url) {
  return fetch(url).then((res) => {
    if (!res.ok) throw new Error(`HTTP ${res.status} en ${new URL(url, location.href).hostname}`);
    return res.json();
  });
}

function weekday(iso, full = false) {
  const [y, m, d] = iso.split('-').map(Number);
  return (full ? DAYS_FULL : DAYS)[new Date(y, m - 1, d, 12).getDay()];
}

function percentile(sorted, p) {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function tempClass(t) {
  if (t == null) return 'tcx';
  const limits = [0, 5, 10, 15, 20, 25, 30];
  for (let i = 0; i < limits.length; i++) if (t < limits[i]) return `tc${i}`;
  return 'tc7';
}

function horaLocal(isoUtc) {
  try {
    return new Date(isoUtc).toLocaleTimeString('es-CL', {
      hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ,
    });
  } catch (_) { return isoUtc; }
}

// Fecha y hora local sin ambigüedad, para eventos que pueden ser de hoy,
// ayer, mañana o de varios días atrás/adelante ("hoy 14:32", "ayer 09:15",
// "mañana 06:00", "8 jul 14:32"). Compara fechas calendario en TZ Chile.
function fechaHora(isoUtc) {
  try {
    const d = new Date(isoUtc);
    const hora = horaLocal(isoUtc);
    const soloFecha = new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const [ey, em, ed] = soloFecha.format(d).split('-').map(Number);
    const [hy, hm, hd] = soloFecha.format(new Date()).split('-').map(Number);
    const diffDias = Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(hy, hm - 1, hd)) / 86400000);
    if (diffDias === 0) return `hoy ${hora}`;
    if (diffDias === -1) return `ayer ${hora}`;
    if (diffDias === 1) return `mañana ${hora}`;
    const dia = d.toLocaleDateString('es-CL', { day: 'numeric', month: 'short', timeZone: TZ }).replace('.', '');
    return `${dia} ${hora}`;
  } catch (_) { return isoUtc; }
}

// Hora relativa compacta para eventos de riesgo ("ahora" / "hace 2 h" / "hace 3 d").
function haceCuanto(fecha) {
  const d = fecha instanceof Date ? fecha : new Date(fecha);
  const ms = Date.now() - d.getTime();
  if (ms < 5 * 60000) return 'ahora';
  const horas = ms / 3600000;
  if (horas < 1) return `hace ${Math.round(ms / 60000)} min`;
  if (horas < 24) return `hace ${Math.round(horas)} h`;
  return `hace ${Math.round(horas / 24)} d`;
}

// Todos los JSON de la ingesta traen `updated` como "YYYY-MM-DD HH:MM UTC":
// centraliza el parseo a Date (antes repetido con .replace(' UTC', 'Z')
// .replace(' ', 'T') en cada capa).
function parseUpdated(updated) {
  return new Date(updated.replace(' UTC', 'Z').replace(' ', 'T'));
}

// Fragmento "actualizado hace X" (o la nota de frescura cuando el satélite
// no ha refrescado) a partir del `updated` global de un JSON — reutilizado
// por metaConFecha() y por popups que solo tienen fecha global, no por ítem.
function actualizadoTexto(updated, stale) {
  if (!updated) return null;
  if (stale) return `datos de ${haceCuanto(parseUpdated(updated))} — el satélite no ha refrescado`;
  return `actualizado ${haceCuanto(parseUpdated(updated))}`;
}

// Meta uniforme de capa: "resumen · actualizado hace X". Helper mínimo para
// no repetir el formateo en cada paintXxx que hoy no muestra fecha.
function metaConFecha(resumen, updated, stale) {
  const frag = actualizadoTexto(updated, stale);
  return frag ? `${resumen} · ${frag}` : resumen;
}

// Etiquetas legibles (sustantivo plural o frase corta, sin artículo) para el
// mensaje de "no se pudo cargar" — una entrada por clave de `cargasFallidas`.
const CAPA_LABEL = {
  sismos: 'sismos', incendios: 'focos de calor', alertas: 'alertas SENAPRED',
  volcanes: 'alerta volcánica', avisos: 'avisos meteorológicos', cortes: 'cortes de luz',
  esval: 'cortes de agua', marea: 'marea y oleaje', remociones: 'catastro de remociones',
  crecidas: 'pronóstico de crecidas', combustible: 'precios de combustible',
  emergencia: 'infraestructura de emergencia', evacuacion: 'vías de evacuación',
  farmacias: 'farmacias de turno',
};

function marcarFallo(capa) { cargasFallidas.add(capa); }
function marcarOk(capa) { cargasFallidas.delete(capa); }

// Mensaje corto y honesto para una o más capas cuyo JSON no cargó (regla 8:
// nunca mostrar un panel vacío en silencio cuando en realidad falló la
// carga, no es que no haya datos que mostrar).
function notaFallo(capas) {
  const lista = capas.map((c) => CAPA_LABEL[c] || c).join(', ');
  return `No se pudieron cargar los datos de ${lista} — se reintentará solo.`;
}

// Texto para el estado "vacío" de una capa: si su último fetch falló, el
// aviso honesto de notaFallo; si no, el mensaje normal (cargando/sin datos)
// que ya usaba cada paintXxx. Reemplaza uno a uno esos literales.
function textoVacio(capa, mensajeNormal) {
  return cargasFallidas.has(capa) ? notaFallo([capa]) : mensajeNormal;
}

// "DD-MM" en hora de Chile a partir de un `updated` global — usado por
// farmacias.json (turno diario), que no trae fecha por local, solo global.
function diaMes(updated) {
  if (!updated) return null;
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', timeZone: TZ })
    .format(parseUpdated(updated));
}

function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}

// ── Carga de datos ─────────────────────────────────────────────

function urlBase(extra) {
  return new URLSearchParams({
    latitude: place.lat.toFixed(4),
    longitude: place.lon.toFixed(4),
    timezone: TZ,
    ...extra,
  }).toString();
}

async function loadAll({ silent = false } = {}) {
  const app = $('#app');
  if (!silent) app.dataset.state = 'loading';
  $('#error').hidden = true;

  const qBest = urlBase({
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,precipitation',
    hourly: 'temperature_2m,precipitation,precipitation_probability,wind_speed_10m,relative_humidity_2m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset,uv_index_max',
    forecast_days: '14',
  });
  const qModels = urlBase({
    hourly: 'temperature_2m,precipitation',
    models: MODELS.map((m) => m.id).join(','),
    forecast_days: '3',
  });
  const qEns = urlBase({
    hourly: 'temperature_2m',
    models: 'ecmwf_ifs025',
    forecast_days: '3',
  });

  const qAire = urlBase({
    current: 'pm10,pm2_5,nitrogen_dioxide,ozone',
    hourly: 'pm2_5',
    past_days: '1',       // necesario para el promedio móvil 24 h del ICAP
    forecast_days: '2',
  });

  // Ensamble y aire son opcionales: si fallan, la app sigue sin ellos.
  const [best, multi, ens, aire] = await Promise.all([
    fetchJSON(`${API}?${qBest}`),
    fetchJSON(`${API}?${qModels}`),
    fetchJSON(`${API_ENS}?${qEns}`).catch(() => null),
    fetchJSON(`${API_AIRE}?${qAire}`).catch(() => null),
  ]);

  lastData = { best, multi, ens, aire };
  render();
  if (!silent) app.dataset.state = 'ready';
}

// ── Render principal ───────────────────────────────────────────

function render() {
  if (!lastData) return;
  renderNow(lastData.best);
  renderAire(lastData.aire);
  renderCharts(lastData.best, lastData.multi, lastData.ens);
  renderDaily(lastData.best);
  renderModelTable(lastData.multi);
  renderChips();
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function estacionAireCercana() {
  let best = null;
  for (const e of aireStations) {
    if (e.pm2_5 == null) continue;
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { ...e, dist: d };
  }
  return best && best.dist <= 60 ? best : null;   // dentro de la zona
}

function renderAire(aire) {
  const panel = $('.panel-aire');
  if (!aire || !aire.current) { if (panel) panel.hidden = true; return; }
  panel.hidden = false;
  const c = aire.current;

  // Serie horaria CAMS (siempre disponible para el gráfico de pronóstico).
  const h = aire.hourly || {};
  const serie = h.pm2_5 || [];
  const nowIdx = (h.time || []).indexOf((c.time || '').slice(0, 13) + ':00');

  // Dato principal: estación oficial SINCA más cercana (medición real).
  // Si no hay una cerca, el pronóstico CAMS sobre el promedio móvil 24 h.
  const oficial = estacionAireCercana();
  let icap, fuenteTxt;
  if (oficial && oficial.icap != null) {
    icap = oficial.icap;
    fuenteTxt = `estación oficial ${oficial.nombre} · ${Math.round(oficial.dist)} km`;
  } else {
    const lo = nowIdx >= 23 ? nowIdx - 23 : 0;
    const ventana = serie.slice(lo, (nowIdx >= 0 ? nowIdx : serie.length - 1) + 1).filter((v) => v != null);
    const pm25_24h = ventana.length ? ventana.reduce((a, b) => a + b, 0) / ventana.length : c.pm2_5;
    icap = mp25ToIcap(pm25_24h);
    fuenteTxt = 'pronóstico CAMS (sin estación cercana)';
  }
  const nivel = icapNivel(icap);

  $('#aire-icap').textContent = icap ?? '—';
  $('#aire-icap').style.color = nivel.c;
  const nv = $('#aire-nivel');
  nv.textContent = nivel.n;
  nv.style.color = nivel.c;
  $('#aire-consejo').textContent = nivel.consejo;
  $('.aire-gauge').style.borderColor = nivel.c;
  $('#aire-place').textContent = fuenteTxt;

  // Concentraciones: las de la estación oficial si existe; si no, CAMS actual.
  const set = (id, v, u) => { $(id).textContent = v == null ? '—' : `${Math.round(v)} ${u}`; };
  set('#aire-pm25', oficial ? oficial.pm2_5 : c.pm2_5, 'µg/m³');
  set('#aire-pm10', oficial ? oficial.pm10 : c.pm10, 'µg/m³');
  set('#aire-no2', c.nitrogen_dioxide, 'µg/m³');
  set('#aire-o3', c.ozone, 'µg/m³');

  // pronóstico MP2,5 próximas 48 h
  if (serie.length && h.time) {
    const start = nowIdx >= 0 ? nowIdx : 0;
    const win = Math.min(48, h.time.length - start);
    const labels = h.time.slice(start, start + win).map((t) => {
      const hh = t.slice(11, 13);
      return hh === '00' ? `${weekday(t.slice(0, 10))} ${hh}h` : `${hh}h`;
    });
    const th = chartTheme();
    destroyChart('chart-aire');
    charts['chart-aire'] = new Chart($('#chart-aire'), {
      data: {
        labels,
        datasets: [{
          type: 'line', label: 'MP2,5 µg/m³ (pronóstico)',
          data: serie.slice(start, start + win),
          borderColor: nivel.c, backgroundColor: nivel.c + '22',
          borderWidth: 1.6, pointRadius: 0, fill: true, tension: 0.3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } },
        scales: {
          x: { grid: { color: th.grid }, ticks: { maxTicksLimit: 8, maxRotation: 0 } },
          y: { grid: { color: th.grid }, beginAtZero: true, title: { display: true, text: 'µg/m³' } },
        },
      },
    });
  }
}

// Fenómeno METAR observado (wxString) → [descripción, ícono], o null.
function wxToDesc(wx) {
  if (!wx) return null;
  const w = wx.toUpperCase();
  if (w.includes('TS')) return ['Tormenta eléctrica', '⛈️'];
  if (w.includes('SN')) return ['Nieve', '🌨️'];
  if (w.includes('RA')) {
    if (w.includes('+')) return ['Lluvia fuerte', '🌧️'];
    if (w.includes('SH')) return ['Chubascos', '🌧️'];
    if (w.includes('-')) return ['Lluvia débil', '🌦️'];
    return ['Lluvia', '🌧️'];
  }
  if (w.includes('DZ')) return ['Llovizna', '🌦️'];
  if (w.includes('FG')) return ['Niebla', '🌫️'];
  if (w.includes('BR')) return ['Neblina', '🌫️'];
  if (w.includes('HZ') || w.includes('FU')) return ['Calima', '🌫️'];
  return null;
}

// Estación de observación más cercana con dato de temperatura reciente.
// Para "Condiciones actuales": preferimos la medición REAL sobre el modelo.
// Entre las estaciones dentro de maxKm, gana siempre la de obs_time más
// reciente (empate → la más cercana): la red DMC/EMA publica con cadencia
// irregular y puede quedar la más cercana horas atrás mientras una METAR
// algo más lejana ya tiene dato de la última hora (caso real: Jardín
// Botánico vs Torquemada en Viña del Mar — un gate de "fresca hasta N min"
// no basta, porque ambas pueden caer bajo ese umbral y sigue ganando la
// más cercana aunque sea bastante más vieja).
function estacionObsCercana(maxKm) {
  if (!estacionesData) return null;
  const ahora = Date.now();
  let best = null;
  for (const e of estacionesData.estaciones) {
    if (!e.obs || e.obs.temperature_2m == null) continue;
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (d > maxKm) continue;
    const edadMin = e.obs_time ? (ahora - Date.parse(e.obs_time)) / 60000 : Infinity;
    if (!best || edadMin < best.edadMin || (edadMin === best.edadMin && d < best.dist)) {
      best = { ...e, dist: d, edadMin };
    }
  }
  return best;
}

// Estación METAR más cercana (<35 km) con fenómeno presente reciente.
function estacionWxCercana() {
  if (!estacionesData) return null;
  let best = null;
  for (const e of estacionesData.estaciones) {
    if (!e.wx) continue;
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { ...e, dist: d };
  }
  return best && best.dist <= 35 ? best : null;
}

// Sensación térmica: wind chill cuando hace frío y hay viento; si no, la temp.
function sensacion(t, vKmh) {
  if (t == null) return null;
  if (t <= 10 && vKmh != null && vKmh > 4.8) {
    const w = Math.pow(vKmh, 0.16);
    return 13.12 + 0.6215 * t - 11.37 * w + 0.3965 * t * w;
  }
  return t;
}

// Umbral km/h donde empieza el grado siguiente (viento sostenido a 10 m; escala
// Beaufort estándar: grado 1 = 1-5, grado 2 = 6-11, grado 3 = 12-19, etc).
const BEAUFORT = [
  [1, 'calma'], [6, 'ventolina'], [12, 'brisa muy débil'], [20, 'brisa débil'],
  [29, 'brisa moderada'], [39, 'brisa fresca'], [50, 'viento fuerte'],
  [62, 'viento muy fuerte'], [75, 'temporal'], [89, 'temporal fuerte'],
  [103, 'temporal muy fuerte'], [118, 'borrasca'], [Infinity, 'huracán'],
];
function beaufort(kmh) {
  const i = BEAUFORT.findIndex(([max]) => kmh < max);
  return { grado: i, nombre: BEAUFORT[i][1] };
}

// Capa "Viento fuerte": umbral Bf 5 (brisa moderada) — bajo eso el viento
// observado no es noticiable en el mapa. Severidad por grado Beaufort, mismo
// semáforo de color que los avisos (.aviso-amarillo/naranja/rojo en app.css).
const UMBRAL_VIENTO_KMH = 29;
function severidadViento(grado) {
  if (grado >= 9) return 'rojo';
  if (grado >= 7) return 'naranja';
  return 'amarillo';
}

// Umbral de ráfaga (km/h) para calificar en la capa: mismo umbral amarillo
// nacional que usa ingesta/avisos.py:111 (RAFAGAS_AMARILLO/NARANJA/ROJO) para
// el aviso de ráfagas — constante solo en Python, replicada aquí a mano.
const UMBRAL_RAFAGA_KMH = 90;
const RAFAGA_NARANJA_KMH = 120;
const RAFAGA_ROJO_KMH = 150;
function severidadRafaga(g) {
  if (g >= RAFAGA_ROJO_KMH) return 'rojo';
  if (g >= RAFAGA_NARANJA_KMH) return 'naranja';
  if (g >= UMBRAL_RAFAGA_KMH) return 'amarillo';
  return null;
}
const SEV_RANGO = { amarillo: 1, naranja: 2, rojo: 3 };
function peorSeveridad(a, b) {
  if (!a) return b;
  if (!b) return a;
  return SEV_RANGO[b] > SEV_RANGO[a] ? b : a;
}

function renderNow(best) {
  const c = best.current;
  // Si hay una central de monitoreo cerca, "Condiciones actuales" son su
  // MEDICIÓN REAL (no el modelo). El modelo solo cuando no hay estación cerca.
  const est = estacionObsCercana(25);
  const o = est ? est.obs : null;
  let [desc, icon] = wmo(c.weather_code);

  // fenómeno: el observado (de la propia estación o de una METAR cercana) manda
  const ew = (est && est.wx) ? est : estacionWxCercana();
  const obsWx = ew ? wxToDesc(ew.wx) : null;
  if (obsWx) { [desc, icon] = obsWx; }

  const temp = o ? o.temperature_2m : c.temperature_2m;
  const rh = o && o.relative_humidity_2m != null ? o.relative_humidity_2m : c.relative_humidity_2m;
  const wsp = o && o.wind_speed_10m != null ? o.wind_speed_10m : c.wind_speed_10m;
  const wdir = o && o.wind_direction_10m != null ? o.wind_direction_10m : c.wind_direction_10m;
  const gust = o && o.wind_gusts_10m != null ? o.wind_gusts_10m : c.wind_gusts_10m;
  const pres = o && o.pressure_msl != null ? o.pressure_msl : c.pressure_msl;
  const feels = o ? sensacion(temp, wsp) : c.apparent_temperature;

  const lugar = `${place.name}${place.admin1 ? ' · ' + place.admin1 : ''}`;
  const nombreCorto = est ? est.nombre.split('·').pop().trim().replace(/\s*\(.*\)/, '') : '';
  const horaObs = est && est.obs_time ? horaLocal(est.obs_time) : null;
  $('#now-place').textContent = est
    ? `${lugar} · medido en ${nombreCorto}${horaObs ? ' · ' + horaObs + ' h' : ''}`
    : `${lugar} · estimación de modelo`;
  $('#now-icon').textContent = icon;
  $('#now-temp').textContent = Math.round(temp);
  $('#now-desc').textContent = desc;
  $('#now-feels').textContent = feels == null ? '—' : `${Math.round(feels)} °C`;
  $('#now-rh').textContent = rh == null ? '—' : `${Math.round(rh)} %`;
  // innerHTML en vez de textContent: envuelve "Bf N (nombre)" en un <span>
  // para que el wrap no separe el grado de su nombre (ver .bf-tag en
  // app.css). Sin riesgo XSS: wsp/wdir son numéricos y beaufort()/compass()
  // solo devuelven strings de listas fijas, nada viene de una fuente externa.
  const rafagaTxt = gust != null && gust > wsp ? ` · ráf. ${Math.round(gust)} km/h` : '';
  $('#now-wind').innerHTML = wsp == null ? '—'
    : `${Math.round(wsp)} km/h ${compass(wdir)} · <span class="bf-tag">Bf ${beaufort(wsp).grado} (${beaufort(wsp).nombre})</span>${rafagaTxt}`;
  $('#now-pres').textContent = pres == null ? '—' : `${Math.round(pres)} hPa`;
  document.title = `${Math.round(temp)}°C ${place.name} — Vigía`;
}

// ── Constructores de gráficos (página y modal comparten) ───────

function chartTheme() {
  Chart.defaults.font.family = getComputedStyle(document.body).getPropertyValue('--font-mono');
  Chart.defaults.font.size = 10.5;
  Chart.defaults.color = css('--ink-soft');
  return { ink: css('--ink'), grid: css('--grid-line'), band: css('--band'),
           accent: css('--accent'), accent2: css('--accent2') };
}

function ensembleSeries(ens, times) {
  if (!ens || !ens.hourly) return null;
  const h = ens.hourly;
  const members = Object.keys(h).filter((k) => k.startsWith('temperature_2m'));
  if (members.length < 10) return null;
  const idx0 = h.time.indexOf(times[0]);
  if (idx0 < 0) return null;
  const p10 = [], p50 = [], p90 = [];
  for (let i = 0; i < times.length; i++) {
    const vals = members.map((m) => h[m][idx0 + i]).filter((v) => v != null).sort((a, b) => a - b);
    if (vals.length < 10) { p10.push(null); p50.push(null); p90.push(null); continue; }
    p10.push(percentile(vals, 0.1));
    p50.push(percentile(vals, 0.5));
    p90.push(percentile(vals, 0.9));
  }
  return { p10, p50, p90, n: members.length };
}

function buildTempChart(canvasId, labels, { ensS, modelSeries, bestSeries, bestLabel }) {
  const th = chartTheme();
  const colors = modelColors();
  const ds = [];
  if (ensS) {
    ds.push(
      { label: 'p90', data: ensS.p90, borderWidth: 0, pointRadius: 0, fill: false, tension: 0.35 },
      { label: `banda 10–90 % (${ensS.n} miembros)`, data: ensS.p10, borderWidth: 0, pointRadius: 0,
        fill: '-1', backgroundColor: th.band, tension: 0.35 },
      { label: 'mediana ensamble', data: ensS.p50, borderColor: th.ink, borderDash: [5, 4],
        borderWidth: 1.6, pointRadius: 0, fill: false, tension: 0.35 },
    );
  }
  (modelSeries || []).forEach((s, i) => {
    ds.push({ label: s.name, data: s.data, borderColor: colors[s.colorIdx ?? i],
              borderWidth: 1.3, pointRadius: 0, fill: false, tension: 0.35 });
  });
  if (bestSeries) {
    const dest = bestLabel === 'Vigía';   // el blend va más destacado
    ds.push({ label: bestLabel || 'síntesis', data: bestSeries, borderColor: th.accent,
              borderWidth: dest ? 3 : 2, pointRadius: 0, fill: false, tension: 0.35,
              order: dest ? -1 : 0 });
  }
  destroyChart(canvasId);
  charts[canvasId] = new Chart($(`#${canvasId}`), {
    type: 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { boxWidth: 14, boxHeight: 2, filter: (it) => it.text !== 'p90' } },
        tooltip: {
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${r1(ctx.parsed.y)} °C` },
          filter: (it) => it.dataset.label !== 'p90',
        },
      },
      scales: {
        x: { grid: { color: th.grid }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { grid: { color: th.grid }, ticks: { callback: (v) => `${v}°` } },
      },
    },
  });
}

function buildPrecipChart(canvasId, labels, mm, prob) {
  const th = chartTheme();
  const ds = [{ type: 'bar', label: 'mm/h', data: mm, backgroundColor: th.accent2, yAxisID: 'y' }];
  if (prob) {
    ds.push({ type: 'line', label: 'probabilidad %', data: prob, borderColor: th.accent,
              borderWidth: 1.4, pointRadius: 0, borderDash: [4, 3], yAxisID: 'y1', tension: 0.3 });
  }
  destroyChart(canvasId);
  charts[canvasId] = new Chart($(`#${canvasId}`), {
    data: { labels, datasets: ds },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { labels: { boxWidth: 14, boxHeight: 2 } } },
      scales: {
        x: { grid: { color: th.grid }, ticks: { maxTicksLimit: 9, maxRotation: 0 } },
        y: { grid: { color: th.grid }, beginAtZero: true, title: { display: true, text: 'mm/h' } },
        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false },
              ticks: { callback: (v) => `${v}%` } },
      },
    },
  });
}

// ── Calibración: corrección de sesgo local validada (bias.json) ──

function leadBucketH(h) {
  if (h <= 0) return null;
  if (h <= 24) return '24';
  if (h <= 48) return '48';
  if (h <= 72) return '72';
  if (h <= 96) return '96';
  return null;
}

function updateBiasStation() {
  biasStation = null;
  if (!biasData || !biasData.estaciones) return;
  let best = null;
  for (const [id, e] of Object.entries(biasData.estaciones)) {
    const d = haversineKm(place.lat, place.lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { id, ...e, dist: d };
  }
  if (best && best.dist <= 35) biasStation = best;   // solo si la estación es local
}

// [b_eff, mae] de temperatura para un modelo a cierto lead, o null.
function biasInfo(modelId, leadH) {
  if (!biasStation) return null;
  const bk = leadBucketH(leadH);
  if (!bk) return null;
  return biasData?.bias?.[biasStation.id]?.[modelId]?.['temperature_2m']?.[bk] || null;
}
function biasFor(modelId, leadH) { const x = biasInfo(modelId, leadH); return x ? x[0] : 0; }

// Blend de los DOS mejores modelos por celda (verificado en holdout: bate al
// blend de los 5 y a cualquier modelo individual). Cada modelo se corrige por
// su sesgo y se pondera por 1/mae²; se promedian solo los 2 de menor error.
function blendTemp(h, start, window, times) {
  if (!biasStation) return null;
  const t0 = new Date(times[0]).getTime();
  const out = [];
  for (let j = 0; j < window; j++) {
    const leadH = Math.round((new Date(times[j]).getTime() - t0) / 3600000);
    const cand = [];
    for (const m of MODELS) {
      const arr = h[`temperature_2m_${m.id}`];
      const v = arr ? arr[start + j] : null;
      if (v == null) continue;
      const info = biasInfo(m.id, leadH);
      if (!info || info[1] == null) continue;          // sin mae no participa
      cand.push({ vc: v - info[0], mae: info[1] });
    }
    cand.sort((a, b) => a.mae - b.mae);
    const top = cand.slice(0, 2);                        // los 2 mejores
    let num = 0, den = 0;
    for (const c of top) { const w = 1 / (c.mae * c.mae + 0.25); num += w * c.vc; den += w; }
    out.push(den > 0 ? Math.round((num / den) * 10) / 10 : null);
  }
  return out.some((v) => v != null) ? out : null;
}

// Corrige una serie de temperatura de un modelo restando el bias por lead.
// times[0] ≈ ahora; el lead de cada punto es su distancia horaria a times[0].
function corregirTemp(modelId, arr, times) {
  if (!biasStation || !arr.length) return arr;
  const t0 = new Date(times[0]).getTime();
  return arr.map((v, j) => {
    if (v == null) return v;
    const leadH = Math.round((new Date(times[j]).getTime() - t0) / 3600000);
    const b = biasFor(modelId, leadH);
    return b ? Math.round((v - b) * 10) / 10 : v;
  });
}

function renderCharts(best, multi, ens) {
  const h = multi.hourly;
  const nowIso = best.current.time.slice(0, 13);
  let start = h.time.findIndex((t) => t.slice(0, 13) === nowIso);
  if (start < 0) start = 0;
  const window = Math.min(48, h.time.length - start);
  const times = h.time.slice(start, start + window);
  const labels = times.map((t) => {
    const hour = t.slice(11, 13);
    return hour === '00' ? `${weekday(t.slice(0, 10))} ${hour}h` : `${hour}h`;
  });

  buildTempChart('chart-temp', labels, {
    ensS: ensembleSeries(ens, times),
    modelSeries: MODELS.map((m, i) => {
      const arr = h[`temperature_2m_${m.id}`];
      if (!arr) return null;
      const raw = arr.slice(start, start + window);
      return { name: m.name, data: corregirTemp(m.id, raw, times), colorIdx: i };
    }).filter(Boolean),
    bestSeries: blendTemp(h, start, window, times),   // pronóstico Vigía (blend calibrado)
    bestLabel: 'Vigía',
  });
  // indicador de calibración en el panel
  const meta = document.querySelector('#ens-title')?.closest('.panel-head')?.querySelector('.panel-meta');
  if (meta) {
    const base = 'banda 10–90 % · ensamble ECMWF (51 miembros) + 6 modelos';
    meta.textContent = biasStation ? `${base} · ✓ calibrado` : base;
    meta.title = biasStation
      ? `Modelos corregidos por sesgo local validado (estación ${biasStation.nombre}, holdout skill +0.21)`
      : '';
  }

  const hb = best.hourly;
  let bStart = hb.time.findIndex((t) => t.slice(0, 13) === nowIso);
  if (bStart < 0) bStart = 0;
  buildPrecipChart('chart-precip', labels,
    hb.precipitation.slice(bStart, bStart + window),
    hb.precipitation_probability ? hb.precipitation_probability.slice(bStart, bStart + window) : null);
}

// ── Franja diaria + detalle por día ────────────────────────────

function renderDaily(best) {
  const d = best.daily;
  const ol = $('#daily');
  ol.innerHTML = '';
  d.time.forEach((iso, i) => {
    const [desc, icon] = wmo(d.weather_code[i]);
    const li = document.createElement('li');
    li.className = 'day';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'day-btn';
    btn.title = `${desc} — toca para el detalle hora a hora`;
    const name = i === 0 ? 'hoy' : i === 1 ? 'mañana' : weekday(iso);
    const pp = d.precipitation_sum[i];
    const prob = d.precipitation_probability_max[i];
    btn.innerHTML = `
      <span class="day-name">${name}</span>
      <span class="day-icon" aria-hidden="true">${icon}</span>
      <span class="day-max">${Math.round(d.temperature_2m_max[i])}°</span>
      <span class="day-min">${Math.round(d.temperature_2m_min[i])}°</span>
      <span class="day-pp">${pp >= 0.1 ? `${r1(pp)} mm · ` : ''}${prob != null ? prob + ' %' : ''}</span>`;
    btn.addEventListener('click', () => openDay(i));
    li.appendChild(btn);
    ol.appendChild(li);
  });
}

function openDay(i) {
  if (!lastData) return;
  const { best, multi, ens } = lastData;
  const d = best.daily;
  const iso = d.time[i];
  const [desc, icon] = wmo(d.weather_code[i]);

  const fecha = `${weekday(iso, true)} ${Number(iso.slice(8, 10))}`;
  $('#day-dialog-title').textContent =
    `${icon} ${i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : fecha} · ${place.name}`;
  $('#day-dialog-sub').textContent =
    `${desc} · máxima ${Math.round(d.temperature_2m_max[i])}° · mínima ${Math.round(d.temperature_2m_min[i])}°`;

  // estadísticas del día (desde best_match)
  const hb = best.hourly;
  const idxDay = hb.time.map((t, j) => [t, j]).filter(([t]) => t.slice(0, 10) === iso).map(([, j]) => j);
  const windMax = Math.max(...idxDay.map((j) => hb.wind_speed_10m[j] ?? 0));
  const rhMean = idxDay.length
    ? Math.round(idxDay.reduce((a, j) => a + (hb.relative_humidity_2m[j] ?? 0), 0) / idxDay.length) : null;
  const stats = [
    ['☀️ UV máx', d.uv_index_max?.[i] != null ? r1(d.uv_index_max[i]) : '—'],
    ['🌅 Sale el sol', d.sunrise?.[i] ? d.sunrise[i].slice(11, 16) : '—'],
    ['🌇 Se pone', d.sunset?.[i] ? d.sunset[i].slice(11, 16) : '—'],
    ['💨 Viento máx', `${Math.round(windMax)} km/h · Bf ${beaufort(windMax).grado} (${beaufort(windMax).nombre})`],
    ['💧 Humedad prom.', rhMean != null ? `${rhMean} %` : '—'],
    ['🌧️ Lluvia total', `${r1(d.precipitation_sum[i]) ?? 0} mm`],
  ];
  const ul = $('#day-stats');
  ul.innerHTML = '';
  stats.forEach(([k, v]) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>${k}</span><strong>${v}</strong>`;
    ul.appendChild(li);
  });

  const labels = idxDay.map((j) => hb.time[j].slice(11, 13) + 'h');

  // multi-modelo y ensamble cubren 3 días; más allá, solo síntesis
  const hm = multi.hourly;
  const idxMulti = hm.time.map((t, j) => [t, j]).filter(([t]) => t.slice(0, 10) === iso).map(([, j]) => j);
  const timesDay = idxMulti.map((j) => hm.time[j]);
  const modelSeries = idxMulti.length ? MODELS.map((m, k) => {
    const arr = hm[`temperature_2m_${m.id}`];
    return arr ? { name: m.name, data: idxMulti.map((j) => arr[j]), colorIdx: k } : null;
  }).filter(Boolean) : [];

  buildTempChart('chart-day-temp', labels, {
    ensS: timesDay.length ? ensembleSeries(ens, timesDay) : null,
    modelSeries,
    bestSeries: idxDay.map((j) => hb.temperature_2m[j]),
  });
  buildPrecipChart('chart-day-precip', labels,
    idxDay.map((j) => hb.precipitation[j]),
    hb.precipitation_probability ? idxDay.map((j) => hb.precipitation_probability[j]) : null);

  $('#day-dialog-note').textContent = idxMulti.length
    ? 'Líneas de colores: los 6 modelos. Línea gruesa: síntesis best-match. Si se separan, la atmósfera está difícil de pronosticar.'
    : 'Para días más allá de 72 h mostramos solo la síntesis: la dispersión entre modelos crece y el detalle hora a hora pierde precisión — es el límite físico del caos atmosférico, no un defecto.';

  $('#day-dialog').showModal();
}

// ── Tabla de modelos ───────────────────────────────────────────

function renderModelTable(multi) {
  const h = multi.hourly;
  // mañana = segundo día presente en la serie
  const day0 = h.time[0].slice(0, 10);
  const dayTomorrow = h.time.find((t) => t.slice(0, 10) !== day0)?.slice(0, 10);
  if (!dayTomorrow) return;

  const idx = h.time.map((t, i) => [t, i]).filter(([t]) => t.slice(0, 10) === dayTomorrow).map(([, i]) => i);
  const tbody = $('#model-table tbody');
  const tfoot = $('#model-table tfoot');
  tbody.innerHTML = '';
  tfoot.innerHTML = '';

  // 'ahora' real para calcular el lead de cada hora de mañana (corrección de sesgo)
  const t0 = lastData?.best?.current?.time
    ? new Date(lastData.best.current.time).getTime() : new Date(h.time[0]).getTime();
  const colors = modelColors();
  const rows = [];
  MODELS.forEach((m, i) => {
    const temps = h[`temperature_2m_${m.id}`];
    const precs = h[`precipitation_${m.id}`];
    if (!temps) return;
    const dayT = idx.map((j) => {
      const v = temps[j];
      if (v == null) return null;
      const leadH = Math.round((new Date(h.time[j]).getTime() - t0) / 3600000);
      const b = biasFor(m.id, leadH);
      return b ? v - b : v;
    }).filter((v) => v != null);
    const dayP = idx.map((j) => (precs ? precs[j] : null)).filter((v) => v != null);
    if (!dayT.length) return;
    const row = {
      name: m.name, org: m.org, color: colors[i],
      max: Math.max(...dayT), min: Math.min(...dayT),
      pp: dayP.length ? dayP.reduce((a, b) => a + b, 0) : null,
    };
    rows.push(row);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="m-name">${row.name}</td>
      <td class="m-org">${row.org}</td>
      <td>${r1(row.max)} °C</td>
      <td>${r1(row.min)} °C</td>
      <td>${row.pp == null ? '—' : r1(row.pp) + ' mm'}</td>`;
    tr.firstElementChild.style.borderLeft = `3px solid ${row.color}`;
    tbody.appendChild(tr);
  });

  if (rows.length > 1) {
    const spread = (sel) => r1(Math.max(...rows.map(sel)) - Math.min(...rows.map(sel)));
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td colspan="2">Dispersión entre modelos</td>
      <td>Δ ${spread((r) => r.max)} °C</td>
      <td>Δ ${spread((r) => r.min)} °C</td>
      <td>Δ ${spread((r) => r.pp ?? 0)} mm</td>`;
    tfoot.appendChild(tr);
  }
}

// ── Verificación: ¿cuánto acierta cada modelo? ─────────────────

async function loadVerif() {
  try {
    const res = await fetch('verificacion.json', { cache: 'no-store' });
    if (!res.ok) return;
    verifData = await res.json();
    renderVerif();
    renderVerifAvisos();
  } catch (_) { /* sin archivo aún */ }
}

function renderVerif() {
  const list = $('#verif-list');
  const caveat = $('#verif-caveat');
  if (!verifData || !list) return;
  list.innerHTML = '';

  // Persistencia: pseudo-modelo de referencia (ver info del panel). Puede
  // faltar en el JSON (transición) o no tener datos aún para este plazo —
  // en ambos casos el skill simplemente no se muestra, sin errores.
  const pers = verifData.models?.persistencia?.['temperature_2m']?.[verifBucket];
  const maePers = pers && pers.n > 0 ? pers.mae : null;

  const entries = MODELS.map((m, i) => {
    const b = verifData.models?.[m.id]?.['temperature_2m']?.[verifBucket];
    return b ? { ...m, ...b, colorIdx: i } : { ...m, mae: null, colorIdx: i };
  });
  const withData = entries.filter((e) => e.mae != null).sort((a, b) => a.mae - b.mae);
  const totalN = withData.reduce((a, e) => a + e.n, 0);

  marcarTabsVerif();

  if (!withData.length) {
    caveat.hidden = false;
    const dias = Math.round(Number(verifBucket) / 24);
    caveat.textContent = `Todavía no se puede medir el acierto a ${dias} día${dias > 1 ? 's' : ''}: ` +
      `un pronóstico a ${verifBucket} h solo se compara con lo observado ${verifBucket} h después. ` +
      `El archivo empezó el 9 de junio de 2026, así que este plazo se habilita ${fechaDisponible(verifBucket)}.`;
    return;
  }

  caveat.hidden = totalN >= 500;
  if (totalN < 500) {
    caveat.textContent = `⚠ Cifras preliminares: recién ${totalN} pares evaluados (el archivo partió el 9 de junio de 2026). Con ~2 semanas de datos los números se estabilizan; mientras tanto, tómalos como tendencia.`;
  }

  const colors = modelColors();
  const maxMae = Math.max(...withData.map((e) => e.mae), maePers ?? 0, 0.1);
  withData.forEach((e, rank) => {
    const li = document.createElement('li');
    li.className = 'verif-row';
    const biasTxt = Math.abs(e.bias) < 0.15 ? 'sin sesgo claro'
      : e.bias > 0 ? `tiende +${r1(e.bias)}° cálido` : `tiende ${r1(e.bias)}° frío`;
    const skill = maePers ? Math.round((1 - e.mae / maePers) * 100) : null;
    const skillTxt = skill == null ? '' : ` <span class="verif-skill ${skill >= 0 ? 'is-pos' : 'is-neg'}" ` +
      `title="Skill sobre la persistencia (repetir la observación de hace ${verifBucket} h): ` +
      `${skill >= 0 ? 'le gana por' : 'pierde por'} ${Math.abs(skill)}%.">${skill > 0 ? '+' : ''}${skill}%</span>`;
    li.innerHTML = `
      <span class="verif-rank">${rank === 0 ? '★' : rank + 1}</span>
      <span class="verif-name">${e.name}<small>${e.org}</small></span>
      <span class="verif-bar-wrap"><span class="verif-bar"></span></span>
      <span class="verif-mae">${e.mae.toFixed(2)} °C${skillTxt}</span>
      <span class="verif-bias">${biasTxt} · n=${e.n}</span>`;
    const bar = li.querySelector('.verif-bar');
    bar.style.width = `${Math.max(6, (e.mae / maxMae) * 100)}%`;
    bar.style.backgroundColor = colors[e.colorIdx];
    list.appendChild(li);
  });

  if (maePers != null) {
    const li = document.createElement('li');
    li.className = 'verif-row verif-row--ref';
    li.innerHTML = `
      <span class="verif-rank">≈</span>
      <span class="verif-name">Persistencia<small>referencia, no un modelo</small></span>
      <span class="verif-bar-wrap"><span class="verif-bar"></span></span>
      <span class="verif-mae">${maePers.toFixed(2)} °C</span>
      <span class="verif-bias">línea base: el clima de hace ${verifBucket} h · n=${pers.n}</span>`;
    const bar = li.querySelector('.verif-bar');
    bar.style.width = `${Math.max(6, (maePers / maxMae) * 100)}%`;
    list.appendChild(li);
  }
}

// Avisos propios de Vigía: ¿aciertan? — POD (detección), FAR (falsas
// alarmas) y CSI por tipo, calculados en ingesta/verify_avisos.py contra
// observaciones reales. Reutiliza AVISO_EMOJI/AVISO_TIPO_LABEL (más abajo en
// este archivo, ya usados por la capa de avisos del mapa) para no duplicar
// etiquetas. Si la sección 'avisos' no viene en el JSON o no tiene ningún
// tipo con muestra (n=0 en todos), la subsección queda oculta sin error.
function renderVerifAvisos() {
  const wrap = $('#verif-avisos');
  const tbody = $('#verif-avisos-body');
  const meta = $('#verif-avisos-meta');
  if (!wrap || !tbody || !meta) return;

  const avisos = verifData && verifData.avisos;
  const tipos = avisos && avisos.tipos
    ? Object.entries(avisos.tipos).filter(([, r]) => r.n > 0)
    : [];
  if (!tipos.length) { wrap.hidden = true; return; }

  tipos.sort((a, b) => b[1].n - a[1].n);
  tbody.innerHTML = '';
  tipos.forEach(([tipo, r]) => {
    const tr = document.createElement('tr');
    if (r.muestra_insuficiente) {
      tr.className = 'muestra-insuficiente';
      tr.title = 'Muestra chica (n < 10): la cifra puede cambiar mucho con el próximo aviso.';
    }
    const pod = r.pod != null ? `${Math.round(r.pod * 100)}%` : '—';
    const far = r.far != null ? `${Math.round(r.far * 100)}%` : '—';
    const csi = r.csi != null ? r.csi.toFixed(2) : '—';
    tr.innerHTML = `
      <td>${AVISO_EMOJI[tipo] || ''} ${AVISO_TIPO_LABEL[tipo] || tipo}</td>
      <td>${pod}</td>
      <td>${far}</td>
      <td>${csi}</td>
      <td>${r.hits}/${r.falsas}/${r.misses}</td>`;
    tbody.appendChild(tr);
  });

  meta.textContent = metaConFecha(`ventana móvil ${avisos.ventana_dias} días`, verifData.updated);
  wrap.hidden = false;
}

const ARCHIVE_START = new Date('2026-06-09T22:00:00Z');
const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

function fechaDisponible(bucketHoras) {
  const d = new Date(ARCHIVE_START.getTime() + Number(bucketHoras) * 3600 * 1000);
  return `alrededor del ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}`;
}

function marcarTabsVerif() {
  document.querySelectorAll('.verif-tab').forEach((btn) => {
    const hayDatos = verifData && Object.values(verifData.models || {})
      .some((m) => m['temperature_2m'] && m['temperature_2m'][btn.dataset.bucket]);
    btn.classList.toggle('sin-datos', !hayDatos);
    btn.title = hayDatos ? '' : `Se habilita ${fechaDisponible(btn.dataset.bucket)}`;
  });
}

function setupVerifTabs() {
  document.querySelectorAll('.verif-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      verifBucket = btn.dataset.bucket;
      document.querySelectorAll('.verif-tab').forEach((b) =>
        b.setAttribute('aria-selected', String(b === btn)));
      renderVerif();
    });
  });
}

// ── Mapa de observaciones en vivo ──────────────────────────────

const TILES = {
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
};
const TILES_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" rel="noopener">CARTO</a>';
// Solo el rotulado (nombres de ciudades) de CARTO, sin el resto del mapa base:
// se usa por encima del satélite, que de otro modo tapa las etiquetas horneadas.
// Siempre la variante 'light_only_labels' (texto blanco en negrita con halo
// oscuro): es la que se lee bien sobre cualquier textura satelital, sin
// importar el tema claro/oscuro de la UI (ver getOrCreateSateliteLabelsLayer).
const TILES_LABELS_URL = 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png';

// Estilo del mapa base "Satelital" (imagen aérea, no confundir con la capa
// 🛰️ 'satelite' de GOES-East más abajo, que es la nube meteorológica animada).
// Esri World Imagery no distingue claro/oscuro: una sola textura para ambos temas.
const TILES_ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const TILES_ESRI_ATTR = 'Esri, Maxar, Earthstar Geographics';

// Capa satelital: NASA GIBS, GOES-East ABI GeoColor (WMTS RESTful, sin API key).
// Ojo con el orden del path: es {z}/{y}/{x} (TileMatrix/TileRow/TileCol), no
// el {z}/{x}/{y} habitual de Leaflet — el template solo cambia DÓNDE va cada
// token, Leaflet igual sustituye {x}/{y} por columna/fila respectivamente.
const SATELITE_TILE_TMPL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/GOES-East_ABI_GeoColor/default/{time}/GoogleMapsCompatible_Level7/{z}/{y}/{x}.png';
const SATELITE_DOMAINS_URL = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/GOES-East_ABI_GeoColor/default/GoogleMapsCompatible_Level7/all/all.xml';
const SATELITE_ATTR = 'NASA GIBS · NOAA GOES-East';
const SATELITE_MAX_FRAMES = 6;
const SATELITE_PLAY_MS = 800;
const sateliteTileUrl = (t) => SATELITE_TILE_TMPL.replace('{time}', t);

async function loadMapa() {
  try {
    const res = await fetch('estaciones.json', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    estacionesData = await res.json();
  } catch (_) {
    $('#map').closest('.panel').hidden = true;
    return;
  }
  renderMapa();
  if (lastData) renderNow(lastData.best);   // re-pintar el "ahora" con fenómeno observado
}

async function loadSismos() {
  try {
    const res = await fetch('sismos.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sismosData = await res.json();
    marcarOk('sismos');
  } catch (_) {
    marcarFallo('sismos'); /* sin catálogo sísmico: la capa queda vacía */
  }
  if (capasActivas.has('sismos')) renderMapa();
  renderRiesgos();
}

async function loadIncendios() {
  try {
    const res = await fetch('incendios.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    incendiosData = await res.json();
    marcarOk('incendios');
  } catch (_) {
    marcarFallo('incendios'); /* sin foco de calor: la capa queda vacía */
  }
  if (capasActivas.has('incendios')) renderMapa();
  renderRiesgos();
}

async function loadAlertas() {
  try {
    const res = await fetch('alertas.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    alertasData = await res.json();
    marcarOk('alertas');
  } catch (_) {
    marcarFallo('alertas'); /* sin alertas: la capa queda vacía */
  }
  if (capasActivas.has('alertas')) renderMapa();
  renderRiesgos();
}

async function loadVolcanes() {
  try {
    const res = await fetch('volcanes.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    volcanesData = await res.json();
    marcarOk('volcanes');
  } catch (_) {
    marcarFallo('volcanes'); /* sin RNVV: la capa queda vacía */
  }
  if (capasActivas.has('volcanes')) renderMapa();
  renderRiesgos();
}

async function loadAvisos() {
  try {
    const res = await fetch('avisos.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    avisosData = await res.json();
    marcarOk('avisos');
  } catch (_) {
    marcarFallo('avisos'); /* sin avisos: la capa queda vacía */
  }
  if (capasActivas.has('avisos')) renderMapa();
  renderRiesgos();
}

async function loadCortes() {
  try {
    const res = await fetch('cortes.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cortesData = await res.json();
    marcarOk('cortes');
  } catch (_) {
    marcarFallo('cortes'); /* sin cortes: la capa queda vacía */
  }
  if (capasActivas.has('cortes')) renderMapa();
  renderRiesgos();
}

async function loadEsval() {
  try {
    const res = await fetch('esval.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    esvalData = await res.json();
    marcarOk('esval');
  } catch (_) {
    marcarFallo('esval'); /* sin esval: la capa queda vacía */
  }
  if (capasActivas.has('esval')) renderMapa();
}

async function loadMarea() {
  try {
    const res = await fetch('marea.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mareaData = await res.json();
    marcarOk('marea');
  } catch (_) {
    marcarFallo('marea'); /* sin marea: la capa y la tarjeta Costa quedan sin datos */
  }
  if (capasActivas.has('marea')) renderMapa();
  renderCosta();
}

async function loadTsunami() {
  try {
    const res = await fetch('tsunami.json', { cache: 'no-store' });
    if (!res.ok) return;
    tsunamiData = await res.json();
    renderTsunamiBanner();
    renderCosta();
  } catch (_) { /* sin tsunami.json: el banner queda oculto */ }
}

// farmacias.json (MINSAL/Farmanet, vía satélite fuera del VPS) es una fuente
// propia con loader propio: capa 'farmacias' la enciende sola, y loadEmergencia
// la reutiliza (mismo farmaciasPromise) para fusionarla como categoría
// 'farmacia' dentro de emergenciaData.categorias — un solo fetch, cualquiera
// sea el orden en que el usuario encienda las dos capas.
async function loadFarmacias() {
  if (farmaciasData) return farmaciasData;
  if (farmaciasPromise) return farmaciasPromise;
  farmaciasPromise = fetch('farmacias.json', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((farm) => {
      if (farm) marcarOk('farmacias'); else marcarFallo('farmacias');
      const lista = (farm && Array.isArray(farm.farmacias))
        ? farm.farmacias
          .filter((f) => typeof f.lat === 'number' && typeof f.lon === 'number')
          .map((f) => ({
            n: f.nombre,
            d: [f.direccion, f.comuna].filter(Boolean).join(', '),
            h: (f.abre && f.cierra) ? `${f.abre} – ${f.cierra}` : null,
            lat: f.lat,
            lon: f.lon,
          }))
        : [];
      // Las farmacias de turno rotan a diario: si el satélite lleva >26 h sin
      // refrescar (farm.stale), las que muestra el mapa ya no están de turno.
      // Mismo aviso que cortesData.stale (paintCortes) para no mostrar datos
      // vencidos como si fueran vigentes.
      farmaciasData = {
        lista,
        stale: !!(farm && farm.stale),
        updated: farm ? farm.updated : null,
        fecha: diaMes(farm && farm.updated),
      };
      farmaciasPromise = null;
      if (capasActivas.has('farmacias')) renderMapa();
      return farmaciasData;
    });
  return farmaciasPromise;
}

// emergencia.json es cuasi-estático (~9.000 puntos, se refresca 1x/semana):
// un solo fetch por sesión, disparado por toggleCapa al encender la capa
// emergencia O la capa evacuacion (ambas comparten este loader), no en la
// carga inicial ni en el refresco periódico de 10 min. tsunami_vias.json y
// tsunami_areas.json (capa evacuacion) se cargan junto en el mismo
// Promise.all: distinta capa, mismo gatillo. farmacias.json NO es
// infraestructura SENAPRED — es una fuente propia (loadFarmacias) que se
// fusiona como categoría 'farmacia' dentro de emergenciaData.categorias
// porque es infraestructura de emergencia, no porque comparta origen.
async function loadEmergencia() {
  if (emergenciaData) return;
  if (emergenciaPromise) { await emergenciaPromise; return; }
  emergenciaPromise = Promise.all([
    fetch('emergencia.json', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('tsunami_vias.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('tsunami_areas.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    loadFarmacias(),
  ]);
  const [emg, vias, areas, farm] = await emergenciaPromise;
  if (emg) { emergenciaData = emg; marcarOk('emergencia'); } else marcarFallo('emergencia');
  if (farm && farm.lista.length) {
    if (!emergenciaData) emergenciaData = { categorias: {} };
    if (!emergenciaData.categorias) emergenciaData.categorias = {};
    emergenciaData.categorias.farmacia = farm.lista;
    emergenciaData.farmaciaStale = farm.stale;
    emergenciaData.farmaciaFecha = farm.fecha;
  }
  tsunamiViasData = vias;
  tsunamiAreasData = areas;
  if (vias || areas) marcarOk('evacuacion'); else marcarFallo('evacuacion');
  emergenciaPromise = null;
  const activa = capasActivas.has('emergencia') || capasActivas.has('evacuacion');
  // Los 3 fetch fallaron (sin red y sin DATA_CACHE previa, ver warmupEvacuacion
  // más arriba): la capa quedaría vacía en silencio. Avisar en vez de mostrar
  // un mapa mudo (regla de honestidad de frescura del proyecto).
  if (activa && !emg && !vias && !areas && !navigator.onLine) {
    mostrarOffline(true, 'Sin conexión: no se pudieron cargar las rutas de evacuación. Prepara tu zona (📦) cuando tengas señal.');
  }
  if (activa) renderMapa();
}

// remociones.json es el catastro histórico de remociones en masa (~1.218
// puntos, cuasi-estático, se refresca 1x/semana): loader propio, no
// comparte disparador con loadEmergencia (es una fuente distinta, sin
// relación con la infraestructura de emergencia).
let remocionesCargando = false;
async function loadRemociones() {
  if (remocionesData || remocionesCargando) return;
  remocionesCargando = true;
  try {
    const res = await fetch('remociones.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    remocionesData = await res.json();
    marcarOk('remociones');
  } catch (_) {
    marcarFallo('remociones'); /* sin catastro: la capa queda vacía */
  }
  remocionesCargando = false;
  if (capasActivas.has('remociones')) renderMapa();
}

// crecidas.json es el pronóstico de crecidas GloFAS/Copernicus (~29 puntos,
// se refresca junto a la ingesta principal): loader propio, con el mismo
// guard lazy que loadRemociones, pero además llama renderRiesgos() (como
// loadAvisos/loadCortes) porque alimenta el tile del centro de riesgos.
let crecidasCargando = false;
async function loadCrecidas() {
  if (crecidasData || crecidasCargando) return;
  crecidasCargando = true;
  try {
    const res = await fetch('crecidas.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    crecidasData = await res.json();
    marcarOk('crecidas');
  } catch (_) {
    marcarFallo('crecidas'); /* sin pronóstico: la capa queda vacía */
  }
  crecidasCargando = false;
  if (capasActivas.has('crecidas')) renderMapa();
  renderRiesgos();
}

// combustible.json: precios de bencina en línea (CNE), cuasi-estático (se
// refresca 2x/día): loader propio, mismo patrón que loadRemociones. Sin
// CNE_API_KEY registrada la capa queda dormida (combustible.json con n=0 o
// directamente ausente) — paintCombustible lo muestra como "en preparación".
let combustibleCargando = false;
async function loadCombustible() {
  if (combustibleData || combustibleCargando) return;
  combustibleCargando = true;
  try {
    const res = await fetch('combustible.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    combustibleData = await res.json();
    marcarOk('combustible');
  } catch (_) {
    marcarFallo('combustible'); /* sin combustible: la capa queda vacía */
  }
  combustibleCargando = false;
  if (capasActivas.has('combustible')) renderMapa();
}

// Satélite GOES-East: DescribeDomains devuelve el historial completo de
// disponibilidad (~5 años) como UN solo <Domain>rango1,rango2,...</Domain>,
// cada rango "inicio/fin/PT10M" (huecos entre rangos, y rangos de un solo
// instante cuando inicio == fin). Se recorren los rangos desde el final
// (los más recientes) expandiendo cada uno en pasos de 10 min hasta juntar
// SATELITE_MAX_FRAMES timestamps. Si el fetch o el parseo fallan, cae a un
// solo frame con TIME=default (la imagen más reciente) sin romper la capa.
async function loadSatelite() {
  let frames;
  try {
    const res = await fetch(SATELITE_DOMAINS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const dominio = xml.match(/<Domain>([^<]+)<\/Domain>/);
    if (!dominio) throw new Error('sin dominio de tiempo GIBS');
    const rangos = dominio[1].split(',');
    frames = [];
    for (let i = rangos.length - 1; i >= 0 && frames.length < SATELITE_MAX_FRAMES; i--) {
      const [inicio, fin] = rangos[i].split('/');
      for (let t = new Date(fin); t >= new Date(inicio) && frames.length < SATELITE_MAX_FRAMES; t = new Date(t - 10 * 60000)) {
        frames.unshift(t.toISOString().replace(/\.\d{3}Z$/, 'Z'));
      }
    }
    if (!frames.length) throw new Error('rango de tiempo vacío');
  } catch (_) {
    frames = ['default'];
  }
  sateliteFrames = frames;
  sateliteFrameIdx = frames.length - 1;
  // Descarta del mapa y de la caché los frames que salieron de la ventana
  // vigente: si no, cada refresco de 10 min deja un tileLayer invisible más
  // acumulado indefinidamente mientras la capa siga activa.
  sateliteLayers.forEach((layer, t) => {
    if (!frames.includes(t)) {
      if (map && map.hasLayer(layer)) map.removeLayer(layer);
      sateliteLayers.delete(t);
    }
  });
  if (capasActivas.has('satelite')) renderMapa();
}

function getOrCreateSateliteLayer(t) {
  let layer = sateliteLayers.get(t);
  if (!layer) {
    layer = L.tileLayer(sateliteTileUrl(t), {
      maxNativeZoom: 7, maxZoom: 18, opacity: 0, zIndex: 5, attribution: SATELITE_ATTR,
    });
    sateliteLayers.set(t, layer);
  }
  if (!map.hasLayer(layer)) layer.addTo(map);
  return layer;
}

// Rotulado sobre imagen satelital (Esri o GOES): SIEMPRE la variante 'light'
// de TILES_LABELS, sin importar el tema claro/oscuro de la UI. Se probó con
// screenshot (no se asumió por el nombre): 'light_only_labels' es texto
// blanco en negrita con halo oscuro y se lee bien sobre cualquier textura;
// 'dark_only_labels' es un texto celeste delgado y de bajo contraste — con
// tema de UI oscuro, atarlo a isDark() daba justo la variante que peor se
// lee (bug real, no solo estético).
function getOrCreateSateliteLabelsLayer() {
  if (!sateliteLabelsLayer) {
    sateliteLabelsLayer = L.tileLayer(TILES_LABELS_URL, { maxZoom: 18, zIndex: 6, subdomains: 'abcd' });
  }
  if (!map.hasLayer(sateliteLabelsLayer)) sateliteLabelsLayer.addTo(map);
  return sateliteLabelsLayer;
}

function actualizarBotonPlaySatelite() {
  const btn = document.getElementById('satelite-play');
  if (!btn) return;
  const activo = !!sateliteTimer;
  btn.disabled = sateliteFrames.length < 2;
  btn.textContent = activo ? '⏸ Pausar' : '▶ Animar';
  btn.setAttribute('aria-pressed', String(activo));
}

function actualizarEtiquetaSatelite() {
  const label = document.getElementById('satelite-hora');
  if (!label) return;
  const t = sateliteFrames[sateliteFrameIdx];
  label.textContent = !t || t === 'default' ? 'imagen más reciente' : horaLocal(t);
}

function mostrarFrameSatelite(idx) {
  sateliteFrameIdx = idx;
  const actual = getOrCreateSateliteLayer(sateliteFrames[idx]);
  sateliteLayers.forEach((layer) => layer.setOpacity(layer === actual ? 0.7 : 0));
  actualizarEtiquetaSatelite();
}

function detenerReproduccionSatelite() {
  if (sateliteTimer) { clearInterval(sateliteTimer); sateliteTimer = null; }
  actualizarBotonPlaySatelite();
}

function toggleReproduccionSatelite() {
  if (sateliteTimer) { detenerReproduccionSatelite(); return; }
  if (sateliteFrames.length < 2) return;
  sateliteTimer = setInterval(() => {
    mostrarFrameSatelite((sateliteFrameIdx + 1) % sateliteFrames.length);
  }, SATELITE_PLAY_MS);
  actualizarBotonPlaySatelite();
}

// Retira del mapa los tileLayers persistentes del satélite y detiene la
// reproducción; se llama al apagar la capa (renderMapa no lo hace solo
// porque estos tileLayers viven fuera de layerGroups['satelite']).
// `mantenerEtiquetas` (true cuando el mapa base está en modo Satelital) evita
// borrar el rotulado only_labels que ese modo también necesita, aunque la
// capa GOES esté apagada.
function limpiarSatelite(mantenerEtiquetas) {
  detenerReproduccionSatelite();
  sateliteLayers.forEach((layer) => { if (map.hasLayer(layer)) map.removeLayer(layer); });
  if (!mantenerEtiquetas && sateliteLabelsLayer && map.hasLayer(sateliteLabelsLayer)) map.removeLayer(sateliteLabelsLayer);
}

function paintSatelite() {
  if (!sateliteFrames.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = 'cargando imagen satelital…';
    return;
  }
  if (sateliteFrameIdx < 0 || sateliteFrameIdx >= sateliteFrames.length) sateliteFrameIdx = sateliteFrames.length - 1;
  mostrarFrameSatelite(sateliteFrameIdx);
  getOrCreateSateliteLabelsLayer();
  actualizarBotonPlaySatelite();
  $('#map-meta').textContent = 'Satélite GOES-East · retraso típico 20–60 min';
}

// Capas del mapa: 'temp' y 'aire' son excluyentes entre sí (misma medición,
// una a la vez); 'sismos', 'incendios', 'alertas', 'volcanes', 'remociones',
// 'evacuacion', 'emergencia' y 'viento' son independientes y se pueden
// combinar con cualquiera (incluida 'temp': 'viento' reusa la misma
// estaciones.json ya cargada, sin ser del grupo 'medicion'). 'evacuacion' y
// 'emergencia' son lazy: ~9.000 puntos + vías/áreas
// cuasi-estáticos que no se cargan salvo que el usuario encienda alguna de
// las dos (ni en la carga inicial ni en el refresco). 'remociones' es lazy
// por su propia cuenta: ~1.200 puntos igual de cuasi-estáticos, pero es un
// catastro propio sin relación con emergenciaData. 'combustible' es lazy
// igual que 'remociones': ~1.768 estaciones cuasi-estáticas (CNE, 2x/día),
// dormida (0 estaciones) hasta que se registre CNE_API_KEY.
const CAPAS = {
  temp:          { grupo: 'medicion', paint: paintTemp },
  aire:          { grupo: 'medicion', paint: paintAire },
  precipitacion: { grupo: 'medicion', paint: paintPrecip },
  sismos:        { paint: paintSismos },
  incendios:     { paint: paintIncendios },
  alertas:       { paint: paintAlertas, lazy: cargarComunas, tieneData: () => comunasData !== null },
  volcanes:      { paint: paintVolcanes },
  avisos:        { paint: paintAvisos },
  viento:        { paint: paintViento },
  remociones:    { paint: paintRemociones, lazy: loadRemociones, tieneData: () => remocionesData !== null },
  crecidas:      { paint: paintCrecidas, lazy: loadCrecidas, tieneData: () => crecidasData !== null },
  cortes:        { paint: paintCortes },
  esval:         { paint: paintEsval },
  combustible:   { paint: paintCombustible, lazy: loadCombustible, tieneData: () => combustibleData !== null },
  marea:         { paint: paintMarea },
  evacuacion:    { paint: paintEvacuacion, lazy: loadEmergencia, tieneData: () => tsunamiViasData !== null || tsunamiAreasData !== null },
  farmacias:     { paint: paintFarmacias, lazy: loadFarmacias, tieneData: () => farmaciasData !== null },
  emergencia:    { paint: paintEmergencia, lazy: loadEmergencia, tieneData: () => emergenciaData !== null },
  satelite:      { paint: paintSatelite, lazy: loadSatelite, tieneData: () => sateliteFrames.length > 0 },
};
// Orden de pintado (no el de declaración de CAPAS): la capa de medición se
// pinta al final para que su texto en #map-meta prevalezca sobre las demás.
// Los puntos de alerta van encima de los focos/eventos que resumen.
// 'remociones' va junto a las demás capas de peligro, antes de 'avisos'.
// 'farmacias', 'emergencia' y 'evacuacion' van al final de todo: en una
// emergencia real son lo que se busca, así que su texto y sus íconos deben
// quedar encima de cualquier otra capa. 'farmacias' va justo antes que
// 'emergencia' (misma familia, mismo ícono 💊 — el dedupe vive en
// paintEmergencia). 'evacuacion' cierra la lista porque sus vías son la
// acción más urgente (hacia dónde ir), por sobre el resto. 'satelite' va
// primero: es la capa menos accionable, su texto en #map-meta no debe pisar
// el de ninguna otra.
const ORDEN_PINTADO = ['satelite', 'volcanes', 'sismos', 'incendios', 'alertas', 'remociones', 'crecidas', 'cortes', 'esval', 'combustible', 'avisos', 'viento', 'temp', 'aire', 'precipitacion', 'marea', 'farmacias', 'emergencia', 'evacuacion'];

function capasGuardadas() {
  try {
    const raw = localStorage.getItem('sinoptica.capas');
    if (raw) {
      const arr = JSON.parse(raw).filter((k) => Object.keys(CAPAS).includes(k));
      if (arr.length) return new Set(arr);
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return new Set(['temp']);
}

// Estilo del mapa base (Calles/Satelital), independiente de capasActivas:
// no es una capa que se combine con otras, es el fondo mismo del mapa.
function basemapGuardado() {
  try {
    const raw = localStorage.getItem('sinoptica.basemap');
    if (raw === 'satelital' || raw === 'calles') return raw;
  } catch (_) { /* localStorage puede no estar disponible */ }
  // Default para usuarios nuevos (sin preferencia guardada): satelital.
  // Si ya hay algo en localStorage, se respeta arriba sin llegar aquí.
  return 'satelital';
}
let mapaBase = basemapGuardado();

function toggleBasemap() {
  mapaBase = mapaBase === 'calles' ? 'satelital' : 'calles';
  try { localStorage.setItem('sinoptica.basemap', mapaBase); } catch (_) { /* opcional */ }
  renderMapa();
}

let capasActivas = capasGuardadas();
// Las capas lazy restauradas desde localStorage también necesitan su carga:
// toggleCapa no corre al restaurar, y sin esto una capa lazy que quedó
// activa reaparece vacía tras recargar (bug real: satélite «no carga nada»).
capasActivas.forEach((k) => {
  const c = CAPAS[k];
  if (c.lazy && !(c.tieneData && c.tieneData())) c.lazy();
});
const layerGroups = {};

function toggleCapa(k) {
  if (capasActivas.has(k)) {
    capasActivas.delete(k);
  } else {
    if (CAPAS[k].grupo === 'medicion') {
      for (const otra of Object.keys(CAPAS)) {
        if (otra !== k && CAPAS[otra].grupo === 'medicion') capasActivas.delete(otra);
      }
    }
    capasActivas.add(k);
    // Mecanismo lazy genérico: si la capa recién encendida declara `lazy` y
    // todavía no tiene datos, dispara la carga (async, re-pinta sola al terminar).
    const capa = CAPAS[k];
    if (capa.lazy && !(capa.tieneData && capa.tieneData())) capa.lazy();
  }
  try { localStorage.setItem('sinoptica.capas', JSON.stringify([...capasActivas])); } catch (_) { /* opcional */ }
  renderMapa();
}

function ensureMap() {
  if (map || typeof L === 'undefined' || !estacionesData) return map;
  // Interacción completa: arrastrar, pinch-zoom y botones +/− en todos los
  // dispositivos (scrollWheelZoom off para no capturar el scroll de rueda).
  map = L.map('map', {
    scrollWheelZoom: false,
    zoomSnap: 0.5,
    zoomControl: true,
    tap: true,
  });
  // Con red nacional (Arica a la Antártica) un fitBounds a todas las
  // estaciones da un zoom país ilegible; se parte centrado en el lugar
  // elegido y el botón "Chile" ofrece la vista país bajo demanda.
  map.setView([place.lat, place.lon], 8);
  // Leaflet calcula mal los tiles si el contenedor aún estaba animándose al
  // crearse (queda fondo sin tiles); recalcular asegura que se llenen.
  setTimeout(() => map.invalidateSize(), 200);
  for (const k of Object.keys(CAPAS)) layerGroups[k] = L.layerGroup().addTo(map);
  // Al cambiar de zoom, el dedup/agrupado por celda de paintTemp/paintAire/
  // paintIncendios/paintCombustible depende del zoom actual: hay que
  // re-pintar la capa activa (combustible faltaba aquí: sus íconos se
  // quedaban agrupados para siempre aunque el usuario acercara el mapa).
  map.on('zoomend', () => {
    if (['temp', 'aire', 'precipitacion', 'incendios', 'remociones', 'combustible', 'emergencia', 'evacuacion'].some((k) => capasActivas.has(k))) renderMapa();
  });
  // Las vías de evacuación y las estaciones de combustible se filtran por el
  // viewport visible: al desplazar el mapa sin cambiar el zoom, también hay
  // que re-pintar para que aparezcan las que entraron al encuadre.
  map.on('moveend', () => {
    if (capasActivas.has('emergencia') || capasActivas.has('evacuacion') || capasActivas.has('combustible')) renderMapa();
  });
  return map;
}

function popupRows(pairs) {
  const dl = document.createElement('dl');
  pairs.forEach(([label, value]) => {
    if (value == null) return;
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value;
    dl.append(dt, dd);
  });
  return dl;
}

// Caja base de un popup de marcador: el <div class="stn-popup"> con su título
// en <strong>, que repetían idénticas casi todas las capas. El título es
// opcional porque las alertas sin comuna arman su encabezado aparte.
function cajaPopup(titulo) {
  const box = document.createElement('div');
  box.className = 'stn-popup';
  if (titulo != null) {
    const h = document.createElement('strong');
    h.textContent = titulo;
    box.appendChild(h);
  }
  return box;
}

// Factory común de los marcadores del mapa. Cada capa de puntos repetía el
// mismo bloque —divIcon con la clase que define su aspecto según el tema →
// L.marker centrado en el punto → bindPopup → addTo del layerGroup— y esa
// duplicación ya costó una familia de bugs: los marcadores que quedaban
// invisibles en modo oscuro hubo que arreglarlos capa por capa (PR #158).
// Centralizado, el próximo arreglo de esa familia se hace una sola vez.
// El ancla del ícono SIEMPRE fue su centro, así que se deriva de `tam` en vez
// de repetirla en cada capa (y de arriesgar que alguna la escriba mal).
// `popup` es opcional: las vistas agrupadas no lo usan porque cuelgan su
// propio handler de clic sobre el marcador que este factory devuelve.
function pintarMarcador(group, { lat, lon, clase, html = '', tam, titulo, popup, maxWidth = 260, maxHeight }) {
  const [ancho, alto] = tam;
  const icon = L.divIcon({
    className: clase,
    html,
    iconSize: [ancho, alto], iconAnchor: [ancho / 2, alto / 2],
  });
  const marker = L.marker([lat, lon], { icon, title: titulo }).addTo(group);
  if (popup) marker.bindPopup(popup, { maxWidth, maxHeight });
  return marker;
}

// true si el dispositivo abre Apple Maps nativo (iPhone/iPad/Mac). iPadOS
// se reporta como "MacIntel" en navigator.platform igual que un Mac de
// escritorio, pero da lo mismo: ambos tienen Apple Maps instalado.
function esApple() {
  const plat = navigator.platform || '';
  return /iPhone|iPad|iPod|Mac/.test(plat);
}

// Enlace "Cómo llegar" a la app de mapas del dispositivo: Apple Maps en
// iOS/iPadOS/macOS, Google Maps en el resto (Android abre la app si está
// instalada, PC abre el navegador).
function enlaceComoLlegar(lat, lon) {
  const a = document.createElement('a');
  a.href = esApple()
    ? `https://maps.apple.com/?daddr=${lat},${lon}`
    : `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = '🧭 Cómo llegar';
  return a;
}

function renderMapa() {
  if (!ensureMap()) return;
  if (tileLayer) map.removeLayer(tileLayer);
  tileLayer = mapaBase === 'satelital'
    ? L.tileLayer(TILES_ESRI, { attribution: TILES_ESRI_ATTR, maxZoom: 18 }).addTo(map)
    : L.tileLayer(TILES[isDark() ? 'dark' : 'light'], {
        attribution: TILES_ATTR, maxZoom: 18, subdomains: 'abcd',
      }).addTo(map);
  // Este tileLayer base se recrea en cada render (igual que layerGroups[k]
  // más abajo se vacía con clearLayers): por eso los tileLayers del satélite
  // NO viven en layerGroups['satelite'] sino en la variable de módulo
  // sateliteLayers, con zIndex 5 para quedar sobre este base recreado.

  for (const k of ORDEN_PINTADO) {
    layerGroups[k].clearLayers();
    if (capasActivas.has(k)) CAPAS[k].paint(layerGroups[k]);
  }

  const medicion = ['temp', 'aire', 'precipitacion'].find((k) => capasActivas.has(k));
  document.getElementById('map-legend-temp').hidden = medicion !== 'temp';
  document.getElementById('map-legend-aire').hidden = medicion !== 'aire';
  document.getElementById('map-legend-precipitacion').hidden = medicion !== 'precipitacion';
  document.getElementById('map-legend-sismos').hidden = !capasActivas.has('sismos');
  document.getElementById('map-legend-incendios').hidden = !capasActivas.has('incendios');
  document.getElementById('map-legend-alertas').hidden = !capasActivas.has('alertas');
  document.getElementById('map-legend-volcanes').hidden = !capasActivas.has('volcanes');
  document.getElementById('map-legend-avisos').hidden = !capasActivas.has('avisos');
  document.getElementById('map-legend-viento').hidden = !capasActivas.has('viento');
  document.getElementById('map-legend-remociones').hidden = !capasActivas.has('remociones');
  document.getElementById('map-legend-crecidas').hidden = !capasActivas.has('crecidas');
  document.getElementById('map-legend-combustible').hidden = !capasActivas.has('combustible');
  document.getElementById('map-legend-marea').hidden = !capasActivas.has('marea');
  document.getElementById('map-legend-evacuacion').hidden = !capasActivas.has('evacuacion');
  document.getElementById('map-legend-emergencia').hidden = !capasActivas.has('emergencia');
  document.getElementById('map-note-temp').hidden = medicion !== 'temp';
  document.getElementById('map-note-aire').hidden = medicion !== 'aire';
  document.getElementById('map-note-precipitacion').hidden = medicion !== 'precipitacion';
  document.getElementById('map-note-sismos').hidden = !capasActivas.has('sismos');
  document.getElementById('map-note-incendios').hidden = !capasActivas.has('incendios');
  document.getElementById('map-note-alertas').hidden = !capasActivas.has('alertas');
  document.getElementById('map-note-volcanes').hidden = !capasActivas.has('volcanes');
  document.getElementById('map-note-avisos').hidden = !capasActivas.has('avisos');
  document.getElementById('map-note-remociones').hidden = !capasActivas.has('remociones');
  document.getElementById('map-note-crecidas').hidden = !capasActivas.has('crecidas');
  document.getElementById('map-note-cortes').hidden = !capasActivas.has('cortes');
  document.getElementById('map-note-esval').hidden = !capasActivas.has('esval');
  document.getElementById('map-note-combustible').hidden = !capasActivas.has('combustible');
  document.getElementById('map-note-marea').hidden = !capasActivas.has('marea');
  document.getElementById('map-note-evacuacion').hidden = !capasActivas.has('evacuacion');
  document.getElementById('map-note-farmacias').hidden = !capasActivas.has('farmacias');
  document.getElementById('map-note-emergencia').hidden = !capasActivas.has('emergencia');
  document.getElementById('map-note-satelite').hidden = !capasActivas.has('satelite');
  document.getElementById('satelite-control').hidden = !capasActivas.has('satelite');
  // Los tileLayers del satélite viven fuera de layerGroups['satelite'] (ver
  // nota crítica arriba): al apagar la capa hay que retirarlos a mano. El
  // rotulado only_labels lo comparten la capa GOES y el modo base Satelital
  // (ambos necesitan nombres de ciudad legibles sobre una imagen oscura): si
  // la capa GOES está apagada pero el modo base es Satelital, se conserva.
  if (!capasActivas.has('satelite')) limpiarSatelite(mapaBase === 'satelital');
  if (mapaBase === 'satelital') getOrCreateSateliteLabelsLayer();
  document.querySelectorAll('.map-mode[data-capa]').forEach((b) =>
    b.setAttribute('aria-pressed', String(capasActivas.has(b.dataset.capa))));
  const basemapBtn = document.getElementById('basemap-toggle');
  if (basemapBtn) {
    basemapBtn.setAttribute('aria-pressed', String(mapaBase === 'satelital'));
    basemapBtn.textContent = mapaBase === 'satelital' ? '🗺️ Mapa: Satelital' : '🗺️ Mapa: Calles';
  }

  map.invalidateSize();   // por si el panel cambió de tamaño desde el último render
}

// Agrupa items {lat, lon} por celdas de pantalla de `px` píxeles al zoom
// actual, para no apilar decenas de estaciones en el mismo punto cuando el
// mapa está alejado (red nacional de ~150 estaciones).
function agruparPorCelda(items, px) {
  const z = map.getZoom();
  const celdas = new Map();
  for (const it of items) {
    const p = map.project([it.lat, it.lon], z);
    const k = `${Math.floor(p.x / px)}:${Math.floor(p.y / px)}`;
    if (!celdas.has(k)) celdas.set(k, []);
    celdas.get(k).push(it);
  }
  return [...celdas.values()];
}

function paintTemp(group) {
  const todas = estacionesData.estaciones.filter((e) => e.obs && e.obs.temperature_2m != null);
  const est = map.getZoom() < 9
    ? agruparPorCelda(todas, 56).map((celda) => celda.find((e) => e.fuente === 'metar') || celda[0])
    : todas;
  est.forEach((e) => {
    const t = e.obs.temperature_2m;
    const box = cajaPopup(e.nombre);
    const meta = document.createElement('small');
    meta.textContent = `${e.fuente === 'metar' ? 'Aeropuerto · red OMM' : 'EMA · Dirección Meteorológica de Chile'} · ${horaLocal(e.obs_time)} h`;
    box.appendChild(meta);
    box.appendChild(popupRows(Object.entries(OBS_LABELS).map(([key, [label, unit]]) =>
      e.obs[key] == null ? [label, null]
        : [label, key === 'wind_direction_10m'
            ? `${Math.round(e.obs[key])}° (${compass(e.obs[key])})`
            : `${r1(e.obs[key])} ${unit}`])));
    pintarMarcador(group, {
      lat: e.lat, lon: e.lon, clase: 'stn-icon',
      html: `<span class="stn-label ${tempClass(t)}">${Math.round(t)}°</span>`,
      tam: [44, 26], titulo: e.nombre, popup: box, maxWidth: 280,
    });
  });
  const resumen = est.length < todas.length ? `${est.length} de ${todas.length} estaciones` : `${est.length} estaciones`;
  const acerca = est.length < todas.length ? ' (acerca el mapa para ver más)' : '';
  $('#map-meta').textContent = estacionesData.updated
    ? `${resumen} · ${horaLocal(estacionesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${acerca}`
    : `${resumen}${acerca}`;
}

function paintAire(group) {
  const todas = aireStations.filter((e) => e.icap != null);
  if (!todas.length) { $('#map-meta').textContent = 'sin datos SINCA'; return; }
  const est = map.getZoom() < 9
    ? agruparPorCelda(todas, 56).map((celda) => celda.find((e) => e.fuente === 'metar') || celda[0])
    : todas;
  est.forEach((e) => {
    const nivel = icapNivel(e.icap);
    const box = cajaPopup(e.nombre);
    const meta = document.createElement('small');
    meta.textContent = `${e.comuna || ''} · SINCA · ICAP ${e.icap} (${nivel.n})`;
    box.appendChild(meta);
    box.appendChild(popupRows([
      ['MP2,5', e.pm2_5 != null ? `${Math.round(e.pm2_5)} µg/m³` : null],
      ['MP10', e.pm10 != null ? `${Math.round(e.pm10)} µg/m³` : null],
    ]));
    pintarMarcador(group, {
      lat: e.lat, lon: e.lon, clase: 'stn-icon',
      html: `<span class="stn-label ${nivel.cls}">${e.icap}</span>`,
      tam: [40, 26], titulo: e.nombre, popup: box,
    });
  });
  const resumen = est.length < todas.length ? `${est.length} de ${todas.length} estaciones SINCA` : `${est.length} estaciones SINCA`;
  const acerca = est.length < todas.length ? ' (acerca el mapa para ver más)' : '';
  $('#map-meta').textContent = metaConFecha(`${resumen} · MP2,5${acerca}`, aireData && aireData.updated);
}

// Formato del acumulado: 1 decimal bajo 10 (precisión útil en valores chicos),
// entero desde 10 (a esa magnitud el decimal ya no aporta).
function fmtAcum(v) {
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
}

// Clase de color por magnitud: se clasifica el valor que se muestra en la
// etiqueta (nieve si se está mostrando nieve, lluvia si no), salvo el piso de
// severidad propio de la nieve (>= 5 cm es severo aunque el mm de lluvia no lo sea).
function precipClass(lluvia48, nieve48) {
  if (nieve48 != null && nieve48 >= 5) return 'pp-severo';
  const v = nieve48 != null && nieve48 >= 1 ? nieve48 : (lluvia48 || 0);
  if (v <= 1) return 'pp-0';
  if (v <= 10) return 'pp-bajo';
  if (v <= 30) return 'pp-medio';
  if (v <= 60) return 'pp-alto';
  return 'pp-severo';
}

function paintPrecip(group) {
  // Solo estaciones con precipitación prevista de verdad: los 0,0 mm son ruido
  // visual (la mayoría del país en un día seco) y no aportan al mapa.
  const todas = (avisosData && avisosData.acumulados || [])
    .filter((a) => a.lluvia_48h != null)
    .filter((a) => a.lluvia_48h >= 0.1 || (a.nieve_48h != null && a.nieve_48h >= 0.5));
  if (!todas.length) { $('#map-meta').textContent = 'sin precipitación prevista en las próximas 48 h'; return; }
  const est = map.getZoom() < 9 ? agruparPorCelda(todas, 56).map((celda) => celda[0]) : todas;
  est.forEach((a) => {
    const nieve = a.nieve_48h != null && a.nieve_48h >= 1;
    const cls = precipClass(a.lluvia_48h, a.nieve_48h);
    const label = nieve ? `❄ ${fmtAcum(a.nieve_48h)} cm` : `${fmtAcum(a.lluvia_48h)} mm`;
    const box = cajaPopup(a.nombre);
    box.appendChild(popupRows([
      ['Lluvia 24 h', `${r1(a.lluvia_24h)} mm`],
      ['Lluvia 48 h', `${r1(a.lluvia_48h)} mm`],
      ['Nieve 24 h', a.nieve_24h != null ? `${r1(a.nieve_24h)} cm` : null],
      ['Nieve 48 h', a.nieve_48h != null ? `${r1(a.nieve_48h)} cm` : null],
    ]));
    const small = document.createElement('small');
    small.textContent = (avisosData && avisosData.fuente) || 'Derivado del pronóstico multi-modelo';
    box.appendChild(small);
    pintarMarcador(group, {
      lat: a.lat, lon: a.lon, clase: 'stn-icon',
      html: `<span class="stn-label ${cls}">${label}</span>`,
      tam: [50, 26], titulo: a.nombre, popup: box, maxWidth: 280,
    });
  });
  const resumen = est.length < todas.length ? `${est.length} de ${todas.length} estaciones` : `${est.length} estaciones`;
  const acerca = est.length < todas.length ? ' (acerca el mapa para ver más)' : '';
  const vencido = avisosData.stale ? ` · pronóstico base de hace ${avisosData.pronostico_horas}h` : '';
  $('#map-meta').textContent = avisosData.updated
    ? `${resumen} · acumulado 48 h · ${horaLocal(avisosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${acerca}${vencido}`
    : `${resumen} · acumulado 48 h${acerca}${vencido}`;
}

// Viento fuerte observado: misma fuente que paintTemp (estaciones.json ya
// cargada), sin grouping por celda — a diferencia de temp/aire/precip, las
// estaciones sobre el umbral son pocas y no se apilan visualmente.
function paintViento(group) {
  const est = estacionesData.estaciones.filter((e) =>
    e.obs && e.obs.wind_direction_10m != null && (
      (e.obs.wind_speed_10m != null && e.obs.wind_speed_10m >= UMBRAL_VIENTO_KMH) ||
      (e.obs.wind_gusts_10m != null && e.obs.wind_gusts_10m >= UMBRAL_RAFAGA_KMH)
    ));
  if (!est.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = `Viento: ninguna estación sobre ${UMBRAL_VIENTO_KMH} km/h ahora`;
    return;
  }
  est.forEach((e) => {
    const v = e.obs.wind_speed_10m;
    const g = e.obs.wind_gusts_10m;
    const dir = e.obs.wind_direction_10m;
    // Beaufort del sostenido solo cuenta si POR SÍ SOLO cruza el umbral de la
    // capa; si la estación entró solo por ráfaga, la severidad es la de la
    // ráfaga (un sostenido bajo no "diluye" el peligro de la ráfaga).
    const sevViento = (v != null && v >= UMBRAL_VIENTO_KMH) ? severidadViento(beaufort(v).grado) : null;
    const sevRafaga = g != null ? severidadRafaga(g) : null;
    const sev = peorSeveridad(sevViento, sevRafaga) || 'amarillo';
    // Hacia dónde VA el viento (no de dónde viene): misma convención que el
    // chip de avance de incendios (vientoEnFoco/paintIncendios más arriba).
    const rumbo = (dir + 180) % 360;
    const vTxt = v == null ? '—' : Math.round(v);
    const rafagaTxt = sevRafaga ? ` · raf ${Math.round(g)}` : '';
    const box = cajaPopup(e.nombre);
    box.appendChild(popupRows([
      ['Viento', v == null ? null : `${Math.round(v)} km/h · Bf ${beaufort(v).grado} (${beaufort(v).nombre})`],
      // Sin grado Beaufort: la escala es solo para viento sostenido, no ráfagas.
      ['Ráfagas', g == null ? null : `${Math.round(g)} km/h`],
      ['Dirección', `desde el ${compass(dir)}`],
      ['Hora obs.', e.obs_time ? `${horaLocal(e.obs_time)} h` : null],
    ]));
    const marker = pintarMarcador(group, {
      lat: e.lat, lon: e.lon, clase: 'viento-icon',
      html: `<span class="viento-flecha">➤</span><span class="stn-label viento-${sev}">${vTxt} km/h${rafagaTxt}</span>`,
      // Ancho holgado para "NNN km/h · raf NNN" (peor caso: sostenido Y ráfaga
      // de 3 dígitos, ej. 150 km/h · raf 300) — medido con Playwright para el
      // caso de 2 dígitos ("33 km/h · raf 98" → 146px de label), + margen para
      // el caso de 3 dígitos: flecha 14px + gap 3px + label mono 0.82rem.
      tam: [190, 24], titulo: e.nombre, popup: box,
    });
    // Rotación por CSSOM tras crear el marcador: la CSP (style-src 'self')
    // bloquea el atributo style inline (mismo patrón que .foco-flecha).
    const el = marker.getElement();
    const flecha = el && el.querySelector('.viento-flecha');
    if (flecha) flecha.style.transform = `rotate(${rumbo - 90}deg)`;
  });
  const resumen = est.length === 1 ? '1 estación' : `${est.length} estaciones`;
  $('#map-meta').textContent = estacionesData.updated
    ? `Viento fuerte: ${resumen} sobre ${UMBRAL_VIENTO_KMH} km/h · ${horaLocal(estacionesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `Viento fuerte: ${resumen} sobre ${UMBRAL_VIENTO_KMH} km/h`;
}

// Chip de impacto estimado PAGER (USGS) — mismo semáforo verde/amarillo/
// naranja/rojo que las alertas volcánicas, reutilizando esas variables CSS.
const PAGER_LABEL = { green: 'verde', yellow: 'amarillo', orange: 'naranja', red: 'rojo' };
function pagerChip(alert) {
  const span = document.createElement('span');
  span.className = `pager-chip pager-${alert}`;
  span.textContent = `Impacto estimado: ${PAGER_LABEL[alert] || alert} (USGS PAGER)`;
  return span;
}

// Color por antigüedad del evento (valores en --sismo-* de app.css, ya
// ajustados para verse bien en claro y oscuro); "old" reutiliza --ink-soft.
function colorSismo(edadMs) {
  if (edadMs < 3600e3) return css('--sismo-h1');
  if (edadMs < 6 * 3600e3) return css('--sismo-h6');
  if (edadMs < 24 * 3600e3) return css('--sismo-h24');
  return css('--ink-soft');
}

function paintSismos(group) {
  const eventos = (sismosData && sismosData.eventos) || [];
  if (!eventos.length) { $('#map-meta').textContent = textoVacio('sismos', 'sin datos sísmicos'); return; }
  const ahora = Date.now();
  const replicas = sismosData.replicas;
  // El JSON viene del más reciente al más antiguo; pintamos al revés para
  // que los eventos recientes queden por encima en el mapa.
  [...eventos].reverse().forEach((e) => {
    const color = colorSismo(ahora - new Date(e.utc_time).getTime());
    const marker = L.circleMarker([e.lat, e.lon], {
      radius: 4 + e.mag * 1.8, color, fillColor: color, fillOpacity: 0.55, weight: 1.5,
    }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong'); h.textContent = `M ${e.mag} · ${e.ref}`; box.appendChild(h);
    const filas = [
      ['Profundidad', e.prof_km != null ? `${e.prof_km} km` : null],
      ['Magnitud', `${e.mag} ${e.mag_tipo}`],
      ['Fecha y hora', fechaHora(e.utc_time)],
      ['Fuente', e.fuente === 'csn' ? 'CSN' : 'USGS'],
    ];
    if (replicas && replicas.mainshock_id === e.id) {
      filas.push(['Réplicas esperadas 24 h', String(replicas.esperadas_24h)]);
    }
    box.appendChild(popupRows(filas));
    if (replicas && replicas.mainshock_id === e.id) {
      const small = document.createElement('small');
      small.textContent = replicas.nota;
      box.appendChild(small);
    }
    if (e.pager) box.appendChild(pagerChip(e.pager));
    marker.bindPopup(box, { maxWidth: 280 });
  });
  $('#map-meta').textContent = sismosData.updated
    ? `${eventos.length} sismos · ${horaLocal(sismosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${eventos.length} sismos`;
}

const CONF_LABEL = { h: 'Alta', n: 'Nominal', l: 'Baja' };

// Estación con viento medido más cercana a un foco (<60 km): base para
// estimar la dirección de avance del fuego. wind_direction_10m es la
// convención meteorológica (de dónde viene el viento), así que el fuego
// avanza hacia el lado opuesto: (dir + 180) % 360.
function vientoEnFoco(lat, lon) {
  if (!estacionesData) return null;
  let best = null;
  for (const e of estacionesData.estaciones) {
    if (!e.obs || e.obs.wind_speed_10m == null || e.obs.wind_direction_10m == null) continue;
    const d = haversineKm(lat, lon, e.lat, e.lon);
    if (!best || d < best.dist) best = { e, dist: d };
  }
  if (!best || best.dist > 60) return null;
  return { v: best.e.obs.wind_speed_10m, dir: best.e.obs.wind_direction_10m, nombre: best.e.nombre, km: best.dist };
}

function paintIncendios(group) {
  const focos = (incendiosData && incendiosData.focos) || [];
  if (!focos.length) {
    // Solo pisa #map-meta si incendios es la única capa activa: si hay otra
    // capa pintada antes o después en ORDEN_PINTADO, su texto debe prevalecer.
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('incendios', 'sin focos activos');
    return;
  }
  // Grupos con menos focos primero: los grupos grandes quedan pintados
  // encima cuando varias celdas se superponen visualmente.
  const grupos = agruparPorCelda(focos, 48).sort((a, b) => a.length - b.length);
  grupos.forEach((grupo) => {
    if (grupo.length === 1) {
      const f = grupo[0];
      const viento = vientoEnFoco(f.lat, f.lon);
      const avance = viento && viento.v >= 15 ? (viento.dir + 180) % 360 : null;
      // Flecha discreta al costado del punto (no lo tapa); solo la rotación
      // indica el rumbo de avance. rotate(avance - 90) porque el glifo ➤
      // apunta al Este (90°) por defecto: rotarlo (avance - 90)° alinea su
      // punta con el rumbo compás (0°=N arriba, 90°=E derecha, sentido horario).
      // Sin atributo style inline: la CSP (style-src 'self') lo bloquea. La
      // rotación se aplica por CSSOM tras crear el marcador.
      const flecha = avance != null ? '<span class="foco-flecha">➤</span>' : '';
      const box = cajaPopup('Foco de calor');
      box.appendChild(popupRows([
        ['FRP', f.frp != null ? `${f.frp} MW` : null],
        ['Confianza', CONF_LABEL[f.conf] || f.conf],
        ['Satélite', f.sat],
        ['Hora local', `${horaLocal(f.utc)} h`],
      ]));
      if (viento) {
        if (viento.v >= 15) {
          const chip = document.createElement('div');
          chip.className = `viento-avance${viento.v >= 30 ? ' viento-avance-fuerte' : ''}`;
          chip.textContent = `Viento ${Math.round(viento.v)} km/h desde el ${compass(viento.dir)} ` +
            `(${viento.nombre}, a ${Math.round(viento.km)} km) → avance probable hacia el ${compass(avance)}`;
          box.appendChild(chip);
        } else {
          const debil = document.createElement('div');
          debil.className = 'viento-debil';
          debil.textContent = `Viento débil (${Math.round(viento.v)} km/h) — propagación lenta o errática`;
          box.appendChild(debil);
        }
        const nota = document.createElement('small');
        nota.textContent = 'Aproximación con el viento de la estación más cercana; el viento local en el ' +
          'foco puede diferir. Ante fuego cercano evacúa temprano, no esperes confirmación.';
        box.appendChild(nota);
      }
      const marker = pintarMarcador(group, {
        lat: f.lat, lon: f.lon, clase: `foco foco-${f.conf || 'n'}`,
        html: flecha, tam: [10, 10], popup: box,
      });
      if (avance != null) {
        const el = marker.getElement();
        const span = el && el.querySelector('.foco-flecha');
        if (span) span.style.transform = `rotate(${avance - 90}deg)`;
      }
    } else {
      const lat = grupo.reduce((s, f) => s + f.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, f) => s + f.lon, 0) / grupo.length;
      const marker = pintarMarcador(group, {
        lat, lon, clase: 'stn-icon',
        html: `<span class="stn-label foco-grupo">🔥<b>${grupo.length}</b></span>`,
        tam: [40, 26], titulo: `${grupo.length} focos de calor — toca para ver`,
      });
      const box = cajaPopup(`${grupo.length} focos de calor`);
      const ul = document.createElement('ul');
      ul.className = 'grupo-lista';
      const MAX_LISTA = 12;
      [...grupo].sort((a, b) => (b.frp || 0) - (a.frp || 0)).slice(0, MAX_LISTA).forEach((f) => {
        const li = document.createElement('li');
        li.textContent = `FRP ${f.frp != null ? f.frp + ' MW' : '—'} · confianza ${CONF_LABEL[f.conf] || f.conf} · ${fechaHora(f.utc)}`;
        ul.appendChild(li);
      });
      if (grupo.length > MAX_LISTA) {
        const li = document.createElement('li');
        li.textContent = `y ${grupo.length - MAX_LISTA} más`;
        ul.appendChild(li);
      }
      box.appendChild(ul);
      const popup = L.popup({ maxWidth: 280 }).setLatLng([lat, lon]).setContent(box);
      // Bajo zoom 16, el clic acerca el mapa (zoom+2) y normalmente el grupo
      // se separa en focos individuales. Desde zoom 16 el +2 ya llega al
      // techo (tileLayer con maxZoom 18) y dos focos a <20 m siguen cayendo
      // en la misma celda de 48 px: el grupo nunca se desagrega, así que el
      // clic abre el detalle en un popup en vez de ser un botón muerto.
      // (No se usa bindPopup para no duplicar el toggle automático de Leaflet
      // con este handler de clic.)
      marker.on('click', () => {
        if (map.getZoom() < 16) map.setView([lat, lon], map.getZoom() + 2);
        else popup.openOn(map);
      });
    }
  });
  $('#map-meta').textContent = incendiosData.updated
    ? `${focos.length} focos · ${horaLocal(incendiosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${focos.length} focos`;
}

const NIVEL_ALERTA_LABEL = {
  roja: 'Alerta Roja', amarilla: 'Alerta Amarilla', temprana_preventiva: 'Alerta Temprana Preventiva',
};

// Emoji por texto del evento (case-insensitive); ⚠️ si no matchea ninguno.
function emojiEvento(evento) {
  const e = (evento || '').toLowerCase();
  if (/aluvi|remoci|lahar/.test(e)) return '🌊';
  if (/meteo|frontal|lluvia|viento|nieve/.test(e)) return '🌧️';
  if (/incendio|forestal/.test(e)) return '🔥';
  if (/volc/.test(e)) return '🌋';
  if (/marea|biol/.test(e)) return '🦠';
  return '⚠️';
}


// Severidad para elegir, por comuna, la alerta más grave a mostrar (mismo
// orden que usa riesgoEventos: roja > amarilla > temprana_preventiva).
const SEVERIDAD_ALERTA = { roja: 3, amarilla: 2, temprana_preventiva: 1 };

// SENAPRED agrega un sufijo administrativo tipo "(mod. cober. 10-07-2026)"
// al re-emitir una alerta con cobertura modificada; no aporta al lector así
// que se limpia (regex conservadora: solo paréntesis que empiezan con "mod.").
function limpiaEvento(evento) {
  return (evento || '').replace(/\s*\(mod\.[^)]*\)/gi, '').trim();
}

// Bloque compacto de una alerta: título (emoji + evento), metadatos (nivel +
// fecha, con región opcional cuando el título del popup no es una comuna) y
// el resumen de qué implica el evento. La explicación del nivel va aparte
// (una sola vez por popup, con el nivel más severo) para no repetirla.
function alertaPopup(box, a, { conRegion = false } = {}) {
  const titulo = document.createElement('strong');
  titulo.textContent = `${emojiEvento(a.evento)} ${limpiaEvento(a.evento)}`;
  box.appendChild(titulo);
  const meta = document.createElement('p');
  meta.className = 'alerta-meta';
  const nivel = NIVEL_ALERTA_LABEL[a.nivel] || a.nivel;
  meta.textContent = conRegion ? `${nivel} · ${a.region} · desde ${a.desde}` : `${nivel} · desde ${a.desde}`;
  box.appendChild(meta);
  const explica = document.createElement('p');
  explica.className = 'alerta-explica';
  explica.textContent = explicaEvento(a.evento);
  box.appendChild(explica);
}

// Pie común a todos los popups de alertas: explicación del nivel más severo
// presente (una sola vez) y el link al listado oficial de boletines.
function piePopupAlertas(box, nivel) {
  const pNivel = document.createElement('p');
  pNivel.className = 'alerta-nivel-explica';
  pNivel.textContent = EXPLICA_NIVEL[nivel] || '';
  box.appendChild(pNivel);
  const link = document.createElement('a');
  link.href = 'https://senapred.cl/alertas/';
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'Detalle oficial: senapred.cl/alertas →';
  box.appendChild(link);
}

// Un pin por alerta era engañoso: SENAPRED entrega un único lat/lon por
// alerta (el punto medio de TODAS sus comunas), así que una alerta regional
// de 38 comunas quedaba con su único pin cerca de la comuna central y quien
// mira el resto de la región no veía nada. Ahora se pinta un marcador por
// comuna afectada (centroide INE de comunas.json), agrupando las alertas
// que la tocan; si una alerta no matchea ninguna comuna del catastro, cae
// al comportamiento anterior (un pin en su punto medio).
function paintAlertas(group) {
  const todas = (alertasData && alertasData.alertas) || [];
  if (!todas.length) { $('#map-meta').textContent = textoVacio('alertas', 'sin alertas vigentes'); return; }

  const indice = comunasData
    ? new Map(comunasData.comunas.map((c) => [norm(c.n), c]))
    : null;

  const grupos = new Map(); // nombre-normalizado → { centroide, alertas: [] }
  const sinComuna = [];
  todas.forEach((a) => {
    const nombres = Array.isArray(a.comunas) ? a.comunas : [];
    let matcheo = false;
    nombres.forEach((nombreComuna) => {
      const centroide = indice && indice.get(norm(nombreComuna));
      if (!centroide) return;
      matcheo = true;
      const key = norm(nombreComuna);
      if (!grupos.has(key)) grupos.set(key, { centroide, alertas: [] });
      grupos.get(key).alertas.push(a);
    });
    if (!matcheo && a.lat != null && a.lon != null) sinComuna.push(a);
  });

  grupos.forEach(({ centroide, alertas }) => {
    const peor = [...alertas].sort((x, y) => (SEVERIDAD_ALERTA[y.nivel] || 0) - (SEVERIDAD_ALERTA[x.nivel] || 0))[0];
    const box = cajaPopup(centroide.n);
    alertas.forEach((a) => alertaPopup(box, a));
    piePopupAlertas(box, peor.nivel);
    pintarMarcador(group, {
      lat: centroide.lat, lon: centroide.lon, clase: 'stn-icon',
      html: `<span class="alerta alerta-${peor.nivel}">${emojiEvento(peor.evento)}</span>`,
      tam: [38, 38], titulo: centroide.n, popup: box, maxWidth: 300, maxHeight: 300,
    });
  });

  sinComuna.forEach((a) => {
    const box = cajaPopup();
    alertaPopup(box, a, { conRegion: true });
    piePopupAlertas(box, a.nivel);
    pintarMarcador(group, {
      lat: a.lat, lon: a.lon, clase: 'stn-icon',
      html: `<span class="alerta alerta-${a.nivel}">${emojiEvento(a.evento)}</span>`,
      tam: [38, 38], titulo: a.evento, popup: box, maxWidth: 300, maxHeight: 300,
    });
  });

  const sufijoParcialAlertas = alertasData.parcial ? ' · datos posiblemente desactualizados' : '';
  $('#map-meta').textContent = alertasData.updated
    ? `${todas.length} alertas · ${horaLocal(alertasData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${sufijoParcialAlertas}`
    : `${todas.length} alertas${sufijoParcialAlertas}`;
}

function paintVolcanes(group) {
  const volcanes = (volcanesData && volcanesData.volcanes) || [];
  // Fuente parcial (fallback web de SERNAGEOMIN): solo lista volcanes con
  // alerta sobre verde, así que 0 es un dato válido ("nadie sobre verde"),
  // no ausencia de datos como en la ruta primaria RNVV.
  const parcial = !!(volcanesData && volcanesData.parcial);
  const sufijoParcial = parcial ? ' · fuente parcial (solo alerta elevada)' : '';
  if (!volcanes.length) {
    if (capasActivas.size === 1) {
      $('#map-meta').textContent = parcial ? `0 volcanes con alerta${sufijoParcial}` : textoVacio('volcanes', 'sin datos RNVV');
    }
    return;
  }
  const TAMANO = { verde: 12, amarilla: 16, naranja: 18, roja: 20 };
  volcanes.forEach((v) => {
    const size = TAMANO[v.nivel] || 12;
    const box = cajaPopup(v.nombre);
    box.appendChild(popupRows([
      ['Alerta técnica', v.nivel],
      ['Región', v.region],
      ['Peligrosidad geológica', v.peligrosidad],
    ]));
    pintarMarcador(group, {
      lat: v.lat, lon: v.lon, clase: 'volcan-icon',
      html: `<span class="volcan vol-${v.nivel}"></span>`,
      tam: [size, size], titulo: v.nombre, popup: box,
    });
  });
  $('#map-meta').textContent = volcanesData.updated
    ? `${volcanes.length} volcanes · ${horaLocal(volcanesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${sufijoParcial}`
    : `${volcanes.length} volcanes${sufijoParcial}`;
}

// ── Avisos meteorológicos (derivados del pronóstico propio, NO oficiales) ──

const AVISO_EMOJI = { viento: '💨', helada: '❄️', lluvia: '🌧️', lluvia_persistente: '🌧️', calor: '🌡️', aluvional: '⛰️💧', nieve: '❄️', incendio: '🔥', rafagas: '🌪️', presion: '📉', nieve_cota_baja: '🏔️❄️', ola_calor: '🥵', ola_frio: '🥶', tormenta: '⛈️', uv: '☀️' };
const AVISO_TIPO_LABEL = { viento: 'Viento fuerte', helada: 'Helada', lluvia: 'Lluvia intensa', lluvia_persistente: 'Lluvia persistente', calor: 'Calor extremo', aluvional: 'Riesgo aluvional', nieve: 'Nieve', incendio: 'Riesgo de incendio', rafagas: 'Ráfagas de viento', presion: 'Caída de presión (temporal)', nieve_cota_baja: 'Nieve en cota baja', ola_calor: 'Ola de calor', ola_frio: 'Ola de frío', tormenta: 'Tormenta eléctrica', uv: 'UV extremo' };
const AVISO_NIVEL_LABEL = { amarillo: 'Amarillo', naranja: 'Naranja', rojo: 'Rojo' };

function paintAvisos(group) {
  const avisos = (avisosData && avisosData.avisos) || [];
  if (!avisos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('avisos', 'sin avisos meteo'); return; }
  avisos.forEach((a) => {
    const box = cajaPopup(`${AVISO_TIPO_LABEL[a.tipo] || a.tipo} · ${a.nombre}`);
    const filas = [
      ['Nivel', AVISO_NIVEL_LABEL[a.nivel] || a.nivel],
      ['Valor peak', `${r1(a.valor)} ${a.unidad}`],
      ['Hora peak', fechaHora(a.hora_peak)],
    ];
    if ((a.tipo === 'aluvional' || a.tipo === 'nieve_cota_baja') && a.isoterma_m != null) filas.push(['Isoterma 0°', `~${a.isoterma_m} m`]);
    if ((a.tipo === 'ola_calor' || a.tipo === 'ola_frio') && a.dias != null) filas.push(['Días consecutivos', `${a.dias}`]);
    if (a.tipo === 'incendio') {
      if (a.hr != null) filas.push(['Humedad relativa', `${r1(a.hr)} %`]);
      if (a.viento != null) filas.push(['Viento', `${r1(a.viento)} km/h`]);
    }
    if (a.umbral != null) filas.push(['Umbral amarillo', `${r1(a.umbral)} ${a.unidad}`]);
    if (a.acuerdo) filas.push(['Acuerdo entre modelos', a.acuerdo]);
    box.appendChild(popupRows(filas));
    if (a.tipo === 'aluvional') {
      const riesgo = document.createElement('p');
      riesgo.textContent = `${r1(a.valor)} mm en 24 h con isoterma ~${a.isoterma_m} m — riesgo de aluvión en quebradas y laderas; aléjate de cauces`;
      box.appendChild(riesgo);
    }
    if (a.tipo === 'incendio') {
      const riesgo = document.createElement('p');
      riesgo.textContent = `${r1(a.valor)} °C con ${r1(a.hr)} % HR y ${r1(a.viento)} km/h de viento — condiciones de comportamiento de incendio extremo (regla 30-30-30)`;
      box.appendChild(riesgo);
    }
    const small = document.createElement('small');
    small.textContent = (avisosData && avisosData.nota) || 'Aviso derivado de modelos, no es un aviso oficial de la DMC';
    box.appendChild(small);
    pintarMarcador(group, {
      lat: a.lat, lon: a.lon, clase: 'stn-icon',
      html: `<span class="alerta aviso-${a.nivel}">${AVISO_EMOJI[a.tipo] || '⚠️'}</span>`,
      tam: [38, 38], titulo: a.nombre, popup: box, maxWidth: 280,
    });
  });
  const vencido = avisosData.stale ? ` · pronóstico base de hace ${avisosData.pronostico_horas}h` : '';
  $('#map-meta').textContent = avisosData.updated
    ? `${avisos.length} avisos meteo · ${horaLocal(avisosData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${vencido}`
    : `${avisos.length} avisos meteo${vencido}`;
}

// ── Marea, oleaje y temperatura del mar (Open-Meteo Marine, no oficial) ──

function paintMarea(group) {
  const puntos = (mareaData && mareaData.puntos) || [];
  if (!puntos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('marea', 'sin datos de marea'); return; }
  puntos.forEach((p) => {
    const cls = p.tendencia === 'bajando' ? 'marea-baja' : 'marea-sube';
    const flecha = p.tendencia === 'bajando' ? '▼' : p.tendencia === 'subiendo' ? '▲' : '—';
    const anillo = p.marejada ? ` marejada-${p.marejada.nivel}` : '';
    const box = cajaPopup(p.nombre);
    const meta = document.createElement('small');
    meta.textContent = `Marea ${r1(p.nivel)} m (${p.tendencia || 'estable'})`;
    box.appendChild(meta);
    const filas = (p.extremos || []).slice(0, 2).map((e) =>
      [e.tipo === 'pleamar' ? 'Pleamar' : 'Bajamar', `${fechaHora(e.t)} · ${r1(e.h)} m`]);
    if (p.ola) filas.push(['Ola', `${r1(p.ola.altura)} m · ${r1(p.ola.periodo)} s`]);
    if (p.sst != null) filas.push(['Mar', `${r1(p.sst)} °C`]);
    box.appendChild(popupRows(filas));
    if (p.marejada) {
      const aviso = document.createElement('p');
      aviso.className = `marejada-${p.marejada.nivel}`;
      aviso.textContent = `🌊 Marejadas: olas de hasta ${r1(p.marejada.altura)} m ${fechaHora(p.marejada.t)}`;
      box.appendChild(aviso);
    }
    const small = document.createElement('small');
    small.textContent = (mareaData && mareaData.nota) || '';
    box.appendChild(small);
    pintarMarcador(group, {
      lat: p.lat, lon: p.lon, clase: 'stn-icon',
      html: `<span class="stn-label ${cls}${anillo}">${flecha}</span>`,
      tam: [30, 26], titulo: p.nombre, popup: box, maxWidth: 280,
    });
  });
  $('#map-meta').textContent = mareaData.updated
    ? `${puntos.length} puntos costeros · marea de modelo (no oficial) · ${horaLocal(mareaData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h`
    : `${puntos.length} puntos costeros · marea de modelo (no oficial)`;
}

const EMG_EMOJI = { salud: '🏥', bomberos: '🚒', carabineros: '🚓', farmacia: '💊', encuentro_tsunami: '🟢', encuentro_volcan: '🔶' };

// Ícono + popup de UN punto de infraestructura de emergencia (o farmacia):
// compartido por paintEmergencia y paintFarmacias para no duplicar el
// marcador ni el popup entre ambas capas.
function pintarPuntoEmg(it, group) {
  const box = cajaPopup(it.n);
  if (it.d) { const small = document.createElement('small'); small.textContent = it.d; box.appendChild(small); }
  if (it.h) { const smallH = document.createElement('small'); smallH.textContent = `Horario: ${it.h}`; box.appendChild(smallH); }
  if (it.cat === 'farmacia' && it.fecha) {
    const turno = document.createElement('small');
    turno.textContent = `De turno hoy ${it.fecha}`;
    box.appendChild(turno);
  }
  if (it.cat === 'encuentro_tsunami') {
    const a = document.createElement('a');
    a.href = 'https://senapred.cl/visor-chile-preparado/';
    a.rel = 'noopener'; a.target = '_blank';
    a.textContent = 'ver vías de evacuación oficiales';
    box.appendChild(a);
  }
  box.appendChild(enlaceComoLlegar(it.lat, it.lon));
  pintarMarcador(group, {
    lat: it.lat, lon: it.lon, clase: 'stn-icon',
    html: `<span class="emg">${it.emoji}</span>`,
    tam: [26, 26], titulo: it.n, popup: box,
  });
}

// Grupo de N puntos en la misma celda: mismo patrón que pintarPuntoEmg pero
// con contador y lista de los primeros MAX_LISTA. emojiGrupo/etiqueta
// distinguen el glifo de cluster entre 'emergencia' (🚑) y 'farmacias' (💊).
function pintarGrupoEmg(grupo, group, emojiGrupo, etiqueta) {
  const lat = grupo.reduce((s, it) => s + it.lat, 0) / grupo.length;
  const lon = grupo.reduce((s, it) => s + it.lon, 0) / grupo.length;
  const marker = pintarMarcador(group, {
    lat, lon, clase: 'stn-icon',
    html: `<span class="stn-label emg-grupo">${emojiGrupo}<b>${grupo.length}</b></span>`,
    tam: [40, 26], titulo: `${grupo.length} ${etiqueta} — toca para ver`,
  });
  const box = cajaPopup(`${grupo.length} en este punto`);
  const ul = document.createElement('ul');
  ul.className = 'grupo-lista';
  const MAX_LISTA = 12;
  grupo.slice(0, MAX_LISTA).forEach((it) => {
    const li = document.createElement('li');
    li.textContent = `${it.emoji} ${it.n}${it.d ? ` — ${it.d}` : ''}`;
    ul.appendChild(li);
  });
  if (grupo.length > MAX_LISTA) {
    const li = document.createElement('li');
    li.textContent = `y ${grupo.length - MAX_LISTA} más`;
    ul.appendChild(li);
  }
  box.appendChild(ul);
  const popup = L.popup({ maxWidth: 280 }).setLatLng([lat, lon]).setContent(box);
  // Mismo criterio que en incendios (paintIncendios): bajo zoom 16 el
  // clic acerca el mapa y el grupo suele separarse; desde zoom 16 el +2
  // ya llega al techo (maxZoom 18) y el grupo nunca se desagrega, así
  // que el clic abre el detalle en un popup.
  marker.on('click', () => {
    if (map.getZoom() < 16) map.setView([lat, lon], map.getZoom() + 2);
    else popup.openOn(map);
  });
}

function paintEmergencia(group) {
  if (!emergenciaData) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('emergencia', 'cargando infraestructura de emergencia…');
    return;
  }
  const categorias = emergenciaData.categorias || {};
  const todos = [];
  for (const [cat, emoji] of Object.entries(EMG_EMOJI)) {
    // La capa propia 'farmacias' pinta las mismas farmacias con su propio
    // botón: si está activa a la vez que 'emergencia', se omiten aquí para
    // no duplicar los marcadores (dedupe visual, ver spec del botón 💊).
    if (cat === 'farmacia' && capasActivas.has('farmacias')) continue;
    for (const it of (categorias[cat] || [])) {
      todos.push({ ...it, cat, emoji, fecha: cat === 'farmacia' ? emergenciaData.farmaciaFecha : undefined });
    }
  }
  if (!todos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('emergencia', 'sin datos de emergencia'); return; }
  // ~9.000 puntos en todo el país: pintarlos todos satura el DOM (9.292
  // divIcons medidos a zoom 13 en Valparaíso). Se filtra primero al
  // viewport actual (con margen, para no recortar en el borde) y recién
  // sobre eso se agrupa/pinta — igual que ya se hace con vías y áreas.
  const boundsPuntos = map.getBounds().pad(0.3);
  const visibles = todos.filter((it) => boundsPuntos.contains([it.lat, it.lon]));
  // Con ~9.000 puntos el clustering es obligatorio salvo con el mapa muy
  // acercado (zoom ≥ 13), donde cada punto se pinta individual.
  const grupos = map.getZoom() >= 13
    ? visibles.map((it) => [it])
    : agruparPorCelda(visibles, 44).sort((a, b) => a.length - b.length);
  grupos.forEach((grupo) => {
    if (grupo.length === 1) pintarPuntoEmg(grupo[0], group);
    else pintarGrupoEmg(grupo, group, '🚑', 'servicios de emergencia');
  });
  const staleFarmacia = emergenciaData.farmaciaStale && !capasActivas.has('farmacias') ? ' · farmacias: datos antiguos (satélite sin actualizar)' : '';
  const sufijoParcialEmg = emergenciaData.parcial ? ' · datos posiblemente desactualizados' : '';
  $('#map-meta').textContent = emergenciaData.updated
    ? `${todos.length} puntos de emergencia · ${horaLocal(emergenciaData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${staleFarmacia}${sufijoParcialEmg}`
    : `${todos.length} puntos de emergencia${staleFarmacia}${sufijoParcialEmg}`;
}

// Farmacias de turno como capa propia: además de aparecer dentro de
// 'emergencia' (como hasta ahora), tienen su botón 💊 independiente. Mismo
// builder de marcador/popup que paintEmergencia (pintarPuntoEmg/
// pintarGrupoEmg) — el dedupe cuando ambas capas están activas vive en
// paintEmergencia, no acá.
function paintFarmacias(group) {
  if (!farmaciasData) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('farmacias', 'cargando farmacias de turno…');
    return;
  }
  const todos = farmaciasData.lista.map((it) => ({ ...it, cat: 'farmacia', emoji: '💊', fecha: farmaciasData.fecha }));
  if (!todos.length) { if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('farmacias', 'sin farmacias de turno reportadas'); return; }
  const boundsPuntos = map.getBounds().pad(0.3);
  const visibles = todos.filter((it) => boundsPuntos.contains([it.lat, it.lon]));
  // Umbral de pin individual más bajo que 'emergencia' (zoom 11 en vez de
  // 13): a diferencia de los ~9.000 puntos de infraestructura, las farmacias
  // de turno son pocas por comuna — pedido explícito de pines directos antes
  // sin pasar por el racimo agrupado.
  const grupos = map.getZoom() >= 11
    ? visibles.map((it) => [it])
    : agruparPorCelda(visibles, 44).sort((a, b) => a.length - b.length);
  grupos.forEach((grupo) => {
    if (grupo.length === 1) pintarPuntoEmg(grupo[0], group);
    else pintarGrupoEmg(grupo, group, '💊', 'farmacias de turno');
  });
  $('#map-meta').textContent = metaConFecha(`${todos.length} farmacias de turno · MINSAL/Farmanet`, farmaciasData.updated, farmaciasData.stale);
}

// Bounding box de una geometría (área o vía), cacheado en el propio objeto
// tras el primer cálculo: con ~2.940 vías y un repintado en cada moveend/
// zoomend, recorrer todos los vértices de todas las geometrías en cada
// pintado sería costoso — el bounding box no cambia entre repintados.
function geomBounds(geom) {
  if (!geom._bb) geom._bb = L.latLngBounds(geom.p);
  return geom._bb;
}

// Vías y áreas de evacuación ante tsunami/volcán: comparten loader con
// 'emergencia' (loadEmergencia) pero son su propia capa — el usuario no las
// encontraba mezcladas con los ~9.000 puntos de infraestructura.
function paintEvacuacion(group) {
  if (!tsunamiViasData && !tsunamiAreasData) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('evacuacion', 'cargando vías de evacuación…');
    return;
  }
  // Área de evacuación ante tsunami: solo con el mapa acercado (zoom ≥ 12) y
  // filtrada por viewport, igual que las vías. Va ANTES que las vías para
  // quedar debajo (relleno de fondo, no un trazo que compita con la ruta a
  // seguir).
  // Sobre satélite, techos y vegetación compiten con el relleno/trazo: se
  // sube la opacidad y se agrega borde discontinuo para que el límite se
  // distinga (sobre 'calles' quedan como estaban, el fondo ya es plano).
  const sobreSatelite = mapaBase === 'satelital';
  if (tsunamiAreasData && map.getZoom() >= 12) {
    const bounds = map.getBounds();
    const color = css('--alerta-roja');
    for (const area of tsunamiAreasData.areas || []) {
      if (!bounds.intersects(geomBounds(area))) continue;
      L.polygon(area.p, sobreSatelite
        ? { color, weight: 2, opacity: 0.9, dashArray: '6 4', fillColor: color, fillOpacity: 0.28 }
        : { color, weight: 1, opacity: 0.3, fillColor: color, fillOpacity: 0.12 })
        .bindPopup('Zona de evacuación ante tsunami — si sientes un sismo fuerte, abandona esta zona hacia terreno alto')
        .addTo(group);
    }
  }

  // Vías de evacuación (tsunami + volcán): solo con el mapa acercado (zoom ≥
  // 11) y filtradas por el viewport actual — con ~2.940 vías en todo el
  // país, pintar sin filtro de bounds haría el mapa ilegible y lento en
  // cualquier zoom país.
  let pintadas = 0;
  if (tsunamiViasData && map.getZoom() >= 11) {
    const bounds = map.getBounds();
    const colorTsunami = css('--evac');
    const colorVolcan = css('--evac-volcan');
    for (const via of tsunamiViasData.vias || []) {
      if (!bounds.intersects(geomBounds(via))) continue;
      const esVolcan = via.t === 'volcan';
      const color = esVolcan ? colorVolcan : colorTsunami;
      // Casing cartográfico: una línea blanca más gruesa debajo del trazo de
      // color, para que se lea sobre cualquier textura del satélite (ya
      // filtradas por viewport arriba, así que duplicar solo estas es barato).
      if (sobreSatelite) {
        L.polyline(via.p, { color: '#fff', weight: 6, opacity: 0.9 }).addTo(group);
      }
      L.polyline(via.p, { color, weight: 3, opacity: 0.85, dashArray: '6 4' })
        .bindPopup(esVolcan ? `Vía de evacuación volcánica · ${via.c}` : `Vía de evacuación · ${via.c}`)
        .addTo(group);
      pintadas++;
    }
  }

  // Con el mapa en zoom país, las vías (zoom ≥ 11) y el área de inundación
  // (zoom ≥ 12) no se pintan y no hay ninguna pista visual de que existen:
  // el usuario reportó "no las veo". El aviso solo aparece cuando falta el
  // requisito de zoom para las vías (el más bajo de los dos).
  // Fecha y parcial: vías y áreas se cargan juntas (loadEmergencia) pero son
  // JSON separados, cada uno con su propio updated/parcial — se toma el que
  // haya (updated) y se marca parcial si CUALQUIERA de los dos quedó
  // parcial (mismo criterio que paintVolcanes con fuente parcial).
  const updatedEvac = (tsunamiViasData && tsunamiViasData.updated) || (tsunamiAreasData && tsunamiAreasData.updated);
  const parcialEvac = !!((tsunamiViasData && tsunamiViasData.parcial) || (tsunamiAreasData && tsunamiAreasData.parcial));
  const sufijoParcialEvac = parcialEvac ? ' · datos posiblemente desactualizados' : '';
  $('#map-meta').textContent = map.getZoom() < 11
    ? 'vías de evacuación: acerca el mapa a una zona costera o volcánica'
    : metaConFecha(`${pintadas} vías de evacuación en el encuadre${sufijoParcialEvac}`, updatedEvac);
}

// ── Remociones en masa: catastro histórico (SENAPRED) ───────────

// Los subtipos 'Propagación' y 'Deformaciones de ladera' son marginales
// (8 y 3 puntos de 1.218) y no justifican un color propio: se pintan con el
// mismo glifo/color que 'Deslizamiento'.
const REM_CLASE = {
  Flujo: 'rem-flujo',
  Deslizamiento: 'rem-desliza',
  'Caída': 'rem-caida',
  'Propagación': 'rem-desliza',
  'Deformaciones de ladera': 'rem-desliza',
};

function paintRemociones(group) {
  const puntos = (remocionesData && remocionesData.puntos) || [];
  if (!puntos.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('remociones', 'cargando catastro de remociones…');
    return;
  }
  const zoom = map.getZoom();
  if (zoom < 9) {
    // Bajo zoom 9: mismo patrón que paintIncendios, grupos con contador
    // circular en vez de 1.218 puntos individuales ilegibles a escala país.
    const grupos = agruparPorCelda(puntos, 48).sort((a, b) => a.length - b.length);
    grupos.forEach((grupo) => {
      const lat = grupo.reduce((s, p) => s + p.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, p) => s + p.lon, 0) / grupo.length;
      const marker = pintarMarcador(group, {
        lat, lon, clase: 'stn-icon',
        html: `<span class="stn-label rem-grupo">⛰️<b>${grupo.length}</b></span>`,
        tam: [40, 26], titulo: `${grupo.length} remociones registradas — toca para acercar`,
      });
      marker.on('click', () => map.setView([lat, lon], zoom + 2));
    });
  } else {
    puntos.forEach((p) => {
      const clase = REM_CLASE[p.t] || 'rem-desliza';
      const box = cajaPopup(`${p.t} — remoción en masa registrada`);
      const small = document.createElement('small');
      small.textContent = 'Si vives cerca: ante lluvia intensa aléjate de quebradas y laderas';
      box.appendChild(small);
      pintarMarcador(group, {
        lat: p.lat, lon: p.lon, clase: `rem-icon ${clase}`,
        tam: [12, 12], titulo: p.t, popup: box,
      });
      // Zona de influencia aproximada: solo con el mapa bien acercado, igual
      // que el criterio de zoom de paintEvacuacion para no saturar el mapa.
      if (zoom >= 12) {
        const color = css(`--${clase}`);
        L.circle([p.lat, p.lon], { radius: 150, color, weight: 0, fillColor: color, fillOpacity: 0.12 }).addTo(group);
      }
    });
  }
  $('#map-meta').textContent = metaConFecha(`${puntos.length} remociones registradas · catastro SENAPRED`, remocionesData.updated);
}

// ── Crecidas de ríos (GloFAS/Copernicus vía Open-Meteo, NO oficial) ──

// "YYYY-MM-DD" → "DD-MM-AAAA" (formato Chile, regla 8), sin pasar por Date
// para no arrastrar el desfase de zona horaria de un string sin hora.
function fechaChile(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

// Etiqueta "DD-MM" del día i-ésimo de la serie de 7, contado desde el día
// calendario (UTC) del `updated` global — mismo día en que Open-Meteo fechó
// el pronóstico. En TZ Chile un `updated` de madrugada UTC cae la noche
// anterior, así que se formatea en UTC para no correr la fecha un día.
function diaSerie(updated, i) {
  const base = parseUpdated(updated);
  const d = new Date(base.getTime() + i * 86400000);
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: '2-digit', timeZone: 'UTC' }).format(d);
}

function paintCrecidas(group) {
  const puntos = (crecidasData && crecidasData.puntos) || [];
  if (!puntos.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('crecidas', 'cargando pronóstico de crecidas…');
    return;
  }
  puntos.forEach((p) => {
    const clase = p.nivel ? `creci-${p.nivel}` : 'creci-normal';
    const box = cajaPopup(`${p.rio} — ${p.comuna}`);

    const serieMax = p.caudal_max.some((v) => v != null) ? p.caudal_max : p.caudal;
    const peak = serieMax.filter((v) => v != null).reduce((m, v) => (m == null || v > m ? v : m), null);
    box.appendChild(popupRows([
      ['Nivel', p.nivel ? (AVISO_NIVEL_LABEL[p.nivel] || p.nivel) : 'Sin alerta (normal)'],
      ['Caudal peak (7 días)', peak != null ? `${Math.round(peak).toLocaleString('es-CL')} m³/s` : null],
      ['Día peak', p.dia_peak ? fechaChile(p.dia_peak) : null],
      ['Umbral amarillo (~2 años)', p.umbral_rp2 != null ? `${Math.round(p.umbral_rp2).toLocaleString('es-CL')} m³/s` : null],
      ['Umbral naranja (~5 años)', p.umbral_rp5 != null ? `${Math.round(p.umbral_rp5).toLocaleString('es-CL')} m³/s` : null],
      ['Umbral rojo (~20 años)', p.umbral_rp20 != null ? `${Math.round(p.umbral_rp20).toLocaleString('es-CL')} m³/s` : null],
    ]));

    const serieLabel = document.createElement('small');
    serieLabel.textContent = 'Serie de 7 días (caudal máximo diario)';
    box.appendChild(serieLabel);
    box.appendChild(popupRows(serieMax.map((v, i) => [
      diaSerie(crecidasData.updated, i),
      v != null ? `${Math.round(v).toLocaleString('es-CL')} m³/s` : null,
    ])));

    const small = document.createElement('small');
    small.textContent = crecidasData.nota || 'Pronóstico de referencia GloFAS, no oficial';
    box.appendChild(small);
    pintarMarcador(group, {
      lat: p.lat, lon: p.lon, clase: 'stn-icon',
      html: `<span class="alerta ${clase}">🌊</span>`,
      tam: [38, 38], titulo: `${p.rio} — ${p.comuna}`, popup: box, maxWidth: 280,
    });
  });

  const conNivel = puntos.filter((p) => p.nivel).length;
  $('#map-meta').textContent = metaConFecha(`${puntos.length} ríos monitoreados · ${conNivel} en crecida · GloFAS`, crecidasData.updated);
}

// Círculo escalado por clientes afectados (mismo patrón que paintSismos con
// la magnitud): raíz cuadrada para que comunas con miles de clientes no
// tapen el mapa completo, tope de radio para que sigan siendo comparables.
function paintCortes(group) {
  const cortes = (cortesData && cortesData.cortes) || [];
  if (!cortes.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('cortes', 'sin cortes de luz reportados');
    return;
  }
  const color = css('--alerta-amarilla');
  cortes.forEach((c) => {
    if (c.lat == null || c.lon == null) return;
    const radius = Math.min(6 + Math.sqrt(c.clientes) * 0.9, 40);
    const marker = L.circleMarker([c.lat, c.lon], {
      radius, color, fillColor: color, fillOpacity: 0.45, weight: 1.5,
    }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong');
    h.textContent = `${c.comuna} — ${c.clientes.toLocaleString('es-CL')} clientes afectados`;
    box.appendChild(h);
    if (c.empresas.length) {
      const small = document.createElement('small');
      small.textContent = c.empresas.join(' · ');
      box.appendChild(small);
    }
    const fragFecha = actualizadoTexto(cortesData.updated, cortesData.stale);
    if (fragFecha) {
      const fecha = document.createElement('small');
      fecha.textContent = fragFecha;
      box.appendChild(fecha);
    }
    marker.bindPopup(box, { maxWidth: 260 });
  });
  const stale = cortesData.stale ? ' · datos antiguos (satélite sin actualizar)' : '';
  // Guarda de plausibilidad (ingesta/cortes.py): ciclo SEC degradado retenido
  // o degradación sostenida — mismo patrón que sufijoParcial en paintVolcanes.
  const parcial = cortesData.parcial ? ` · ${cortesData.nota || 'datos posiblemente incompletos'}` : '';
  $('#map-meta').textContent = cortesData.updated
    ? `${cortesData.n_comunas} comunas con cortes · SEC best effort · ${horaLocal(cortesData.updated.replace(' UTC', 'Z').replace(' ', 'T'))} h${stale}${parcial}`
    : `${cortesData.n_comunas} comunas con cortes · SEC best effort${stale}${parcial}`;
}

// Colores de los 6 <Style> fijos del KML de Esval (AMARILLO/AZUL/CELESTE/
// MORADO/ROJO/VERDE): se reutilizan tokens de color ya existentes en vez de
// definir variables CSS nuevas solo para esta capa (semánticamente cercanos,
// no una copia exacta del hex del KML — ver ingesta/esval.py, "estilo" es el
// nombre, no el color real). ROJO/AMARILLO calzan con las alertas SENAPRED;
// VERDE con el semáforo volcánico; AZUL/CELESTE con las tarjetas de marea;
// MORADO con la escala de precipitación severa.
const ESVAL_COLOR_VAR = {
  ROJO: '--alerta-roja', AMARILLO: '--alerta-amarilla', VERDE: '--vol-verde',
  AZUL: '--marea-sube', CELESTE: '--marea-baja', MORADO: '--pp-alto',
};

// Zonas de corte de agua Esval (V Región): polígonos KML, mismo patrón de
// pintado que paintEvacuacion (tsunami_areas) — colorScope por estilo en vez
// de un color fijo único, porque acá SÍ varía según el <Style> del KML.
function paintEsval(group) {
  const zonas = (esvalData && esvalData.zonas) || [];
  if (!zonas.length) {
    if (capasActivas.size === 1) {
      $('#map-meta').textContent = textoVacio('esval', metaConFecha('Sin cortes de agua informados · Esval (V Región)', esvalData && esvalData.updated, esvalData && esvalData.stale));
    }
    return;
  }
  zonas.forEach((z) => {
    if (!Array.isArray(z.poligono) || z.poligono.length < 3) return;
    const color = css(ESVAL_COLOR_VAR[z.estilo] || '--accent2');
    const poly = L.polygon(z.poligono, { color, weight: 2, opacity: 0.85, fillColor: color, fillOpacity: 0.3 }).addTo(group);
    const box = document.createElement('div');
    box.className = 'stn-popup';
    const h = document.createElement('strong');
    h.textContent = z.nombre || 'Zona de corte de agua';
    box.appendChild(h);
    if (z.descripcion) {
      const small = document.createElement('small');
      small.textContent = z.descripcion;
      box.appendChild(small);
    }
    if (z.atributos && Object.keys(z.atributos).length) {
      const small = document.createElement('small');
      small.textContent = Object.entries(z.atributos).map(([k, v]) => `${k}: ${v}`).join(' · ');
      box.appendChild(small);
    }
    const fragFecha = actualizadoTexto(esvalData.updated, esvalData.stale);
    if (fragFecha) {
      const fecha = document.createElement('small');
      fecha.textContent = fragFecha;
      box.appendChild(fecha);
    }
    poly.bindPopup(box, { maxWidth: 260 });
  });
  $('#map-meta').textContent = metaConFecha(`${zonas.length} zona(s) con corte de agua · Esval (V Región) best effort`, esvalData.updated, esvalData.stale);
}

const PRECIO_COMBUSTIBLE_LABEL = {
  gasolina_93: '93', gasolina_95: '95', gasolina_97: '97', diesel: 'Diésel', glp: 'GLP',
};

function formatoClp(v) {
  return `$${Math.round(v).toLocaleString('es-CL')}`;
}

// precios[tipo] tolera dos formatos durante la transición: número plano (el
// shape viejo, por si un combustible.json ya generado no se ha vuelto a
// correr) o {precio, fecha} (el shape nuevo, con la fecha CNE de ESE precio).
function precioValor(entry) {
  if (entry == null) return null;
  return typeof entry === 'number' ? entry : entry.precio;
}

// "YYYY-MM-DD" (fecha_actualizacion de la CNE, sin hora) -> "DD-MM".
function ddmm(fechaYMD) {
  const [, m, d] = fechaYMD.split('-');
  return `${d}-${m}`;
}

// Días transcurridos desde una fecha "YYYY-MM-DD" (calendario, sin hora):
// suficiente para el umbral de "precio antiguo", no necesita precisión TZ.
function diasDesdeFecha(fechaYMD) {
  const [y, m, d] = fechaYMD.split('-').map(Number);
  return Math.floor((Date.now() - Date.UTC(y, m - 1, d)) / 86400000);
}

// Precio antiguo: más de 14 días desde que la CNE lo actualizó por última
// vez para ese combustible en esa estación.
const PRECIO_ANTIGUO_DIAS = 14;

// Popup completo (nombre + comuna + tabla de precios) de una estación —
// compartido entre el modo individual (zoom >= 13) y el caso de una celda
// con una sola estación (zoom 9-12), para no duplicar esta lógica.
function popupEstacionCombustible(e) {
  const nombre = e.nombre || e.marca || 'Estación de servicio';
  const box = cajaPopup(nombre);
  if (e.comuna) {
    const small = document.createElement('small');
    small.textContent = e.marca && e.nombre ? `${e.marca} · ${e.comuna}` : e.comuna;
    box.appendChild(small);
  }
  // combustible.json ya generados en prod pueden no traer este campo hasta
  // la próxima corrida de ingesta: solo se muestra si viene.
  if (e.direccion) {
    const dir = document.createElement('small');
    dir.textContent = e.direccion;
    box.appendChild(dir);
  }
  const precios = e.precios || {};
  box.appendChild(popupRows(Object.keys(PRECIO_COMBUSTIBLE_LABEL)
    .filter((k) => precioValor(precios[k]) != null)
    .map((k) => {
      const entry = precios[k];
      const valor = precioValor(entry);
      const fecha = entry && typeof entry === 'object' ? entry.fecha : null;
      if (!fecha) return [PRECIO_COMBUSTIBLE_LABEL[k], formatoClp(valor)];
      const antiguo = diasDesdeFecha(fecha) > PRECIO_ANTIGUO_DIAS;
      const texto = `${formatoClp(valor)} (al ${ddmm(fecha)})${antiguo ? ' ⚠ precio antiguo' : ''}`;
      return [PRECIO_COMBUSTIBLE_LABEL[k], texto];
    })));
  box.appendChild(enlaceComoLlegar(e.lat, e.lon));
  return box;
}

// combustible.json: dormida sin CNE_API_KEY (n=0 o archivo ausente) → misma
// nota que "capa en preparación", no un error. Con datos, tres escalas
// (mismo patrón de zoom que paintRemociones/paintIncendios, 1.768
// estaciones son ilegibles a escala país):
//   zoom < 9:  una celda ⛽N por zona, toca para acercar (como antes).
//   zoom 9-12: agrupado por celda pero mostrando el precio 93 más barato
//     de la celda (lo que el usuario busca al alejar el mapa es "dónde está
//     lo más barato por acá", no una etiqueta por cada bomba); si la celda
//     tiene 1 sola estación se comporta como el modo individual.
//   zoom >= 13: estación por estación (como antes).
// Antes de este fix, zoom >= 9 pintaba una etiqueta .stn-label POR ESTACIÓN
// sin agrupar: en zonas densas (Valparaíso/Viña) se encimaban entre 9 y 12.
function paintCombustible(group) {
  const estaciones = (combustibleData && combustibleData.estaciones) || [];
  if (!estaciones.length) {
    if (capasActivas.size === 1) $('#map-meta').textContent = textoVacio('combustible', 'combustible: capa en preparación (sin datos todavía)');
    return;
  }
  const bounds = map.getBounds().pad(0.3);
  const visibles = estaciones.filter((e) => bounds.contains([e.lat, e.lon]));
  const zoom = map.getZoom();
  if (zoom < 9) {
    const grupos = agruparPorCelda(visibles, 48).sort((a, b) => a.length - b.length);
    grupos.forEach((grupo) => {
      const lat = grupo.reduce((s, p) => s + p.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, p) => s + p.lon, 0) / grupo.length;
      const marker = pintarMarcador(group, {
        lat, lon, clase: 'stn-icon',
        html: `<span class="stn-label combustible-precio">⛽<b>${grupo.length}</b></span>`,
        tam: [44, 26], titulo: `${grupo.length} estaciones de servicio — toca para acercar`,
      });
      marker.on('click', () => map.setView([lat, lon], zoom + 2));
    });
  } else if (zoom <= 12) {
    const grupos = agruparPorCelda(visibles, 46).sort((a, b) => a.length - b.length);
    grupos.forEach((grupo) => {
      const lat = grupo.reduce((s, p) => s + p.lat, 0) / grupo.length;
      const lon = grupo.reduce((s, p) => s + p.lon, 0) / grupo.length;
      const precios93 = grupo
        .map((e) => precioValor(e.precios && e.precios.gasolina_93))
        .filter((v) => v != null);
      const masBarato = precios93.length ? Math.min(...precios93) : null;
      const label = masBarato != null ? Math.round(masBarato) : '⛽';
      const esGrupo = grupo.length > 1;
      const titulo = esGrupo
        ? `${grupo.length} estaciones — 93 desde ${masBarato != null ? formatoClp(masBarato) : '—'}`
        : (grupo[0].nombre || grupo[0].marca || 'Estación de servicio');
      let box;
      if (!esGrupo) {
        box = popupEstacionCombustible(grupo[0]);
      } else {
        box = cajaPopup(`${grupo.length} estaciones en esta zona`);
        const ordenado = [...grupo].sort((a, b) => {
          const pa = precioValor(a.precios && a.precios.gasolina_93);
          const pb = precioValor(b.precios && b.precios.gasolina_93);
          if (pa == null) return pb == null ? 0 : 1;
          if (pb == null) return -1;
          return pa - pb;
        });
        box.appendChild(popupRows(ordenado.map((e) => {
          const p = precioValor(e.precios && e.precios.gasolina_93);
          return [e.nombre || e.marca || 'Estación', p != null ? formatoClp(p) : '—'];
        })));
      }
      pintarMarcador(group, {
        lat, lon, clase: 'stn-icon',
        html: `<span class="stn-label combustible-precio">${label}${esGrupo ? ` <b>×${grupo.length}</b>` : ''}</span>`,
        tam: [56, 26], titulo, popup: box, maxWidth: esGrupo ? 280 : 260,
      });
    });
  } else {
    visibles.forEach((e) => {
      const precio93 = precioValor(e.precios && e.precios.gasolina_93);
      pintarMarcador(group, {
        lat: e.lat, lon: e.lon, clase: 'stn-icon',
        html: `<span class="stn-label combustible-precio">${precio93 != null ? Math.round(precio93) : '⛽'}</span>`,
        tam: [44, 26], titulo: e.nombre || e.marca || 'Estación de servicio',
        popup: popupEstacionCombustible(e),
      });
    });
  }
  $('#map-meta').textContent = metaConFecha(`${estaciones.length} estaciones con precios · CNE Bencina en Línea`, combustibleData.updated);
}

// Marcador de "mi ubicación" para el botón 📍 Centrar: un punto + círculo de
// precisión (accuracy en metros de la propia geolocalización), reemplazado
// entero cada vez que se vuelve a tocar el botón. Igual que "Mi punto de
// encuentro" (setupPuntoCercano), la geolocalización se pide solo con este
// gesto explícito y no se guarda en localStorage ni en ninguna otra parte.
function pintarMiUbicacion(lat, lon, accuracy) {
  if (miUbicacionLayer) map.removeLayer(miUbicacionLayer);
  const color = css('--accent2');
  const icon = L.divIcon({
    className: 'miubicacion-icon',
    html: '<span class="miubicacion-dot"></span>',
    iconSize: [14, 14], iconAnchor: [7, 7],
  });
  miUbicacionLayer = L.layerGroup([
    L.circle([lat, lon], { radius: accuracy, color, weight: 1, fillColor: color, fillOpacity: 0.08 }),
    L.marker([lat, lon], { icon, title: 'Tu ubicación', zIndexOffset: 1000 }),
  ]).addTo(map);
}

// Pide la ubicación con reintento, compartido por todo gesto que la necesite
// (centrar el mapa, punto de encuentro más cercano). Primer intento por red
// (rápido pero en desktop 10 s se quedaba corto y descartaba posiciones
// cacheadas útiles): 20 s de plazo y acepta una posición de hasta 5 min de
// antigüedad, de sobra para centrar un mapa. Si falla por falta de señal o
// timeout, reintenta UNA vez forzando el GPS (enableHighAccuracy) — en móvil
// eso suele resolver donde la ubicación por red falla, y en desktop no
// empeora nada. `msg` es el contenedor de estado a actualizar durante el
// reintento para que el usuario no crea que el botón murió.
function obtenerPosicion(msg, onOk, onErr) {
  const intentar = (opciones, permiteReintento) => {
    navigator.geolocation.getCurrentPosition(
      onOk,
      (err) => {
        if (permiteReintento && (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE)) {
          if (msg) msg.textContent = 'Buscando tu ubicación… reintentando con GPS';
          intentar({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }, false);
          return;
        }
        onErr(err);
      },
      opciones,
    );
  };
  intentar({ enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 }, true);
}

function centrarEnMiUbicacion() {
  const msg = document.getElementById('map-locate-msg');
  if (!ensureMap() || !msg) return;
  if (!('geolocation' in navigator)) {
    msg.hidden = false;
    msg.textContent = 'Tu navegador no permite geolocalización.';
    return;
  }
  msg.hidden = false;
  msg.textContent = 'Buscando tu ubicación…';
  obtenerPosicion(
    msg,
    (pos) => {
      const { latitude, longitude, accuracy } = pos.coords;
      msg.hidden = true;
      map.setView([latitude, longitude], 16); // nivel calle, no de comuna
      pintarMiUbicacion(latitude, longitude, accuracy);
    },
    (err) => mostrarErrorGeolocation(err, msg),
  );
}

function setupCapas() {
  document.querySelectorAll('.map-mode[data-capa]').forEach((btn) => {
    btn.addEventListener('click', () => toggleCapa(btn.dataset.capa));
  });
  // "Chile": no es una capa que se prende/apaga, es una acción de encuadre —
  // ajusta el zoom a las estaciones continentales y no toca capasActivas.
  const chileBtn = document.querySelector('.map-chile');
  if (chileBtn) {
    chileBtn.addEventListener('click', () => {
      if (!ensureMap() || !estacionesData) return;
      const continental = estacionesData.estaciones.filter((e) => e.lon > -80 && e.lat > -57);
      if (!continental.length) return;
      const bounds = L.latLngBounds(continental.map((e) => [e.lat, e.lon]));
      map.fitBounds(bounds.pad(0.12), { maxZoom: 9 });
    });
  }
  const playBtn = document.getElementById('satelite-play');
  if (playBtn) playBtn.addEventListener('click', toggleReproduccionSatelite);
  const basemapBtn = document.getElementById('basemap-toggle');
  if (basemapBtn) basemapBtn.addEventListener('click', toggleBasemap);
  const locateBtn = document.getElementById('map-locate-btn');
  if (locateBtn) locateBtn.addEventListener('click', centrarEnMiUbicacion);
}

// Pantalla completa: sobre el panel entero (no solo #map) para que la
// leyenda y los toggles de capas sigan visibles y usables. Fullscreen API
// nativa con fallback a una clase fija (.map-max) cuando no está disponible
// (p.ej. Safari iOS en modo PWA instalada).
function setupMapaFullscreen() {
  const btn = document.getElementById('map-fullscreen-btn');
  const panel = document.getElementById('map-panel');
  if (!btn || !panel) return;

  const activo = () => document.fullscreenElement === panel || panel.classList.contains('map-max');

  function actualizarBoton() {
    const on = activo();
    btn.setAttribute('aria-pressed', String(on));
    btn.setAttribute('aria-label', on ? 'Salir de pantalla completa' : 'Mapa a pantalla completa');
    btn.textContent = on ? '✕ Salir' : '⛶ Pantalla completa';
  }

  function onEsc(e) {
    if (e.key === 'Escape') salirFallback();
  }

  function salirFallback() {
    panel.classList.remove('map-max');
    document.removeEventListener('keydown', onEsc);
    actualizarBoton();
    if (map) map.invalidateSize();
  }

  function entrarFallback() {
    panel.classList.add('map-max');
    document.addEventListener('keydown', onEsc);
    actualizarBoton();
    if (map) map.invalidateSize();
  }

  btn.addEventListener('click', () => {
    if (activo()) {
      if (document.fullscreenElement) document.exitFullscreen();
      else salirFallback();
      return;
    }
    if (panel.requestFullscreen) {
      panel.requestFullscreen().catch(entrarFallback);
    } else {
      entrarFallback();
    }
  });

  // fullscreenchange cubre tanto la entrada como la salida nativa (incluido
  // el Esc que el navegador maneja solo): siempre se re-sincroniza el botón
  // y se recalcula el tamaño del mapa.
  document.addEventListener('fullscreenchange', () => {
    actualizarBoton();
    if (map) map.invalidateSize();
  });
}

// ── Centro de riesgos: badge + panel resumen ───────────────────
// Junta en un solo lugar lo que ya cargan loadSismos/loadIncendios/
// loadAlertas/loadVolcanes; no vuelve a pedir datos, solo los resume.

const VOL_RANK = { amarilla: 1, naranja: 2, roja: 3 };

// Distancia entre dos puntos (haversine, radio terrestre 6371 km).
// Misma fórmula que ingesta/sismos.py _dist_km.
function distKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180, p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180, dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function savedRiesgoAmbito() {
  try {
    const v = localStorage.getItem('sinoptica.riesgoAmbito');
    if (v === 'chile' || v === 'cerca') return v;
  } catch (_) { /* localStorage puede no estar disponible */ }
  return 'chile';
}

let riesgoAmbito = savedRiesgoAmbito();

// Nombre de región tal como lo entrega SENAPRED (campo REGION del ArcGIS,
// ver ingesta/alertas.py) → código de comunas.json. Verificado 2026-07-17
// contra un alertas.json real de producción (16 regiones, todas presentes).
// Otros generadores (crecidas.py, cortes.py) también traen un campo
// `region`, pero con formatos distintos (nombres cortos o el código directo)
// — por eso esta tabla solo se usa para alertas, nunca genérico.
const REGION_SENAPRED_A_COD = {
  'Arica y Parinacota': 'XV',
  'Tarapacá': 'I',
  'Antofagasta': 'II',
  'Atacama': 'III',
  'Coquimbo': 'IV',
  'Valparaíso': 'V',
  'Metropolitana de Santiago': 'RM',
  "Libertador General Bernardo O'Higgins": 'VI',
  'Maule': 'VII',
  'Ñuble': 'XVI',
  'Biobío': 'VIII',
  'La Araucanía': 'IX',
  'Los Ríos': 'XIV',
  'Los Lagos': 'X',
  'Aysén del General Carlos Ibáñez del Campo': 'XI',
  'Magallanes y de la Antártica Chilena': 'XII',
};

// Región (código de comunas.json) de la comuna cuyo centroide está más
// cerca de (lat, lon). Recorrer las 345 comunas es barato (una vez por
// ítem filtrado, no por frame). Sin comunas.json cargado o sin coordenadas,
// null — el llamador decide qué hacer (ver enAmbito).
function regionDe(lat, lon) {
  if (!comunasData || lat == null || lon == null) return null;
  let mejor = null, mejorD = Infinity;
  for (const c of comunasData.comunas) {
    const d = distKm(lat, lon, c.lat, c.lon);
    if (d < mejorD) { mejorD = d; mejor = c; }
  }
  return mejor ? mejor.r : null;
}

// Recalcula y cachea la región del lugar seleccionado (setPlace y
// cargarComunas la llaman; enAmbito solo lee placeRegionCod, nunca la
// recalcula por ítem).
function actualizarPlaceRegion() {
  placeRegionCod = regionDe(place.lat, place.lon);
}

// Modo 'cerca': el ítem entra solo si su región coincide con la del lugar
// seleccionado (antes era un radio fijo de 200 km, que dejaba entrar p.ej.
// Illapel — Región de Coquimbo — al filtrar por Viña del Mar). Para alertas
// SENAPRED se prefiere su campo `region` explícito (más preciso que el
// centroide de la alerta, que puede caer en la comuna vecina); el resto de
// los ítems, y cualquier alerta cuyo nombre de región no matchee la tabla,
// usan regionDe(lat, lon). Ítems sin región determinable (sin lat/lon, o
// comunas.json aún no cargado) quedan excluidos: mejor omitir de más que
// mostrar algo que podría ser de otra región. Mientras comunas.json no haya
// cargado, placeRegionCod es null y esto excluye TODO transitoriamente — ver
// el disparo de cargarComunas() en renderRiesgos(), que vuelve a renderizar
// el panel apenas el catastro esté listo.
function enAmbito(it, ambito = riesgoAmbito, esAlerta = false) {
  if (ambito === 'chile') return true;
  if (!placeRegionCod) return false;
  const regionItem = (esAlerta && it.region && REGION_SENAPRED_A_COD[it.region])
    || regionDe(it.lat, it.lon);
  return regionItem === placeRegionCod;
}

// True mientras el modo 'cerca' no tiene región resuelta para el lugar
// seleccionado (comunas.json sin cargar aún, o su carga falló). En ese
// estado `enAmbito` excluye TODO, así que "0 eventos" no es un dato: sería
// un all-clear no verificado (honestidad de frescura, regla dura #8). Los
// renders del panel usan este helper para mostrar "verificando" en vez de
// ceros — nunca 🟢. Se resuelve solo cuando cargarComunas() completa y
// vuelve a llamar renderRiesgos().
function catastroPendiente() {
  return riesgoAmbito === 'cerca' && !placeRegionCod;
}

// ambito es parámetro (no siempre el global) porque el badge nacional necesita
// las cuentas SIN filtrar por cercanía aunque el panel esté en modo 'cerca'.
function riesgoCounts(ambito = riesgoAmbito) {
  const ahora = Date.now();
  const sismos24 = sismosData
    ? sismosData.eventos.filter((e) => e.mag >= 4 && ahora - new Date(e.utc_time).getTime() <= 24 * 3600e3 && enAmbito(e, ambito))
    : [];
  const sismoMax6 = sismos24.filter((e) => e.mag >= 6).sort((a, b) => b.mag - a.mag)[0] || null;
  const alertas = alertasData ? alertasData.alertas.filter((a) => enAmbito(a, ambito, true)) : [];
  const rojas = alertas.filter((a) => a.nivel === 'roja').length;
  const amarillas = alertas.filter((a) => a.nivel === 'amarilla').length;
  const alertaRoja = alertas.find((a) => a.nivel === 'roja' && a.lat != null && a.lon != null) || null;
  const volcanesAlerta = volcanesData ? volcanesData.volcanes.filter((v) => v.nivel !== 'verde' && enAmbito(v, ambito)) : [];
  const volPeor = volcanesAlerta.reduce((peor, v) => (VOL_RANK[v.nivel] > (VOL_RANK[peor] || 0) ? v.nivel : peor), null);
  const volcanPeor = volPeor ? volcanesAlerta.find((v) => v.nivel === volPeor) || null : null;
  const incendiosN = incendiosData
    ? (ambito === 'cerca' ? (incendiosData.focos || []).filter((f) => enAmbito(f, ambito)).length : incendiosData.n)
    : 0;
  // Avisos meteo: conteo aparte (5.º tile), nunca mezclado con las 4 fuentes
  // oficiales de arriba — son una derivación propia, no un aviso oficial.
  const avisos = avisosData ? avisosData.avisos.filter((a) => enAmbito(a, ambito)) : [];
  const avisoAlto = avisos.some((a) => a.nivel === 'naranja' || a.nivel === 'rojo');
  // Cortes SEC: conteo de comunas afectadas (no de clientes, para que el
  // número calce con "toca para ver el detalle" del tile). Alto si alguna
  // comuna del ámbito supera 10.000 clientes afectados.
  const cortes = cortesData ? cortesData.cortes.filter((c) => enAmbito(c, ambito)) : [];
  const cortesAlto = cortes.some((c) => c.clientes > 10000);
  // Crecidas GloFAS: conteo de ríos con nivel (amarillo/naranja/rojo), no
  // oficial — mismo criterio que avisoAlto para el color del tile.
  const crecidas = crecidasData ? crecidasData.puntos.filter((p) => p.nivel && enAmbito(p, ambito)) : [];
  const crecidaAlta = crecidas.some((p) => p.nivel === 'naranja' || p.nivel === 'rojo');
  return {
    sismos24, sismoMax6, rojas, amarillas, alertaRoja, volcanesAlerta, volPeor, volcanPeor,
    incendiosN, avisosN: avisos.length, avisoAlto, cortesN: cortes.length, cortesAlto,
    crecidasN: crecidas.length, crecidaAlta,
  };
}

const RT_IDS = ['#rt-sismos', '#rt-incendios', '#rt-alertas', '#rt-volcanes', '#rt-avisos', '#rt-cortes', '#rt-crecidas'];

function renderRiesgoTiles(c) {
  const set = (id, val, cls) => {
    const el = $(id);
    el.textContent = val;
    el.classList.remove('rt-alto', 'rt-medio', 'rt-cero', 'rt-pendiente');
    el.classList.add(cls);
  };
  if (catastroPendiente()) {
    // Sin región resuelta todavía: '…' neutro, nunca '0' (que leería como
    // "verificado y sin riesgo"). cargarComunas() re-renderiza solo al llegar.
    RT_IDS.forEach((id) => set(id, '…', 'rt-pendiente'));
    return;
  }
  const sismoAlto = c.sismos24.some((e) => e.mag >= 5);
  set('#rt-sismos', c.sismos24.length, sismoAlto ? 'rt-alto' : c.sismos24.length > 0 ? 'rt-medio' : 'rt-cero');
  set('#rt-incendios', c.incendiosN, c.incendiosN > 0 ? 'rt-medio' : 'rt-cero');
  const alertasTxt = c.rojas > 0 ? `${c.rojas}R ${c.amarillas}A` : c.amarillas > 0 ? `${c.amarillas}A` : '0';
  set('#rt-alertas', alertasTxt, c.rojas > 0 ? 'rt-alto' : c.amarillas > 0 ? 'rt-medio' : 'rt-cero');
  const volAlto = c.volPeor === 'naranja' || c.volPeor === 'roja';
  set('#rt-volcanes', c.volcanesAlerta.length, volAlto ? 'rt-alto' : c.volPeor === 'amarilla' ? 'rt-medio' : 'rt-cero');
  set('#rt-avisos', c.avisosN, c.avisoAlto ? 'rt-alto' : c.avisosN > 0 ? 'rt-medio' : 'rt-cero');
  set('#rt-cortes', c.cortesN, c.cortesAlto ? 'rt-alto' : c.cortesN > 0 ? 'rt-medio' : 'rt-cero');
  set('#rt-crecidas', c.crecidasN, c.crecidaAlta ? 'rt-alto' : c.crecidasN > 0 ? 'rt-medio' : 'rt-cero');
}

// DD-MM-AAAA (formato de SENAPRED) → Date; null si no calza.
function parseFechaAlerta(desde) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(desde || '');
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])) : null;
}

// Top de eventos por severidad: alertas SENAPRED, volcanes fuera de verde y
// sismos M≥4.5 de las últimas 48 h. Cada rama ya produce solo scores ≥ 30.
function riesgoEventos() {
  const ahora = Date.now();
  const items = [];

  for (const a of alertasData ? alertasData.alertas : []) {
    const fecha = parseFechaAlerta(a.desde);
    let score;
    if (a.nivel === 'roja') score = 100;
    else if (a.nivel === 'amarilla') score = 60;
    else if (a.nivel === 'temprana_preventiva') {
      // Una ATP puede llevar meses vigente: pasado ese punto es contexto de
      // fondo, no noticia, así que baja bajo los avisos meteo (25) — estos
      // siempre describen las próximas horas. Sin fecha parseable, se trata
      // como antigua (mismo criterio conservador).
      const diasVigente = fecha ? (ahora - fecha.getTime()) / 86400e3 : Infinity;
      score = diasVigente > 30 ? 15 : 30;
    } else score = 0;
    if (!score) continue;
    items.push({
      score, fecha, capa: 'alertas', lat: a.lat, lon: a.lon, region: a.region,
      emoji: emojiEvento(a.evento),
      texto: `${NIVEL_ALERTA_LABEL[a.nivel] || a.nivel} · ${a.evento} · ${a.region} (${a.n_comunas} comuna${a.n_comunas === 1 ? '' : 's'})`,
    });
  }

  for (const v of volcanesData ? volcanesData.volcanes : []) {
    if (v.nivel === 'verde') continue;
    const score = v.nivel === 'roja' ? 95 : v.nivel === 'naranja' ? 80 : v.nivel === 'amarilla' ? 55 : 0;
    if (!score) continue;
    items.push({
      score, fecha: null, capa: 'volcanes', lat: v.lat, lon: v.lon,
      emoji: '🌋', texto: `Volcán ${v.nombre} · alerta ${v.nivel}`,
    });
  }

  for (const e of sismosData ? sismosData.eventos : []) {
    if (e.mag < 4.5) continue;
    const edadMs = ahora - new Date(e.utc_time).getTime();
    if (edadMs > 48 * 3600e3) continue;
    let score = 20 + e.mag * 5 + (edadMs < 6 * 3600e3 ? 20 : 0);
    if (e.pager === 'orange') score += 30;
    else if (e.pager === 'red') score += 50;
    items.push({
      score, fecha: new Date(e.utc_time), capa: 'sismos', lat: e.lat, lon: e.lon,
      emoji: '〰️', texto: `M ${e.mag} · ${e.ref}`, pager: e.pager,
    });
  }

  // Avisos meteo: entran al top-10 con menos score que un evento oficial
  // (65 rojo / 45 naranja / 25 amarillo) — son una derivación propia, no oficial.
  for (const a of avisosData ? avisosData.avisos : []) {
    items.push({
      score: a.nivel === 'rojo' ? 65 : a.nivel === 'naranja' ? 45 : 25,
      fecha: null, capa: 'avisos', lat: a.lat, lon: a.lon,
      emoji: AVISO_EMOJI[a.tipo] || '⚠️',
      texto: `${AVISO_TIPO_LABEL[a.tipo] || a.tipo} ${a.nivel} · ${a.nombre} · ${r1(a.valor)} ${a.unidad}`,
    });
  }

  const filtrados = items.filter((it) => enAmbito(it, riesgoAmbito, it.capa === 'alertas'));
  filtrados.sort((a, b) => b.score - a.score || (b.fecha?.getTime() || 0) - (a.fecha?.getTime() || 0));
  return filtrados.slice(0, 10);
}

function renderRiesgoEventos() {
  const ol = $('#riesgo-eventos');
  ol.innerHTML = '';
  if (catastroPendiente()) {
    // Sin región resuelta todavía no hay "sin eventos" honesto que mostrar
    // (ver catastroPendiente): ni ceros ni 🟢, un estado explícito de espera.
    const li = document.createElement('li');
    li.className = 'riesgo-vacio';
    li.textContent = `Verificando tu región para mostrar lo cercano a ${place.name}…`;
    ol.appendChild(li);
    return;
  }
  const items = riesgoEventos();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'riesgo-vacio';
    li.textContent = riesgoAmbito === 'cerca'
      ? `Sin alertas ni eventos significativos cerca de ${place.name}. 🟢`
      : 'Sin alertas ni eventos significativos ahora. 🟢';
    ol.appendChild(li);
    return;
  }
  items.forEach((it) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'riesgo-item';
    const texto = document.createElement('span');
    texto.className = 'ri-text';
    texto.textContent = `${it.emoji} ${it.texto}`;
    btn.appendChild(texto);
    if (it.fecha) {
      const time = document.createElement('time');
      time.textContent = haceCuanto(it.fecha);
      btn.appendChild(time);
    }
    btn.addEventListener('click', () => {
      if (!capasActivas.has(it.capa)) toggleCapa(it.capa);
      if (it.lat != null && it.lon != null && ensureMap()) map.setView([it.lat, it.lon], 8);
      document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    li.appendChild(btn);
    if (it.pager) li.appendChild(pagerChip(it.pager));
    ol.appendChild(li);
  });
}

function renderRiskBadge(c) {
  const badge = $('#risk-badge');
  let texto = null, aria = null, capa = null, evento = null;
  if (c.rojas > 0) {
    texto = `⚠ ${c.rojas} alerta${c.rojas > 1 ? 's' : ''} roja${c.rojas > 1 ? 's' : ''}`;
    aria = `${c.rojas} alerta(s) roja(s) de SENAPRED vigentes`;
    capa = 'alertas';
    evento = c.alertaRoja;
  } else if (c.volPeor === 'naranja' || c.volPeor === 'roja') {
    texto = `🌋 volcán en ${c.volPeor}`;
    aria = `Volcán en alerta técnica ${c.volPeor}`;
    capa = 'volcanes';
    evento = c.volcanPeor;
  } else if (c.sismoMax6) {
    texto = `〰️ sismo M${c.sismoMax6.mag} hoy`;
    aria = `Sismo de magnitud ${c.sismoMax6.mag} en las últimas 24 horas`;
    capa = 'sismos';
    evento = c.sismoMax6;
  }
  badge.hidden = !texto;
  if (texto) {
    badge.textContent = texto; badge.setAttribute('aria-label', aria); badge.dataset.capa = capa;
    if (evento && evento.lat != null && evento.lon != null) {
      badge.dataset.lat = String(evento.lat);
      badge.dataset.lon = String(evento.lon);
    } else {
      delete badge.dataset.lat;
      delete badge.dataset.lon;
    }
  }
}

function renderRiesgos() {
  const panel = document.querySelector('.panel-riesgos');
  if (!panel) return;
  // Modo 'cerca' necesita comunas.json para saber la región de cada ítem;
  // si aún no cargó, se dispara aquí (mismo patrón lazy que la capa de
  // alertas del mapa) y este render deja todo excluido de "cerca" hasta que
  // llegue — cargarComunas() vuelve a llamar renderRiesgos() al terminar.
  if (riesgoAmbito === 'cerca' && !comunasData) cargarComunas();
  const hayAlgo = !!(sismosData || incendiosData || alertasData || volcanesData || avisosData || cortesData || crecidasData);
  // Fuentes de este panel que fallaron y siguen sin dato: si TODAS fallan el
  // panel no puede quedar oculto en silencio (antes: panel.hidden ocultaba
  // por igual "sin eventos" y "no cargó nada"), y si solo ALGUNAS fallan se
  // avisa en la meta junto a las que sí llegaron.
  const RIESGO_CAPAS = ['sismos', 'incendios', 'alertas', 'volcanes', 'avisos', 'cortes', 'crecidas'];
  const fallidas = RIESGO_CAPAS.filter((c) => cargasFallidas.has(c));
  panel.hidden = !hayAlgo && !fallidas.length;
  if (!hayAlgo) {
    $('#risk-badge').hidden = true;
    if (fallidas.length) {
      panel.querySelectorAll('.riesgo-tile[data-capa]').forEach((b) => { b.hidden = true; });
      $('#riesgos-meta').textContent = '';
      const ol = $('#riesgo-eventos');
      ol.innerHTML = '';
      const li = document.createElement('li');
      li.className = 'riesgo-vacio';
      li.textContent = notaFallo(fallidas);
      ol.appendChild(li);
    }
    return;
  }

  panel.querySelector('[data-capa="sismos"]').hidden = !sismosData;
  panel.querySelector('[data-capa="incendios"]').hidden = !incendiosData;
  panel.querySelector('[data-capa="alertas"]').hidden = !alertasData;
  panel.querySelector('[data-capa="volcanes"]').hidden = !volcanesData;
  panel.querySelector('[data-capa="avisos"]').hidden = !avisosData;
  panel.querySelector('[data-capa="crecidas"]').hidden = !crecidasData;
  panel.querySelector('[data-capa="cortes"]').hidden = !cortesData;

  const metaFallidas = fallidas.length ? ` · no se pudieron cargar: ${fallidas.map((c) => CAPA_LABEL[c] || c).join(', ')}` : '';
  $('#riesgos-meta').textContent = [
    ['CSN', sismosData], ['SENAPRED', alertasData], ['SERNAGEOMIN', volcanesData], ['NASA FIRMS', incendiosData],
    ['Vigía (no oficial)', avisosData], ['SEC (best effort)', cortesData], ['GloFAS (no oficial)', crecidasData],
  ].filter(([, ok]) => ok).map(([nombre]) => nombre).join(' · ') + metaFallidas;

  renderRiesgoTiles(riesgoCounts());
  renderRiesgoEventos();
  // El badge es SIEMPRE nacional (ámbito 'chile' explícito): decisión
  // 2026-07-17, reemplaza la del 10-07 (commit 295fdb7e) de que respetara
  // el ámbito del panel. Esa versión anterior podía ocultar una alerta roja,
  // un volcán en naranja/rojo o un sismo M≥6 con solo dejar el panel en
  // "cerca" de una región sin relación con el evento — el badge es la red de
  // seguridad de eventos graves y debe verse pase lo que pase en el panel,
  // incluso mientras el catastro todavía está "verificando tu región" (con
  // 'chile', enAmbito no depende de comunas.json). Al hacer clic, el panel
  // cambia a "Chile" (ver el handler de #risk-badge en setupRiesgos) para
  // que el evento anunciado sea visible ahí también, en vez de quedar
  // invisible si el panel seguía en "cerca".
  renderRiskBadge(riesgoCounts('chile'));
}

function actualizarLabelCerca() {
  const btn = $('#rf-cerca');
  if (btn) btn.textContent = `Cerca de ${place.name}`;
}

// Cambia el ámbito del panel de riesgo desde cualquier gesto (el toggle
// manual Chile/Cerca, o el clic en el badge de eventos graves): persiste en
// localStorage, refleja el estado en los botones del filtro y re-renderiza
// el panel. Único punto de esta lógica — no duplicarla en cada gesto que
// necesite cambiar de ámbito.
function cambiarAmbito(nuevo) {
  riesgoAmbito = nuevo;
  try { localStorage.setItem('sinoptica.riesgoAmbito', riesgoAmbito); } catch (_) { /* opcional */ }
  document.querySelectorAll('#riesgo-filtro-ambito .rf-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ambito === riesgoAmbito)));
  renderRiesgos();
}

function setupRiesgos() {
  document.querySelectorAll('.riesgo-tile[data-capa]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!capasActivas.has(btn.dataset.capa)) toggleCapa(btn.dataset.capa);
      document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
  $('#risk-badge').addEventListener('click', () => {
    const badge = $('#risk-badge');
    const capa = badge.dataset.capa;
    // El badge es nacional (ver renderRiesgos); si el panel está en 'cerca'
    // cambia a 'chile' para que el evento anunciado sea visible en el panel
    // en vez de quedar invisible por el filtro de región.
    if (riesgoAmbito === 'cerca') cambiarAmbito('chile');
    if (capa && !capasActivas.has(capa)) toggleCapa(capa);
    if (badge.dataset.lat !== undefined && badge.dataset.lon !== undefined && ensureMap()) {
      map.setView([Number(badge.dataset.lat), Number(badge.dataset.lon)], 8);
    }
    document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  document.querySelectorAll('#riesgo-filtro-ambito .rf-btn').forEach((btn) => {
    btn.setAttribute('aria-pressed', String(btn.dataset.ambito === riesgoAmbito));
    btn.addEventListener('click', () => cambiarAmbito(btn.dataset.ambito));
  });
  actualizarLabelCerca();
}

// Guía de error de geolocalización compartida por todo gesto que pida
// ubicación (punto de encuentro, centrar el mapa): permiso denegado muestra
// instrucciones por plataforma (Android/Chrome primero por ser lo más común
// en Chile, luego iOS, luego Safari de escritorio y por último Chrome/Firefox
// de escritorio; rutas según la ayuda oficial de Google Chrome y Apple,
// verificadas 2026-07), cualquier otro error muestra un mensaje genérico.
// `out` es cualquier contenedor donde renderizar el resultado.
function mostrarErrorGeolocation(err, out) {
  if (err.code === err.PERMISSION_DENIED) {
    const ua = navigator.userAgent;
    const esAndroid = /android/i.test(ua);
    const esIOS = /iphone|ipad|ipod/i.test(ua);
    // Safari de escritorio (macOS): Safari SIN motor Chromium/Firefox detrás
    // (Chrome, Edge y Firefox en Mac también llevan "Safari" en su UA).
    const esSafariMac = /macintosh/i.test(ua) && /safari/i.test(ua) && !/chrome|chromium|crios|firefox|edg/i.test(ua);
    const guias = [];
    if (esAndroid) {
      guias.push(
        'En Chrome: toca el ícono junto a la dirección del sitio (arriba, el candado o los controles) → Permisos → Ubicación → Permitir, y vuelve a tocar el botón.',
        'Si no aparece la opción: menú ⋮ (arriba a la derecha) → Configuración → Configuración de sitios → Ubicación → busca vigia.cavara.cl y permítelo.',
        'Revisa también que la Ubicación del teléfono esté encendida (desliza desde arriba y busca el ícono 📍 Ubicación).',
        'En Samsung Internet: menú ☰ → Ajustes → Sitios y descargas → Permisos de sitios → Ubicación.',
      );
    } else if (esIOS) {
      guias.push(
        'En Safari: toca "AA" o el ícono junto a la dirección → Configuración del sitio web → Ubicación → Permitir.',
        'Si no aparece: Ajustes del iPhone → Apps → Safari → Ubicación → «Preguntar» o «Permitir» (en Chrome del iPhone, busca Ajustes → Apps → Chrome en su lugar).',
        'Si la Localización está desactivada para todo el equipo: Ajustes → Privacidad y seguridad → Localización → activa el interruptor de arriba, y dentro de esa misma pantalla busca tu navegador y ponlo en «Preguntar» o «Al usar la app».',
      );
    } else if (esSafariMac) {
      guias.push(
        'En Safari: menú Safari → Ajustes → Sitios web → Ubicación → busca vigia.cavara.cl (o "En estos sitios web") y cambia a Permitir.',
        'Si no aparece ninguna opción: revisa que la Ubicación esté habilitada a nivel de sistema en Ajustes del Sistema → Privacidad y seguridad → Localización, y que Safari esté marcado ahí.',
      );
    } else {
      guias.push(
        'En Chrome: haz clic en el candado (o el ícono de controles) a la izquierda de la dirección → Configuración del sitio → Ubicación → Permitir, y recarga la página.',
        'En Firefox: clic en el candado → Permisos → Ubicación → quita el bloqueo, y recarga.',
      );
    }
    out.textContent = '';
    const p = document.createElement('p');
    p.textContent = 'Sin permiso de ubicación. Actívalo así:';
    const ul = document.createElement('ul');
    guias.forEach((t) => {
      const li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    out.append(p, ul);
    // La guía puede quedar bajo el pliegue (el botón "Centrar" está arriba
    // del mapa, la guía la desplaza hacia abajo): sin esto el usuario no la
    // veía y creía que el botón no hacía nada.
    out.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else {
    out.textContent = 'No se pudo obtener tu ubicación (sin señal de GPS o tardó demasiado). '
      + 'Revisa que la Ubicación del equipo esté encendida e inténtalo de nuevo.';
  }
}

// Punto de encuentro más cercano a la posición real del usuario, ante tsunami
// o ante erupción volcánica según el tipo elegido en el selector. Siempre se
// muestra el punto más cercano con su distancia (nunca se oculta por estar
// lejos): lejos solo agrega una nota aclaratoria. La geolocalización se pide
// solo con este gesto explícito (nunca automática) y se usa una única vez
// para calcular la distancia: no se guarda en localStorage ni en ninguna otra
// parte, por privacidad.
function setupPuntoCercano() {
  const btn = $('#btn-punto-cercano');
  const out = $('#punto-cercano-resultado');
  if (!btn || !out) return;
  let tipo = 'tsunami';

  document.querySelectorAll('#punto-tipo-filtro .rf-btn').forEach((b) => {
    b.addEventListener('click', () => {
      tipo = b.dataset.tipo;
      document.querySelectorAll('#punto-tipo-filtro .rf-btn').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
  });

  btn.addEventListener('click', () => {
    out.hidden = false;
    out.innerHTML = '';
    if (!('geolocation' in navigator)) {
      out.textContent = 'Tu navegador no permite geolocalización.';
      return;
    }
    out.textContent = 'Buscando tu ubicación…';
    obtenerPosicion(
      out,
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        if (!emergenciaData) {
          out.textContent = 'Cargando puntos de encuentro…';
          await loadEmergencia();
        }
        const categoria = tipo === 'volcan' ? 'encuentro_volcan' : 'encuentro_tsunami';
        const puntos = (emergenciaData && emergenciaData.categorias && emergenciaData.categorias[categoria]) || [];
        if (!puntos.length) {
          out.textContent = 'No hay datos de puntos de encuentro disponibles ahora mismo.';
          return;
        }
        let cercano = null, dist = Infinity;
        for (const p of puntos) {
          const d = distKm(latitude, longitude, p.lat, p.lon);
          if (d < dist) { dist = d; cercano = p; }
        }
        out.innerHTML = '';
        const texto = document.createElement('span');
        texto.textContent = `Tu punto de encuentro más cercano: ${cercano.n}${cercano.d ? ' · ' + cercano.d : ''} — a ${dist.toFixed(1)} km. `;
        out.appendChild(texto);
        if (tipo === 'tsunami' && dist > 30) {
          const nota = document.createElement('p');
          nota.textContent = `Estás a ~${Math.round(dist)} km de la costa: sin riesgo directo de tsunami en tu ubicación.`;
          out.appendChild(nota);
        } else if (tipo === 'volcan' && dist > 100) {
          const nota = document.createElement('p');
          nota.textContent = 'No estás cerca de una zona con rutas de evacuación volcánica.';
          out.appendChild(nota);
        }
        const verBtn = document.createElement('button');
        verBtn.className = 'chip';
        verBtn.textContent = 'ver en el mapa';
        verBtn.addEventListener('click', () => {
          if (!capasActivas.has('emergencia')) toggleCapa('emergencia');
          if (ensureMap()) map.setView([cercano.lat, cercano.lon], 15);
          document.querySelector('#map').closest('.panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        out.appendChild(verBtn);
      },
      (err) => mostrarErrorGeolocation(err, out),
    );
  });
}

// ── Banner global de amenaza de tsunami ────────────────────────
// Sin botón de cierre a propósito: es seguridad vital y dura lo que dure el
// estado real informado por tsunami.json, no lo que el usuario quiera ver.

function renderTsunamiBanner() {
  const el = $('#tsunami-banner');
  if (!el || !tsunamiData) return;
  const estado = tsunamiData.estado;
  if (estado === 'amenaza') {
    el.textContent = `🌊 AMENAZA DE TSUNAMI — ${tsunamiData.mensaje} · Sigue al SHOA/SENAPRED y evacúa la costa`;
    el.className = 'tsunami-banner tsunami-amenaza';
    el.hidden = false;
  } else if (estado === 'precaucion') {
    el.textContent = tsunamiData.mensaje;
    el.className = 'tsunami-banner tsunami-precaucion';
    el.hidden = false;
  } else if (estado === 'informativo') {
    el.textContent = `🌊 ${tsunamiData.mensaje}`;
    el.className = 'tsunami-banner tsunami-informativo';
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ── Costa: marea, oleaje y estado de tsunami del punto más cercano ─────
// Reutiliza haversineKm (mismo patrón que estacionAireCercana/estacionObsCercana).

function puntoCosteroActivo() {
  if (!mareaData || !mareaData.puntos) return null;
  let best = null;
  for (const p of mareaData.puntos) {
    const d = haversineKm(place.lat, place.lon, p.lat, p.lon);
    if (!best || d < best.dist) best = { ...p, dist: d };
  }
  return best && best.dist <= 40 ? best : null;
}

function renderCosta() {
  const panel = $('.panel-costa');
  if (!panel) return;
  const p = puntoCosteroActivo();
  panel.hidden = !p;
  if (!p) return;

  $('#costa-nombre').textContent = p.nombre;
  const cls = p.tendencia === 'bajando' ? 'marea-baja' : 'marea-sube';
  $('#costa-marea-icono').textContent = p.tendencia === 'bajando' ? '▼' : p.tendencia === 'subiendo' ? '▲' : '—';
  $('#costa-marea-icono').className = `costa-marea-icono ${cls}`;
  $('#costa-marea-nivel').textContent = `${r1(p.nivel)} m`;
  $('#costa-marea-tendencia').textContent = p.tendencia || 'estable';

  const proxPleamar = (p.extremos || []).find((e) => e.tipo === 'pleamar');
  const proxBajamar = (p.extremos || []).find((e) => e.tipo === 'bajamar');
  $('#costa-pleamar').textContent = proxPleamar ? `${fechaHora(proxPleamar.t)} · ${r1(proxPleamar.h)} m` : '—';
  $('#costa-bajamar').textContent = proxBajamar ? `${fechaHora(proxBajamar.t)} · ${r1(proxBajamar.h)} m` : '—';
  $('#costa-ola').textContent = p.ola ? `${r1(p.ola.altura)} m · ${r1(p.ola.periodo)} s` : '—';
  $('#costa-sst').textContent = p.sst != null ? `${r1(p.sst)} °C` : '—';

  const marejada = $('#costa-marejada');
  if (p.marejada) {
    marejada.textContent = `🌊 Marejadas: olas de hasta ${r1(p.marejada.altura)} m ${fechaHora(p.marejada.t)}`;
    marejada.className = `costa-marejada costa-marejada-${p.marejada.nivel}`;
    marejada.hidden = false;
  } else {
    marejada.hidden = true;
  }

  const tsu = $('#costa-tsunami');
  if (tsunamiData) {
    tsu.textContent = tsunamiData.mensaje;
    tsu.className = `costa-tsunami ${tsunamiData.estado === 'amenaza' ? 'tsunami-amenaza' : tsunamiData.estado === 'precaucion' ? 'tsunami-precaucion' : ''}`;
  } else {
    tsu.textContent = '—';
    tsu.className = 'costa-tsunami';
  }
  $('#costa-nota').textContent = (mareaData && mareaData.nota) || '';
}

// ── Ubicaciones: chips y búsqueda ──────────────────────────────

function setPlace(p) {
  place = p;
  actualizarPlaceRegion();   // recachear la región del nuevo lugar (modo 'cerca')
  try { localStorage.setItem('sinoptica.place', JSON.stringify(p)); } catch (_) { /* opcional */ }
  // Zoom 11 ≈ la comuna y su entorno inmediato: elegir una ciudad debe
  // enfocarla, no mostrar media región. Si el usuario ya estaba más adentro
  // (p. ej. nivel calle), se respeta su zoom.
  if (map) map.setView([p.lat, p.lon], Math.max(map.getZoom(), 11));
  updateBiasStation();   // recalcular la estación de calibración cercana
  actualizarLabelCerca();
  if (riesgoAmbito === 'cerca') renderRiesgos();
  renderCosta();   // recalcular el punto costero más cercano
  loadAll().catch(showError);
}

function renderChips() {
  const wrap = $('#chips');
  wrap.innerHTML = '';
  PLACES.forEach((group) => {
    const tag = document.createElement('span');
    tag.className = 'chip-region';
    tag.textContent = group.region;
    wrap.appendChild(tag);
    group.items.forEach((p) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = p.name;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', String(p.name === place.name));
      b.addEventListener('click', () => setPlace(p));
      wrap.appendChild(b);
    });
  });
}

// Catastro de comunas (INE, web/comunas.json): fuente local instantánea, sin
// red. Se carga una sola vez, al primer foco del buscador, al activar la
// capa de alertas (lazy en CAPAS.alertas) o al entrar en modo 'cerca' del
// panel de riesgo (lazy en renderRiesgos) — lo que ocurra primero.
// comunasData/comunasCargando se declaran antes de CAPAS: la restauración de
// capas desde localStorage los evalúa al cargar el script.
async function cargarComunas() {
  if (comunasData || comunasCargando) return;
  comunasCargando = true;
  try {
    const res = await fetch('comunas.json');
    if (res.ok) comunasData = await res.json();
  } catch (_) { /* sin comunas.json: el buscador cae solo al geocoding remoto */ }
  comunasCargando = false;
  // Solo re-renderizar el panel de riesgo si el fetch trajo datos: si falló
  // (offline real, antes de que el service worker cachee comunas.json), no
  // hay que reintentar aquí mismo — eso encadenaría renderRiesgos ↔
  // cargarComunas sin backoff mientras dure el fallo. El próximo
  // renderRiesgos() natural (cualquier otra fuente que termine de cargar)
  // vuelve a intentarlo.
  if (comunasData) {
    actualizarPlaceRegion();
    if (riesgoAmbito === 'cerca') renderRiesgos();
  }
  if (capasActivas.has('alertas')) renderMapa();
}

// Coincidencias por prefijo primero (más relevantes), luego por infijo.
function buscarComunas(q) {
  if (!comunasData) return [];
  const nq = norm(q);
  const prefijo = [], infijo = [];
  for (const c of comunasData.comunas) {
    const nn = norm(c.n);
    if (nn.startsWith(nq)) prefijo.push(c);
    else if (nn.includes(nq)) infijo.push(c);
  }
  return [...prefijo, ...infijo].slice(0, 8).map((c) => ({ ...c, tipo: 'comuna' }));
}

function setupSearch() {
  const input = $('#search');
  const list = $('#search-results');
  let timer = null;
  let items = [];   // comunas locales + resultados de geocoding, en ese orden
  let sel = -1;

  const hide = () => { list.hidden = true; sel = -1; };

  // `nComunas` marca dónde termina el tramo de comunas dentro de `items`,
  // para pintar el separador visual solo cuando ambos tramos coexisten.
  const render = (comunas, geo) => {
    items = [...comunas, ...geo];
    list.innerHTML = '';
    if (!items.length) { hide(); return; }
    items.forEach((r, i) => {
      const li = document.createElement('li');
      const small = document.createElement('small');
      if (r.tipo === 'comuna') {
        li.append(`${r.n} `);
        small.textContent = r.r;
      } else {
        li.append(`${r.name} `);
        small.textContent = [r.admin2, r.admin1].filter(Boolean).join(' · ');
      }
      li.appendChild(small);
      if (i === comunas.length && comunas.length && geo.length) li.classList.add('search-sep');
      li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(i); });
      list.appendChild(li);
    });
    list.hidden = false;
  };

  const pick = (i) => {
    const r = items[i];
    if (!r) return;
    input.value = '';
    hide();
    if (r.tipo === 'comuna') setPlace({ name: r.n, admin1: r.r, lat: r.lat, lon: r.lon });
    else setPlace({ name: r.name, admin1: r.admin1, lat: r.latitude, lon: r.longitude });
  };

  input.addEventListener('focus', () => { cargarComunas(); }, { once: true });

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { hide(); return; }
    const comunas = buscarComunas(q);
    render(comunas, []);   // comunas locales: instantáneo, no espera el debounce
    timer = setTimeout(async () => {
      try {
        const data = await fetchJSON(`${API_GEO}?name=${encodeURIComponent(q)}&count=6&language=es&format=json`);
        const geo = (data.results || []).filter((r) => r.country_code === 'CL').map((r) => ({ ...r, tipo: 'geo' }));
        render(comunas, geo);
      } catch (_) { render(comunas, []); }
    }, 280);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    const lis = [...list.children];
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = e.key === 'ArrowDown' ? Math.min(sel + 1, lis.length - 1) : Math.max(sel - 1, 0);
      lis.forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    } else if (e.key === 'Enter' && sel >= 0) {
      e.preventDefault();
      pick(sel);
    } else if (e.key === 'Escape') {
      hide();
    }
  });

  input.addEventListener('blur', () => setTimeout(hide, 150));
}

// ── Diálogos (info + día) ──────────────────────────────────────

function setupDialogs() {
  document.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const info = INFO[btn.dataset.info];
      if (!info) return;
      $('#info-dialog-title').textContent = info.title;
      $('#info-dialog-body').innerHTML = info.html; // contenido estático propio
      $('#info-dialog').showModal();
    });
  });
  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.querySelector('[data-close]')?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('click', (e) => {
      // clic fuera del contenido = cerrar
      const r = dlg.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close();
    });
    dlg.addEventListener('close', () => {
      if (dlg.id === 'day-dialog') { destroyChart('chart-day-temp'); destroyChart('chart-day-precip'); }
    });
  });
}

// ── Estado del archivo científico ──────────────────────────────

async function loadArchiveStatus() {
  try {
    const res = await fetch('status.json', { cache: 'no-store' });
    if (!res.ok) return;
    const s = await res.json();
    const el = $('#archive-status');
    el.textContent = `archivo científico: ${s.forecast_rows.toLocaleString('es-CL')} pronósticos · ` +
      `${s.obs_rows.toLocaleString('es-CL')} observaciones · ${s.stations} estaciones · desde ${s.since} · ` +
      `última ingesta ${s.last_run}`;
    el.hidden = false;
  } catch (_) { /* aún sin archivo: silencio */ }
}

// ── Errores y arranque ─────────────────────────────────────────

function showError(err) {
  const el = $('#error');
  el.textContent = `No se pudieron cargar los datos (${err.message}). Reintenta en unos segundos.`;
  el.hidden = false;
  $('#app').dataset.state = 'error';
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (document.documentElement.dataset.tema) return; // tema manual: ignora al sistema
  syncThemeColorMeta();
  render();
  renderVerif();
  renderMapa();
});

// ── Selector de tema (auto → claro → oscuro → auto) ────────────

const THEME_LABEL = { auto: 'automático', light: 'claro', dark: 'oscuro' };
const THEME_ICON = { auto: '🌓', light: '☀️', dark: '🌙' };

function themeState() {
  const t = document.documentElement.dataset.tema;
  return t === 'light' || t === 'dark' ? t : 'auto';
}

// Actualiza los <meta name="theme-color"> (uno por media claro/oscuro) para
// que coincidan con el tema efectivo, incluso si fue elegido a mano.
function syncThemeColorMeta() {
  const bg = css('--bg');
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => { m.content = bg; });
}

function updateThemeBtn() {
  const btn = $('#theme-btn');
  if (!btn) return;
  const t = themeState();
  btn.textContent = THEME_ICON[t];
  btn.title = `Tema: ${THEME_LABEL[t]}`;
}

function setupThemeBtn() {
  const btn = $('#theme-btn');
  if (!btn) return;
  updateThemeBtn();
  syncThemeColorMeta();
  btn.addEventListener('click', () => {
    const next = { auto: 'light', light: 'dark', dark: 'auto' }[themeState()];
    if (next === 'auto') {
      delete document.documentElement.dataset.tema;
      try { localStorage.removeItem('sinoptica.tema'); } catch (_) { /* opcional */ }
    } else {
      document.documentElement.dataset.tema = next;
      try { localStorage.setItem('sinoptica.tema', next); } catch (_) { /* opcional */ }
    }
    updateThemeBtn();
    syncThemeColorMeta();
    render();
    renderVerif();
    renderMapa();
  });
}

if ('serviceWorker' in navigator) {
  addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ── Warmup offline de evacuación ───────────────────────────────
// Los ~3,2 MB de datos de evacuación (rutas, áreas de tsunami, puntos de
// encuentro oficiales) hoy solo entran a DATA_CACHE si el usuario activa la
// capa evacuación con red (loadEmergencia es lazy). En una emergencia real la
// red se cae antes de que eso pase: forzamos un fetch en idle tras la carga
// para que el fetch-handler del SW los persista sin que el usuario active
// nada. Solo calienta la caché HTTP (no parsea a memoria, no llama
// renderMapa); sin red falla silencioso y se reintenta la próxima sesión.
// Mismo patrón que PACK_JSON de "Preparar mi zona" (más abajo).
const EVAC_WARMUP = ['emergencia.json', 'tsunami_vias.json', 'tsunami_areas.json'];
function warmupEvacuacion() {
  if (!navigator.onLine || !('serviceWorker' in navigator)) return;
  for (const f of EVAC_WARMUP) fetch(f).catch(() => {});
}
if ('requestIdleCallback' in window) {
  requestIdleCallback(warmupEvacuacion, { timeout: 10000 });
} else {
  setTimeout(warmupEvacuacion, 4000);
}

async function loadAireSinca() {
  try {
    const res = await fetch('aire.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    aireStations = data.estaciones || [];
    aireData = data;
    if (lastData) renderAire(lastData.aire);   // re-render con dato oficial
    if (capasActivas.has('aire')) renderMapa(); // repinta el mapa de aire
  } catch (_) { /* sin SINCA: el panel usa el pronóstico CAMS */ }
}

async function loadBias() {
  try {
    const res = await fetch('bias.json', { cache: 'no-store' });
    if (!res.ok) return;
    biasData = await res.json();
    updateBiasStation();
    if (lastData) render();   // re-pintar con modelos calibrados
  } catch (_) { /* sin calibración: pronóstico crudo */ }
}

setupSearch();
setupDialogs();
setupVerifTabs();
setupThemeBtn();
setupCapas();
setupMapaFullscreen();
setupRiesgos();
setupPuntoCercano();
setupPush();

// ── Avisos de emergencia (Web Push) ────────────────────────────
// Sin registro: la suscripción vive en el navegador (endpoint + claves) y el
// servidor solo la usa para reenviar sismos/alertas/volcanes graves.

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Preferencias del opt-in "solo mi zona" + recordatorio de kit, solo para
// pintar la UI: la fuente de verdad de a quién se le envía vive en push/send.py.
function savedPushPrefs() {
  try {
    const raw = localStorage.getItem('sinoptica.pushPrefs');
    if (raw) return { zona: false, radio: 200, mag: 5.5, kit: false, ...JSON.parse(raw) };
  } catch (_) { /* localStorage puede no estar disponible */ }
  return { zona: false, radio: 200, mag: 5.5, kit: false };
}

function savePushPrefs(prefs) {
  try { localStorage.setItem('sinoptica.pushPrefs', JSON.stringify(prefs)); } catch (_) { /* opcional */ }
}

async function setupPush() {
  const btn = $('#push-btn');
  const info = $('#push-info');
  const zonaBox = $('#push-zona');
  const zonaToggle = $('#push-zona-toggle');
  const zonaRadio = $('#push-zona-radio');
  const zonaMag = $('#push-zona-mag');
  const kitToggle = $('#push-kit-reminder');
  if (!btn || !info) return;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  btn.hidden = false;
  info.hidden = false;

  const prefs = savedPushPrefs();
  if (zonaToggle) zonaToggle.checked = prefs.zona;
  if (zonaRadio) zonaRadio.value = String(prefs.radio);
  if (zonaMag) zonaMag.value = String(prefs.mag);
  if (kitToggle) kitToggle.checked = prefs.kit;

  function pintar(suscrito) {
    btn.textContent = suscrito ? '🔕 Desactivar avisos de emergencia' : '🔔 Recibir avisos de emergencia';
    btn.setAttribute('aria-pressed', String(suscrito));
    if (zonaBox) zonaBox.hidden = !suscrito;
  }

  // Campos opcionales de zona/kit para el body de /api/push/subscribe.
  // Ubicación: `place` (comuna elegida), NUNCA GPS, redondeada a 0.1° (~11 km)
  // con el mismo `r1` que ya usa el resto de la app.
  function camposZona() {
    const p = {
      zona: !!(zonaToggle && zonaToggle.checked),
      radio: zonaRadio ? Number(zonaRadio.value) : 200,
      mag: zonaMag ? Number(zonaMag.value) : 5.5,
      kit: !!(kitToggle && kitToggle.checked),
    };
    savePushPrefs(p);
    // `zona` va siempre explícito (true/false): así el servidor distingue
    // "el usuario apagó la zona" (borra lat/lon) de "esta petición no dice
    // nada de zona" (preserva lo ya guardado) — ver push/server.py.
    const campos = { zona: p.zona, kit_reminder: p.kit ? 1 : 0 };
    if (p.zona) {
      campos.lat = r1(place.lat);
      campos.lon = r1(place.lon);
      campos.radio_km = p.radio;
      campos.mag_min = p.mag;
    }
    return campos;
  }

  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (_) {
    return; // sin service worker activo: el botón queda oculto de más arriba
  }

  async function resubscribe() {
    const actual = await reg.pushManager.getSubscription();
    if (!actual) return; // los controles de zona están ocultos si no hay suscripción
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...actual.toJSON(), ...camposZona() }),
    }).catch(() => {});
  }

  [zonaToggle, zonaRadio, zonaMag, kitToggle].forEach((el) => {
    if (el) el.addEventListener('change', resubscribe);
  });

  const subInicial = await reg.pushManager.getSubscription().catch(() => null);
  pintar(!!subInicial);

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const actual = await reg.pushManager.getSubscription();
      if (actual) {
        await actual.unsubscribe();
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: actual.endpoint }),
        }).catch(() => {});
        pintar(false);
        return;
      }

      const res = await fetch('/api/push/vapid');
      const { publicKey } = await res.json();
      if (!publicKey) {
        alert('Las notificaciones aún no están habilitadas en el servidor.');
        return;
      }

      const permiso = await Notification.requestPermission();
      if (permiso !== 'granted') return;

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
      await fetch('/api/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...sub.toJSON(), ...camposZona() }),
      });
      pintar(true);
    } catch (_) {
      alert('No se pudo activar los avisos de emergencia. Intenta de nuevo más tarde.');
    } finally {
      btn.disabled = false;
    }
  });
}

// ── "Preparar mi zona": pack offline de emergencia + tiles ─────
// Los 4 JSON de emergencia (nacionales), comunas, y los "vivos" (sismos,
// alertas, avisos, estaciones, status) pasan por fetch normal (sin
// cache:'no-store') para que el fetch handler de sw.js los persista en
// DATA_CACHE tal como ya hace con el resto de la app (ver sw.js:129-142;
// comunas.json se agregó al regex isData ahí mismo). Los tiles van aparte,
// fijados a mano en PACK_CACHE vía postMessage (sin límite LRU).
const PACK_JSON = [
  'emergencia.json', 'tsunami_vias.json', 'tsunami_areas.json', 'remociones.json',
  'comunas.json', 'sismos.json', 'alertas.json', 'avisos.json', 'cortes.json', 'esval.json', 'estaciones.json', 'status.json',
];
// Incluye 8-10 porque ensureMap() abre en zoom 8: sin esos niveles, offline
// la vista inicial saldría con tiles rotos (a esa escala son 1-2 tiles por zoom).
const PACK_ZOOMS = [8, 9, 10, 11, 12, 13, 14];
// 0.15° (el radio "natural" para cubrir una comuna) da ~370 tiles en los zooms
// altos: muy por sobre el presupuesto. 0.08° da ~110-120, dentro del rango
// buscado y ya cubre holgadamente el radio urbano de una comuna.
const PACK_RADIO_DEG = 0.08;
const PACK_MAX_DIAS = 30;

function lonATileX(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function latATileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z);
}
// Misma fórmula que Leaflet (_getSubdomain) para que la URL fijada coincida
// exacto con la que el tileLayer en vivo va a pedir — si no coinciden, el
// cache-first de PACK_CACHE en sw.js nunca hace match y el pack no sirve de nada.
function tileSubdomain(x, y) {
  const subs = 'abcd';
  return subs[Math.abs(x + y) % subs.length];
}

function packTileUrls(lat, lon) {
  const tmpl = TILES[isDark() ? 'dark' : 'light'];
  const r = (window.devicePixelRatio || 1) > 1 ? '@2x' : ''; // igual que b.retina en Leaflet
  const urls = [];
  for (const z of PACK_ZOOMS) {
    const [x1, x2] = [lonATileX(lon - PACK_RADIO_DEG, z), lonATileX(lon + PACK_RADIO_DEG, z)].sort((a, b) => a - b);
    const [y1, y2] = [latATileY(lat + PACK_RADIO_DEG, z), latATileY(lat - PACK_RADIO_DEG, z)].sort((a, b) => a - b);
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        urls.push(tmpl.replace('{s}', tileSubdomain(x, y)).replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{r}', r));
      }
    }
  }
  return urls;
}

function savedPack() {
  try {
    const raw = localStorage.getItem('sinoptica.pack');
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p.fecha === 'string' && typeof p.name === 'string') return p;
    }
  } catch (_) { /* localStorage puede no estar disponible */ }
  return null;
}

function pintarPackStatus() {
  const btn = $('#pack-btn');
  const status = $('#pack-status');
  if (!btn || !status) return;
  const pack = savedPack();
  if (!pack) {
    status.hidden = true;
    btn.textContent = '📦 Preparar mi zona (offline)';
    return;
  }
  const dias = Math.floor((Date.now() - new Date(pack.fecha).getTime()) / 86400000);
  status.hidden = false;
  status.textContent = dias > PACK_MAX_DIAS
    ? `Tu zona (${pack.name}) se preparó hace ${dias} días — prepárala de nuevo.`
    : `Tu zona (${pack.name}) quedó lista para usarse sin conexión (preparada el ${new Date(pack.fecha).toLocaleDateString('es-CL')}). El pronóstico offline es el último visto; los datos en vivo requieren conexión.`;
  btn.textContent = '📦 Preparar de nuevo';
}

async function prepararZona() {
  const btn = $('#pack-btn');
  const status = $('#pack-status');
  if (!btn || !status || !('serviceWorker' in navigator)) return;
  let reg;
  try {
    reg = await navigator.serviceWorker.ready;
  } catch (_) {
    return;
  }
  if (!reg.active) return;

  btn.disabled = true;
  status.hidden = false;
  status.textContent = 'Preparando tu zona…';

  if (savedPack()) {
    // "Preparar de nuevo": espera la confirmación del borrado antes de
    // repoblar, para no repoblar en la caché que está por desaparecer.
    await new Promise((resolve) => {
      const onClear = (e) => {
        if (e.data && e.data.type === 'pin-cleared') listo();
      };
      const listo = () => {
        navigator.serviceWorker.removeEventListener('message', onClear);
        resolve();
      };
      navigator.serviceWorker.addEventListener('message', onClear);
      reg.active.postMessage({ type: 'pin-clear' });
      setTimeout(listo, 3000); // no bloquear indefinidamente si el SW no respondió
    });
  }

  await Promise.allSettled(PACK_JSON.map((f) => fetch(f)));

  const urls = packTileUrls(place.lat, place.lon);
  await new Promise((resolve) => {
    const onMsg = (e) => {
      const d = e.data || {};
      if (d.type === 'pin-progress') {
        status.textContent = `Preparando tu zona… ${d.done}/${d.total}`;
      } else if (d.type === 'pin-done') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        try {
          localStorage.setItem('sinoptica.pack', JSON.stringify({ fecha: new Date().toISOString(), name: place.name }));
        } catch (_) { /* opcional */ }
        pintarPackStatus();
        if (d.fallidos > 0) status.textContent += ` (${d.fallidos} tiles no se pudieron guardar)`;
        resolve();
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    reg.active.postMessage({ type: 'pin-tiles', urls });
  });

  btn.disabled = false;
}

function setupPack() {
  const btn = $('#pack-btn');
  if (!btn || !('serviceWorker' in navigator)) { if (btn) btn.hidden = true; return; }
  pintarPackStatus();
  btn.addEventListener('click', () => {
    prepararZona().catch(() => { btn.disabled = false; });
  });
}

setupPack();

renderChips();
loadAll().catch(showError);
loadArchiveStatus();
loadVerif();
loadMapa();
loadAireSinca();
loadBias();
loadSismos();
loadIncendios();
loadAlertas();
loadVolcanes();
loadAvisos();
loadMarea();
loadTsunami();
loadCortes();
loadEsval();
// crecidas.json se carga eager (a diferencia de remociones/combustible, que
// no alimentan ningún tile) porque el tile del centro de riesgos necesita
// el conteo de ríos en crecida ANTES de que el usuario active la capa del
// mapa; el mecanismo `lazy` de CAPAS.crecidas queda como respaldo si este
// fetch inicial falló.
loadCrecidas();

// ── Refresco en vivo ───────────────────────────────────────────
// Una pestaña dejada abierta mostraba datos congelados hasta recargar. Al
// volver a la pestaña y cada ~10 min volvemos a traer los datos en segundo
// plano (sin parpadeo de "cargando"): así "Condiciones actuales" refleja la
// última medición sin que el usuario recargue. El backend ingesta cada hora,
// así que refrescar más seguido solo adelanta la aparición del dato nuevo.
const REFRESH_MS = 10 * 60 * 1000;     // refresco periódico con pestaña visible
const REFRESH_MIN_GAP_MS = 60 * 1000;  // ignora rebotes de foco < 60 s
let lastRefreshAt = Date.now();
let refreshing = false;

// ── Modo offline: barra visible cuando no hay red ──────────────
// El "última actualización" es el más reciente `updated` entre los JSON ya
// cargados (mejor esfuerzo: no todos llegaron a existir necesariamente).
function ultimaActualizacionLocal() {
  const updates = [estacionesData, sismosData, incendiosData, alertasData, volcanesData, avisosData, biasData, mareaData, tsunamiData, cortesData, esvalData]
    .filter((d) => d && d.updated).map((d) => d.updated);
  if (!updates.length) return null;
  const masReciente = updates.sort().pop();   // "YYYY-MM-DD HH:MM UTC" ordena bien como texto
  return horaLocal(masReciente.replace(' UTC', 'Z').replace(' ', 'T'));
}

function mostrarOffline(mostrar, mensaje) {
  const bar = $('#offline-bar');
  if (!bar) return;
  if (!mostrar) { bar.hidden = true; return; }
  if (mensaje) {
    bar.textContent = `⚠ ${mensaje}`;
  } else {
    const hora = ultimaActualizacionLocal();
    bar.textContent = `⚠ Sin conexión — mostrando los últimos datos guardados${hora ? ` (actualizados ${hora} h)` : ''}`;
  }
  bar.hidden = false;
}

window.addEventListener('online', () => { mostrarOffline(false); refreshAll(); });
window.addEventListener('offline', () => { mostrarOffline(true); });

async function refreshAll() {
  if (refreshing || Date.now() - lastRefreshAt < REFRESH_MIN_GAP_MS) return;
  refreshing = true;
  lastRefreshAt = Date.now();
  try {
    await loadAll({ silent: true });   // Open-Meteo (current + modelos)
    mostrarOffline(false);
  } catch (_) { mostrarOffline(true); }   // sin red: la pantalla conserva el último dato bueno
  loadMapa();          // estaciones.json → medición real de la central cercana
  loadAireSinca();     // aire.json (SINCA)
  loadBias();          // bias.json (calibración)
  loadVerif();         // verificacion.json
  loadArchiveStatus(); // status.json
  loadSismos();        // sismos.json (CSN + USGS)
  loadIncendios();     // incendios.json (NASA FIRMS)
  loadAlertas();       // alertas.json (SENAPRED)
  loadVolcanes();      // volcanes.json (SERNAGEOMIN RNVV)
  loadAvisos();        // avisos.json (derivado propio)
  loadMarea();         // marea.json (Open-Meteo Marine, no oficial)
  loadTsunami();       // tsunami.json (PTWC + catálogo sísmico propio)
  loadCortes();        // cortes.json (SEC, best effort vía satélite en omen)
  loadEsval();         // esval.json (Esval, cortes de agua V Región, best effort vía satélite en omen)
  loadCrecidas();      // crecidas.json (GloFAS/Copernicus vía Open-Meteo, no oficial)
  // El satélite no tiene JSON propio (fetch cross-origin a GIBS) y solo se
  // recarga si la capa está activa: sin esto no habría forma de ver frames
  // nuevos sin apagar y prender la capa a mano.
  if (capasActivas.has('satelite')) loadSatelite();
  refreshing = false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshAll();
  else detenerReproduccionSatelite(); // pestaña oculta: no seguir animando en segundo plano
});
setInterval(() => {
  if (document.visibilityState === 'visible') refreshAll();
}, REFRESH_MS);

// Carril rápido para sismos: un evento nuevo importa apenas ocurre, no en
// 10 min. Refresca solo esta capa cada 5 min mientras el panel del mapa
// exista (siempre que haya estaciones.json) o la capa sismos esté encendida.
const SISMOS_REFRESH_MS = 5 * 60 * 1000;
setInterval(() => {
  const panelMapaVisible = !$('#map').closest('.panel').hidden;
  if (document.visibilityState === 'visible' && (capasActivas.has('sismos') || panelMapaVisible)) {
    loadSismos();
  }
  // Tsunami también va al carril rápido: es el banner de seguridad vital y
  // no puede esperar los 10 min del refresco general.
  if (document.visibilityState === 'visible') loadTsunami();
}, SISMOS_REFRESH_MS);
