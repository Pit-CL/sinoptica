#!/usr/bin/env python3
"""Envío de notificaciones Web Push de emergencia (Vigía). Corre por cron
cada 5 min dentro del contenedor `push` — única pieza del proyecto que usa
`pywebpush` (ver excepción a la regla de cero-dependencias en CLAUDE.md).

Lee los JSON de peligros ya publicados por la ingesta (sismos, alertas,
volcanes, tsunami), decide qué eventos disparan notificación y evita
reenviar el mismo evento dos veces a la misma suscripción (tabla `sent`).

Umbrales: nacionales para subs sin ubicación (comportamiento original).
Subs con ubicación (opt-in "solo mi zona") agregan un criterio de cercanía
con umbral más bajo — ver `_cumple()`.

Además del Web Push, en el mismo ciclo se procesa un suscriptor de canal
interno multi-zona (GCHAT_ZONAS, con fallback a la zona única legacy
GCHAT_ZONA_LAT/LON/REGION) — ver `_procesar_gchat()`. Dormido si no hay
GCHAT_WEBHOOK_ALERTAS configurada (mismo patrón que ingesta/watchdog.py).
Transporte: webhook del espacio `alertas` de Google Chat, único canal desde
el 2026-08-16 — antes era Slack (bot Heraldo con fallback a webhook) y se
retiró al cancelarse Slack Pro.

Eventos NACIONALES (tsunami, sismos M≥6.5/PAGER, volcanes, alertas rojas) se
envían UNA vez a todo el canal (endpoint `slack:nacional`), sin importar
cuántas zonas haya configuradas. Eventos DE ZONA raros/urgentes (sismo local
M≥5.5/200km, alerta amarilla de la región de la zona) se envían individuales,
una vez por zona (endpoint `slack:zona:<nombre>`) con el nombre de la zona en
el texto. Migración: los eventos ya enviados bajo el endpoint legacy
`slack:zona` (una sola zona, esquema anterior) no se reenvían — ver
`_enviar_dedup`.

Los identificadores `slack:*` de arriba son claves de dedup persistidas en
`push.db` (tabla `sent`), no un destino: conservan su valor histórico a
propósito. Renombrarlos al migrar a Google Chat habría dejado sin efecto el
dedup y reenviado de golpe todo evento todavía vigente — una amenaza de
tsunami en curso incluida. Misma razón para la tabla `slack_estado`.

Avisos Vigía cercanos y focos de incendio cercanos, en cambio, pueden llegar
en ráfagas de decenas por ciclo (un frente de lluvia genera un aviso por
estación) — se agrupan en UN solo mensaje "digest" por zona por ciclo, ver
`_digest_zona_gchat`. El dedup sigue siendo por evento individual (cada
aviso/foco incluido en el digest se marca enviado); el digest solo cambia el
empaque de envío, no qué se considera nuevo.
"""
import argparse
import json
import math
import os
import re
import sqlite3
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from pywebpush import WebPushException, webpush

DB_PATH = Path(os.environ.get("PUSH_DB", Path(__file__).resolve().parent.parent / "data" / "push.db"))
SISMOS_PATH = Path(os.environ.get("PUSH_SISMOS", "/data/sismos.json"))
ALERTAS_PATH = Path(os.environ.get("PUSH_ALERTAS", "/data/alertas.json"))
VOLCANES_PATH = Path(os.environ.get("PUSH_VOLCANES", "/data/volcanes.json"))
TSUNAMI_PATH = Path(os.environ.get("PUSH_TSUNAMI", "/data/tsunami.json"))
AVISOS_PATH = Path(os.environ.get("PUSH_AVISOS", "/data/avisos.json"))
INCENDIOS_PATH = Path(os.environ.get("PUSH_INCENDIOS", "/data/incendios.json"))
# Catastro INE de comunas (mismo archivo versionado que usa web/app.js para
# el filtro 'cerca' del panel de riesgo). No lo genera la ingesta: en prod va
# montado aparte (ver docker-compose.yml, mismo patrón que usa el contenedor
# ingesta); en dev local default al del repo.
COMUNAS_PATH = Path(os.environ.get(
    "PUSH_COMUNAS", Path(__file__).resolve().parent.parent / "web" / "comunas.json"))

SITE_URL = "https://vigia.cavara.cl/"
KIT_URL = "https://vigia.cavara.cl/emergencia.html#kit"
ACCION = "Revisa el mapa y tus vías de evacuación"

VENTANA_SISMO_H = 2
MAG_ALTA = 6.5
MAG_PAGER = 6.0
# USGS PAGER: "alert" es el color agregado del evento (green/yellow/orange/red);
# la API nunca lo traduce a español.
PAGER_NIVELES = {"yellow", "orange", "red"}
VOLCAN_NIVELES = {"naranja", "roja"}

# Modo "solo mi zona" (opt-in, columnas subs.lat/lon/radio_km/mag_min):
# umbral de magnitud y radio por defecto cuando la sub no fija los suyos.
MAG_MIN_ZONA = 5.5
RADIO_KM_ZONA = 200
# Piso absoluto de mag_min aceptado por el servidor (push/server.py): el pool
# de sismos candidatos a "zona" no puede ser más estricto que esto o
# descartaría eventos que sí calificarían para alguna sub.
MAG_MIN_ZONA_PISO = 4.5

# ── Suscriptor de canal interno (multi-zona) ────────────────────
# Todas con default vacío → funcionalidad dormida (mismo patrón que
# ingesta/watchdog.py y combustible.py). Mismo espacio `alertas` que usa el
# watchdog: estas son alertas accionables del producto, no rutina.
GCHAT_WEBHOOK_ALERTAS = os.environ.get("GCHAT_WEBHOOK_ALERTAS", "")
GCHAT_ZONA_REGION = os.environ.get("GCHAT_ZONA_REGION", "")

# ── Claim VAPID 'sub' (RFC 8292) ────────────────────────────────
# pywebpush exige vapid_claims={"sub": "mailto:..."} para firmar el push;
# sin un 'sub' válido, los endpoints FCM (Chrome) rechazan el envío con
# WebPushException "Missing 'sub' from claims". Formato esperado en la env:
# "mailto:correo@dominio". Sin VAPID_SUB configurada, se advierte una vez
# por corrida en main() (no por cada suscriptor) y el envío sigue fallando
# igual que hoy — no hay email por defecto porque el repo es público.
VAPID_SUB = os.environ.get("VAPID_SUB", "")


def _float_env(nombre: str):
    valor = os.environ.get(nombre, "")
    try:
        return float(valor) if valor else None
    except ValueError:
        return None


GCHAT_ZONA_LAT = _float_env("GCHAT_ZONA_LAT")
GCHAT_ZONA_LON = _float_env("GCHAT_ZONA_LON")

# Avisos Vigía / incendios: radio de cercanía a la zona (constantes propias,
# distintas de RADIO_KM_ZONA que es para sismos).
RADIO_KM_AVISO_ZONA = 75      # avisos Vigía (viento, lluvia, calor, etc.)
RADIO_KM_INCENDIO_ZONA = 50   # focos de calor FIRMS

# Endpoints sintéticos estables: reusan la tabla `sent` (event_id, endpoint)
# para el dedup del suscriptor de canal interno, igual que cualquier sub de
# Web Push. ENDPOINT_ZONA_LEGACY es el esquema PRE multi-zona (una sola zona,
# todos los eventos mezclados) — se sigue consultando en el dedup como
# endpoint legacy para no reenviar algo que ya se mandó antes de esa
# migración. El prefijo `slack:` de ambos valores es histórico y NO se toca al
# migrar a Google Chat: es la clave con la que ya están escritas las filas de
# `sent` en producción (ver el docstring del módulo).
ENDPOINT_ZONA_LEGACY = "slack:zona"
ENDPOINT_NACIONAL = "slack:nacional"
SENAPRED_URL = "https://senapred.cl/alertas/"
FRASE_CIERRE = "— Vigía · esto NO reemplaza a los canales oficiales (SHOA/SENAPRED)."
MENSAJE_PRUEBA_ZONA = (
    "✅ Vigía: alertas de tu zona (Viña del Mar) activas en este canal — "
    "tsunami, sismos cercanos, alertas SENAPRED de Valparaíso y volcanes. "
    "Prueba de tubería, no es una emergencia.")

# Port a Python de EXPLICA_EVENTO/EXPLICA_NIVEL (web/app.js): mismo texto en
# lenguaje claro que usa el frontend, para que la alerta del canal interno no
# invente un segundo tono. Si se edita uno, editar el otro (no hay build step
# común entre el JS del frontend y este contenedor Python).
EXPLICA_EVENTO = [
    (re.compile(r"zoosanitario", re.I),
     "Vigilancia del SAG por una enfermedad animal (por ejemplo influenza aviar) detectada en la zona. "
     "No es un riesgo directo para las personas: evita tocar aves o animales muertos o enfermos y "
     "repórtalos al SAG (2 2345 1100)."),
    (re.compile(r"alteraci[oó]n sanitaria", re.I),
     "Situación sanitaria bajo vigilancia de la autoridad (agua, plagas o brotes). Sigue las indicaciones "
     "de la SEREMI de Salud de tu región."),
    (re.compile(r"crecida", re.I),
     "Ríos o esteros de la zona vienen creciendo por lluvia o deshielo. No cruces cauces ni te acerques a "
     "las riberas; si vives cerca de un río, prepara una salida."),
    (re.compile(r"remoci[oó]n|aluvi[oó]n|deslizamiento", re.I),
     "Riesgo de deslizamientos de tierra o aluviones por lluvia en laderas. Aléjate de quebradas y cauces; "
     "si escuchas ruido de piedras o agua creciendo, sube a terreno firme y alto."),
    (re.compile(r"altas temperaturas|ola de calor", re.I),
     "Calor inusual para la zona. Hidrátate, evita el sol del mediodía y vigila a personas mayores, niños "
     "y mascotas. Sube el riesgo de incendios: evita cualquier fuego."),
    (re.compile(r"helada", re.I),
     "Temperaturas bajo cero esperadas. Protege cañerías, cultivos, mascotas y personas en situación de "
     "calle (llama al 800 104 777 — Código Azul)."),
    (re.compile(r"viento", re.I),
     "Viento fuerte esperado. Asegura techumbres, toldos y objetos sueltos; precaución al conducir "
     "vehículos altos y aléjate de árboles y tendido eléctrico."),
    (re.compile(r"volc[aá]n", re.I),
     "El volcán muestra actividad sobre lo normal y está bajo vigilancia reforzada de SERNAGEOMIN. "
     "Infórmate de tus vías de evacuación (capa 🏃 Evacuación del mapa) y respeta los perímetros."),
    (re.compile(r"incendio|forestal", re.I),
     "Condiciones favorables para incendios forestales o fuego activo en la zona. No enciendas fuego, "
     "reporta humo al 130 (CONAF) y prepárate para evacuar temprano si estás cerca."),
    (re.compile(r"meteorol[oó]gico", re.I),
     "Sistema frontal u otro evento del tiempo significativo para la zona (lluvia, viento o nieve). Revisa "
     "el pronóstico de tu comuna y evita desplazamientos innecesarios en lo peor del evento."),
]
EXPLICA_EVENTO_DEFAULT = "Alerta oficial de SENAPRED para la zona. Revisa senapred.cl para el detalle del evento."
EXPLICA_NIVEL = {
    "amarilla": "la amenaza crece y los equipos de emergencia se alistan; ten a mano lo esencial y revisa tus rutas.",
    "roja": "la amenaza está en desarrollo y puede requerir evacuación u otra acción inmediata; sigue YA las instrucciones oficiales.",
}

# Port de AVISO_EMOJI/AVISO_TIPO_LABEL (web/app.js) para los mensajes de
# avisos Vigía del canal interno — mismo criterio que EXPLICA_EVENTO arriba:
# si se edita uno, editar el otro.
AVISO_EMOJI_GCHAT = {
    "viento": "💨", "helada": "❄️", "lluvia": "🌧️", "lluvia_persistente": "🌧️",
    "calor": "🌡️", "aluvional": "⛰️💧", "nieve": "❄️", "incendio": "🔥",
    "rafagas": "🌪️", "presion": "📉", "nieve_cota_baja": "🏔️❄️",
    "ola_calor": "🥵", "ola_frio": "🥶", "tormenta": "⛈️", "uv": "☀️",
}
AVISO_TIPO_LABEL_GCHAT = {
    "viento": "viento", "helada": "helada", "lluvia": "lluvia intensa",
    "lluvia_persistente": "lluvia persistente", "calor": "calor extremo",
    "aluvional": "riesgo aluvional", "nieve": "nieve", "incendio": "riesgo de incendio",
    "rafagas": "ráfagas de viento", "presion": "caída de presión (temporal)",
    "nieve_cota_baja": "nieve en cota baja", "ola_calor": "ola de calor",
    "ola_frio": "ola de frío", "tormenta": "tormenta eléctrica", "uv": "UV extremo",
}

# Digest por zona (avisos Vigía + incendios, ver _digest_zona_gchat): orden
# de severidad para ordenar/contar, mismo criterio que SEV_RANGO en
# web/app.js. Tope de líneas para no generar un mensaje gigante cuando un
# frente de lluvia produce decenas de avisos en el mismo ciclo.
NIVEL_RANGO_GCHAT = {"amarillo": 1, "naranja": 2, "rojo": 3}
MAX_AVISOS_DIGEST = 8
MAX_FOCOS_DIGEST = 6

CL_TZ = ZoneInfo("America/Santiago")


def _explica_evento(evento: str) -> str:
    evento = evento or ""
    for patron, texto in EXPLICA_EVENTO:
        if patron.search(evento):
            return texto
    return EXPLICA_EVENTO_DEFAULT


def _dist_km(lat1, lon1, lat2, lon2) -> float:
    """Distancia entre dos puntos (haversine, radio terrestre 6371 km).
    Misma fórmula que ingesta/sismos.py:_dist_km."""
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


_comunas_cache: list[dict] | None = None   # None = aún no se intentó cargar
_comunas_disponibles = True                # False tras el primer intento fallido (no reintenta ni re-advierte)
_region_cache: dict[tuple[float, float], str | None] = {}   # memoiza por punto: evita recorrer comunas por cada par evento×sub


def _cargar_comunas() -> list[dict] | None:
    """Catastro de comunas para el tope regional. Se intenta cargar una sola
    vez por corrida; si falla (contenedor sin el volumen montado, archivo
    corrupto), se advierte UNA vez y de ahí en más `_region_de` devuelve
    siempre None — el tope regional queda inactivo (solo manda el radio),
    nunca deja de pushear todo el evento."""
    global _comunas_cache, _comunas_disponibles
    if _comunas_cache is not None or not _comunas_disponibles:
        return _comunas_cache
    try:
        data = json.loads(COMUNAS_PATH.read_text())
        _comunas_cache = data.get("comunas") or []
    except (FileNotFoundError, json.JSONDecodeError, OSError) as exc:
        _comunas_disponibles = False
        print(f"[push] comunas.json no disponible ({exc}): el tope regional de zona "
              "queda inactivo esta corrida, solo aplica el radio/magnitud configurado")
        return None
    return _comunas_cache


def _region_de(lat: float | None, lon: float | None) -> str | None:
    """Código de región (comunas.json, ej. 'V', 'RM') de la comuna cuyo
    centroide está más cerca de (lat, lon) — mismo criterio que regionDe en
    web/app.js. None si falta lat/lon o el catastro no está disponible."""
    if lat is None or lon is None:
        return None
    key = (lat, lon)
    if key in _region_cache:
        return _region_cache[key]
    comunas = _cargar_comunas()
    region = None
    if comunas:
        mejor, mejor_d = None, float("inf")
        for c in comunas:
            d = _dist_km(lat, lon, c["lat"], c["lon"])
            if d < mejor_d:
                mejor_d, mejor = d, c
        region = mejor.get("r") if mejor else None
    _region_cache[key] = region
    return region


def _misma_region(lat0: float, lon0: float, lat1: float, lon1: float) -> bool:
    """Tope regional para eventos de zona: True si ambos puntos caen en la
    misma región, o si la región de cualquiera de los dos no se pudo
    determinar (comunas.json no disponible) — ahí el tope queda inactivo y
    manda solo el radio, nunca bloquea el envío por esto."""
    r0, r1 = _region_de(lat0, lon0), _region_de(lat1, lon1)
    if r0 is None or r1 is None:
        return True
    return r0 == r1


def _rumbo(lat0: float, lon0: float, lat: float, lon: float) -> str:
    """Rumbo aproximado (8 puntos cardinales) desde (lat0,lon0) hacia
    (lat,lon) — usado para ubicar un foco de incendio respecto de la zona."""
    y = math.sin(math.radians(lon - lon0)) * math.cos(math.radians(lat))
    x = (math.cos(math.radians(lat0)) * math.sin(math.radians(lat))
         - math.sin(math.radians(lat0)) * math.cos(math.radians(lat)) * math.cos(math.radians(lon - lon0)))
    brng = (math.degrees(math.atan2(y, x)) + 360) % 360
    puntos = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"]
    return puntos[round(brng / 45) % 8]


def _post_gchat(texto: str) -> bool:
    """Manda `texto` al espacio `alertas` de Google Chat, único canal desde el
    2026-08-16 (se retiró Slack al cancelarse Slack Pro). Mismo patrón que
    ingesta/watchdog.py._post_gchat, duplicado aquí porque push/ e ingesta/ son
    contenedores separados sin módulo compartido.

    Devuelve si la entrega se concretó de verdad, y eso es crítico: el caller
    (`_enviar_dedup`, `_enviar_digest_zona`) solo marca el evento en `sent`
    cuando esto devuelve verdadero. Un `True` sin entrega perdería la alerta en
    silencio; un `False` con entrega hecha la repetiría cada 5 minutos. Por eso
    el 2xx se mira explícitamente en vez de asumir éxito si no hubo excepción.

    Los textos ya vienen en unicode (no hay shortcodes `:warning:` que traducir,
    a diferencia del watchdog) y el `*negrita*` heredado del formato de Slack se
    renderiza igual en Chat, así que no hay conversión que hacer.

    Nunca propaga la URL del webhook en el error: lleva `key` y `token`."""
    if not GCHAT_WEBHOOK_ALERTAS:
        return False
    body = json.dumps({"text": f"[VIGIA] {texto}"}).encode("utf-8")
    req = urllib.request.Request(
        GCHAT_WEBHOOK_ALERTAS, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=UTF-8"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        print(f"[gchat] error: HTTP {err.code}")
        return False
    except Exception:
        print("[gchat] error: error de red")
        return False


def _load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _cargar_zonas() -> list[dict]:
    """Zonas configuradas para el suscriptor de canal interno. Prioridad:
    1. GCHAT_ZONAS (JSON array: [{"nombre","lat","lon","region"}, ...]). Si
       está presente pero malformada (JSON inválido o campos faltantes), se
       loguea un error SIN el valor crudo (podría no ser sensible, pero no
       hay necesidad de imprimirlo) y se devuelve lista vacía — el operador
       queda sin avisos hasta corregir el env, no falla el resto del cron.
    2. Fallback legacy: GCHAT_ZONA_LAT/LON/REGION arma una zona única
       llamada "zona" (mismo nombre que usaba el mensaje de prueba antes de
       multi-zona) — es la forma en que está configurado el .env de prod.
       Se marca `legacy=True` para que `_procesar_gchat` también consulte el
       endpoint `slack:zona` (esquema pre multi-zona) en el dedup de esta
       zona y no re-spamee lo ya enviado.
    """
    raw = os.environ.get("GCHAT_ZONAS", "")
    if raw.strip():
        try:
            data = json.loads(raw)
            if not isinstance(data, list):
                raise ValueError("GCHAT_ZONAS debe ser un array JSON")
            zonas = []
            for z in data:
                zonas.append({
                    "nombre": str(z["nombre"]),
                    "lat": float(z["lat"]),
                    "lon": float(z["lon"]),
                    "region": str(z.get("region") or ""),
                    "legacy": False,
                })
            return zonas
        except (json.JSONDecodeError, KeyError, TypeError, ValueError):
            print("[gchat] GCHAT_ZONAS malformada (JSON inválido o falta nombre/lat/lon), ignorando")
            return []

    if GCHAT_ZONA_LAT is not None and GCHAT_ZONA_LON is not None:
        return [{
            "nombre": "zona", "lat": GCHAT_ZONA_LAT, "lon": GCHAT_ZONA_LON,
            "region": GCHAT_ZONA_REGION, "legacy": True,
        }]
    return []


def _eventos_sismos() -> list[dict]:
    cutoff = datetime.now(timezone.utc) - timedelta(hours=VENTANA_SISMO_H)
    eventos = []
    for ev in _load_json(SISMOS_PATH).get("eventos", []):
        mag = ev.get("mag")
        lat, lon = ev.get("lat"), ev.get("lon")
        if mag is None or lat is None or lon is None:
            continue
        try:
            t = datetime.strptime(ev["utc_time"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        if t < cutoff:
            continue
        pager = (ev.get("pager") or "").lower()
        nacional = mag >= MAG_ALTA or (mag >= MAG_PAGER and pager in PAGER_NIVELES)
        if not nacional and mag < MAG_MIN_ZONA_PISO:
            continue  # ni nacional ni candidato a ninguna sub de zona
        ref = ev.get("ref") or "Chile"
        titulo = f"🌊 Sismo M{mag:.1f} — {ref}"
        eventos.append({
            "id": f"sismo:{ev['id']}", "titulo": titulo, "body": ACCION, "url": SITE_URL,
            "tipo": "sismo", "mag": mag, "lat": lat, "lon": lon, "nacional": nacional,
            "ref": ref, "utc_time": t,
        })
    return eventos


def _eventos_alertas() -> list[dict]:
    eventos = []
    for al in _load_json(ALERTAS_PATH).get("alertas", []):
        if al.get("nivel") != "roja":
            continue
        categoria = al.get("categoria", "")
        region = al.get("region") or "Chile"
        desde = al.get("desde") or ""
        event_id = f"alerta:{categoria}:{region}:{desde}"
        titulo = f"🔴 Alerta Roja — {al.get('evento') or categoria} en {region}"
        eventos.append({
            "id": event_id, "titulo": titulo, "body": ACCION, "url": SITE_URL,
            "tipo": "regional", "lat": al.get("lat"), "lon": al.get("lon"),
        })
    return eventos


def _eventos_volcanes() -> list[dict]:
    eventos = []
    for v in _load_json(VOLCANES_PATH).get("volcanes", []):
        nivel = v.get("nivel")
        if nivel not in VOLCAN_NIVELES:
            continue
        nombre = v.get("nombre") or "?"
        eventos.append({
            "id": f"volcan:{nombre}:{nivel}", "titulo": f"🌋 Volcán {nombre} en alerta {nivel}",
            "body": ACCION, "url": SITE_URL, "tipo": "regional", "lat": v.get("lat"), "lon": v.get("lon"),
        })
    return eventos


def _eventos_tsunami() -> list[dict]:
    data = _load_json(TSUNAMI_PATH)
    if data.get("estado") != "amenaza":
        return []
    b = data.get("boletin") or {}
    event_id = f"tsunami:{b.get('evento')}:{b.get('area')}:{b.get('emitido')}"
    titulo = "🌊 AMENAZA DE TSUNAMI — evacúa la costa"
    body = "Sigue las instrucciones oficiales (SHOA/SENAPRED) y aléjate de la costa"
    # Amenaza de tsunami: siempre a todos, nunca se filtra por zona/distancia.
    return [{"id": event_id, "titulo": titulo, "body": body, "url": SITE_URL, "tipo": "tsunami"}]


def _eventos_tsunami_gchat(con: sqlite3.Connection) -> list[dict]:
    """Tsunami amenaza y precaución (a diferencia del push, que solo manda
    amenaza). El id de precaución no tiene un boletín estable como amenaza
    (puede depender solo del cruce sísmico interno de tsunami.py), así que
    se rastrea la transición de estado en `slack_estado`: mientras el
    estado no cambie, el id es estable (dedup real); al salir del estado
    (o cambiar a otro), se genera un id nuevo — igual que watchdog.py hace
    con su propio archivo de estado, pero aquí vive en push.db.
    NACIONAL: se envía una sola vez sin importar cuántas zonas haya."""
    data = _load_json(TSUNAMI_PATH)
    estado = data.get("estado")
    if estado not in ("amenaza", "precaucion"):
        con.execute("DELETE FROM slack_estado WHERE clave = 'tsunami'")
        con.commit()
        return []

    row = con.execute("SELECT valor, since FROM slack_estado WHERE clave = 'tsunami'").fetchone()
    if row and row[0] == estado:
        since = row[1]
    else:
        since = datetime.now(timezone.utc).isoformat()
        con.execute(
            "INSERT INTO slack_estado(clave, valor, since) VALUES ('tsunami', ?, ?) "
            "ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, since = excluded.since",
            (estado, since))
        con.commit()

    if estado == "amenaza":
        mensaje = data.get("mensaje") or "Amenaza de tsunami vigente para Chile"
        texto = (
            f"🌊 *AMENAZA DE TSUNAMI* — {mensaje}. EVACÚA la costa AHORA, a pie (nunca en auto): sube a 30 "
            "metros sobre el nivel del mar o aléjate 2 km del mar. No esperes sirenas ni confirmación. "
            "Autoridad oficial: SHOA/SENAPRED. Radio local: Bío-Bío 94.5 FM (Gran Valparaíso — dato "
            "verificado 2026; Cooperativa YA NO transmite en el dial de Valparaíso). Vías de evacuación: "
            "https://vigia.cavara.cl (capa Evacuación).")
    else:
        texto = (
            "🌊 *Precaución de tsunami* — sismo mayor costero reciente. Aléjate de la playa y mantente "
            "atento; si el sismo te impidió mantenerte en pie o duró más de 1 minuto, evacúa sin esperar "
            "confirmación.")
    return [{"id": f"tsunami:{estado}:{since}", "texto": f"{texto}\n{FRASE_CIERRE}"}]


def _eventos_sismos_gchat_nacional(sismos_base: list[dict], zonas: list[dict]) -> list[dict]:
    """Sismos de registro nacional (M≥6.5 o PAGER amarillo+): UN solo mensaje
    (endpoint slack:nacional) sin importar cuántas zonas haya configuradas.
    Si el epicentro cae a <=RADIO_KM_ZONA de alguna zona, el texto agrega la
    advertencia de evacuación y nombra la(s) zona(s) cercana(s); si no, va un
    texto informativo sin acción de zona (no hay una zona a la que referir)."""
    eventos = []
    for ev in sismos_base:
        if not ev["nacional"]:
            continue
        hora = ev["utc_time"].astimezone(CL_TZ).strftime("%H:%M")
        cercanas = [z["nombre"] for z in zonas
                    if _dist_km(z["lat"], z["lon"], ev["lat"], ev["lon"]) <= RADIO_KM_ZONA]
        base = f"🌎 *Sismo M{ev['mag']:.1f}* — {ev['ref']}, {hora} hora local."
        if cercanas:
            texto = (f"{base} Cerca de {', '.join(cercanas)}: si el sismo te impidió mantenerte en pie o "
                      "duró más de un minuto, aléjate de la playa y evacúa sin esperar confirmación oficial.")
        else:
            texto = f"{base} Sismo de registro nacional; no requiere acción inmediata."
        eventos.append({"id": ev["id"], "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _eventos_sismos_gchat_zona(sismos_base: list[dict], zona: dict) -> list[dict]:
    """Sismos LOCALES de esta zona: M≥5.5 dentro de 200 km (vía `_cumple`),
    excluidos los nacionales (esos van una sola vez por
    `_eventos_sismos_gchat_nacional`, no se duplican aquí)."""
    sub = {"lat": zona["lat"], "lon": zona["lon"], "radio_km": None, "mag_min": None}
    eventos = []
    for ev in sismos_base:
        if ev["nacional"] or not _cumple(ev, sub):
            continue
        hora = ev["utc_time"].astimezone(CL_TZ).strftime("%H:%M")
        texto = (
            f"🌎 *[{zona['nombre']}] Sismo M{ev['mag']:.1f}* — {ev['ref']}, {hora} hora local. Si el sismo "
            "te impidió mantenerte en pie o duró más de un minuto, aléjate de la playa y evacúa sin esperar "
            "confirmación oficial.")
        eventos.append({"id": ev["id"], "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _texto_alerta_gchat(al: dict, prefijo: str = "") -> str:
    nivel = al.get("nivel")
    region = al.get("region") or "Chile"
    evento = al.get("evento") or al.get("categoria", "")
    comunas = al.get("comunas") or []
    resumen_comunas = ", ".join(comunas[:3]) + (f" y {len(comunas) - 3} más" if len(comunas) > 3 else "")
    emoji = "🔴" if nivel == "roja" else "🟡"
    lugar = f"{region} ({resumen_comunas})" if resumen_comunas else region
    return (
        f"{emoji} {prefijo}*Alerta {nivel.capitalize()} SENAPRED* — {evento} en {lugar}.\n"
        f"{EXPLICA_NIVEL.get(nivel, '')}\n{_explica_evento(evento)}\n"
        f"Detalle oficial: {SENAPRED_URL}")


def _eventos_alertas_gchat_nacional(alertas: list[dict]) -> list[dict]:
    """Rojas de cualquier región: UN solo mensaje (endpoint slack:nacional)."""
    eventos = []
    for al in alertas:
        if al.get("nivel") != "roja":
            continue
        categoria, region = al.get("categoria", ""), al.get("region") or "Chile"
        desde = al.get("desde") or ""
        texto = _texto_alerta_gchat(al)
        eventos.append({"id": f"alerta:{categoria}:{region}:{desde}", "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _eventos_alertas_gchat_zona(zona: dict, alertas: list[dict]) -> list[dict]:
    """Amarillas de la región de esta zona únicamente (nunca temprana
    preventiva, es spam). Sin región configurada, la zona no recibe
    amarillas (las rojas siguen llegando igual vía el canal nacional)."""
    if not zona.get("region"):
        return []
    eventos = []
    for al in alertas:
        if al.get("nivel") != "amarilla" or (al.get("region") or "Chile") != zona["region"]:
            continue
        categoria, region = al.get("categoria", ""), al.get("region") or "Chile"
        desde = al.get("desde") or ""
        texto = _texto_alerta_gchat(al, prefijo=f"[{zona['nombre']}] ")
        eventos.append({"id": f"alerta:{categoria}:{region}:{desde}", "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _eventos_volcanes_gchat() -> list[dict]:
    """NACIONAL: alerta de volcán no tiene una zona natural (el radio de
    peligro real depende del volcán, no de RADIO_KM_ZONA) — se manda una
    sola vez, igual que antes de multi-zona."""
    eventos = []
    for ev in _eventos_volcanes():
        nombre = ev["id"].split(":")[1]
        nivel = ev["id"].split(":")[2]
        texto = (
            f"🌋 *Volcán {nombre}* en alerta {nivel}. Si estás en zona de peligro del volcán, revisa la "
            "capa Volcanes y los puntos de encuentro en Vigía.")
        eventos.append({"id": ev["id"], "texto": f"{texto}\n{FRASE_CIERRE}"})
    return eventos


def _dia_relativo(fecha, hoy) -> str:
    delta = (fecha - hoy).days
    if delta == 0:
        return "hoy"
    if delta == 1:
        return "mañana"
    if delta == 2:
        return "pasado mañana"
    return fecha.strftime("%d-%m")


def _eventos_avisos_gchat(zona: dict, avisos: list[dict]) -> list[dict]:
    """Avisos Vigía (propios, no oficiales) de estaciones a <=RADIO_KM_AVISO_ZONA
    de la zona Y en su misma región (ver _misma_region), cualquier nivel
    (amarillo incluido).

    Dedup/escalada: event_id = aviso:{estacion_id}:{tipo}:{fecha-local}:{nivel}.
    Mientras el aviso siga en el mismo nivel el mismo día, el id no cambia
    (aunque el valor fluctúe entre corridas) → no se reenvía. Si el nivel
    sube (amarillo→naranja→rojo) el id cambia → se envía de nuevo,
    notificando la escalada. Si baja, el id vuelve a uno ya enviado ese día
    → no se reenvía (ya se avisó de ese nivel).

    Devuelve datos estructurados (no texto ya armado): `_digest_zona_gchat`
    los ordena y agrupa en un solo mensaje por zona en vez de mandar uno por
    aviso (ver PR fix/slack-digest-por-zona — un frente de lluvia genera un
    aviso por estación, decenas por ciclo)."""
    eventos = []
    for a in avisos:
        lat, lon = a.get("lat"), a.get("lon")
        if lat is None or lon is None:
            continue
        if _dist_km(zona["lat"], zona["lon"], lat, lon) > RADIO_KM_AVISO_ZONA:
            continue
        if not _misma_region(zona["lat"], zona["lon"], lat, lon):
            continue
        try:
            peak_utc = datetime.strptime(a["hora_peak"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        peak_local = peak_utc.astimezone(CL_TZ)
        hoy = datetime.now(CL_TZ).date()
        dia = _dia_relativo(peak_local.date(), hoy)
        hora = peak_local.strftime("%H:%M")
        etiqueta = AVISO_TIPO_LABEL_GCHAT.get(a["tipo"], a["tipo"])
        acuerdo = f" (acuerdo {a['acuerdo']} modelos)" if a.get("acuerdo") else ""
        linea = (
            f"• {a['nivel']} · {etiqueta} {a['valor']} {a['unidad']} peak {dia} {hora}"
            f" — {a['nombre']}{acuerdo}")
        fecha_local = peak_local.strftime("%Y-%m-%d")
        event_id = f"aviso:{a['estacion_id']}:{a['tipo']}:{fecha_local}:{a['nivel']}"
        eventos.append({
            "id": event_id, "tipo": a["tipo"], "nivel": a["nivel"],
            "valor": a["valor"], "linea": linea,
        })
    return eventos


def _eventos_incendios_gchat(zona: dict, focos: list[dict]) -> list[dict]:
    """Focos de calor FIRMS a <=RADIO_KM_INCENDIO_ZONA de la zona Y en su
    misma región (ver _misma_region).

    Dedup: los focos FIRMS se re-detectan en cada pasada satelital, así que
    el event_id agrupa por celda (~1 km, lat/lon redondeados a 2 decimales)
    y fecha local — avisa un foco nuevo en esa celda una vez por día, sin
    repetir el mismo foco todo el día en cada pasada.

    Devuelve datos estructurados (no texto ya armado), igual que
    `_eventos_avisos_gchat` — ver `_digest_zona_gchat`."""
    eventos = []
    for f in focos:
        lat, lon = f.get("lat"), f.get("lon")
        if lat is None or lon is None:
            continue
        dist = _dist_km(zona["lat"], zona["lon"], lat, lon)
        if dist > RADIO_KM_INCENDIO_ZONA:
            continue
        if not _misma_region(zona["lat"], zona["lon"], lat, lon):
            continue
        try:
            acq = datetime.strptime(f["utc"], "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc)
        except (KeyError, ValueError):
            continue
        acq_local = acq.astimezone(CL_TZ)
        celda_lat, celda_lon = round(lat, 2), round(lon, 2)
        fecha_local = acq_local.strftime("%Y-%m-%d")
        event_id = f"incendio:{celda_lat}:{celda_lon}:{fecha_local}"
        rumbo = _rumbo(zona["lat"], zona["lon"], lat, lon)
        eventos.append({
            "id": event_id, "dist": dist, "rumbo": rumbo,
            "hora": acq_local.strftime("%H:%M"),
        })
    return eventos


def _digest_zona_gchat(zona: dict, avisos_nuevos: list[dict], focos_nuevos: list[dict]) -> str | None:
    """Arma UN solo mensaje con los avisos Vigía y focos de incendio
    NUEVOS de esta zona en el ciclo (ya pasaron el dedup, ver _procesar_gchat).
    None si no hay nada nuevo — nunca se manda un "resumen vacío".

    Avisos: ordenados de peor a mejor nivel (rojo>naranja>amarillo) y por
    valor dentro del nivel; máx MAX_AVISOS_DIGEST líneas, el resto se resume
    en "… y N más". El emoji del encabezado es el del tipo de aviso más
    severo (mismo criterio que EXPLICA_EVENTO: no inventar un tono nuevo).
    La marca "aviso propio, no oficial" va UNA vez en el encabezado.

    Incendios: sección propia en el mismo mensaje si hay focos nuevos,
    tope MAX_FOCOS_DIGEST items."""
    partes = []

    if avisos_nuevos:
        avisos_ordenados = sorted(
            avisos_nuevos, key=lambda a: (-NIVEL_RANGO_GCHAT.get(a["nivel"], 0), -a["valor"]))
        conteos = Counter(a["nivel"] for a in avisos_nuevos)
        resumen_niveles = ", ".join(
            f"{conteos[n]} {n}s" for n in ("rojo", "naranja", "amarillo") if conteos.get(n))
        emoji = AVISO_EMOJI_GCHAT.get(avisos_ordenados[0]["tipo"], "⚠️")
        plural = len(avisos_nuevos) != 1
        encabezado = (
            f"{emoji} [{zona['nombre']}] {len(avisos_nuevos)} {'avisos' if plural else 'aviso'} Vigía"
            f" {'nuevos' if plural else 'nuevo'} en tu radio ({resumen_niveles}) — aviso propio, no oficial")
        lineas = [a["linea"] for a in avisos_ordenados[:MAX_AVISOS_DIGEST]]
        restantes = len(avisos_ordenados) - len(lineas)
        if restantes > 0:
            lineas.append(f"… y {restantes} más (ver mapa en vigia.cavara.cl)")
        partes.append("\n".join([encabezado] + lineas))

    if focos_nuevos:
        prefijo_zona = "" if avisos_nuevos else f"[{zona['nombre']}] "
        items = [f"a {round(f['dist'])} km al {f['rumbo']} ({f['hora']} h)"
                 for f in focos_nuevos[:MAX_FOCOS_DIGEST]]
        restantes = len(focos_nuevos) - len(items)
        if restantes > 0:
            items.append(f"… y {restantes} más")
        partes.append(
            f"🔥 {prefijo_zona}{len(focos_nuevos)} focos nuevos (satélite NASA, foco de calor no confirmado): "
            + ", ".join(items))

    if not partes:
        return None
    return "\n\n".join(partes)


def _eventos_nacionales_gchat(con: sqlite3.Connection, sismos_base: list[dict],
                               zonas: list[dict], alertas: list[dict]) -> list[dict]:
    return (
        _eventos_tsunami_gchat(con)
        + _eventos_sismos_gchat_nacional(sismos_base, zonas)
        + _eventos_alertas_gchat_nacional(alertas)
        + _eventos_volcanes_gchat()
    )


def _eventos_zona_gchat_individuales(sismos_base: list[dict], zona: dict, alertas: list[dict]) -> list[dict]:
    """Eventos de zona que siguen yendo individuales: sismos locales y
    alertas SENAPRED amarillas — son raros y urgentes, no ameritan digest
    (a diferencia de avisos Vigía/incendios, ver `_digest_zona_gchat`)."""
    return (
        _eventos_sismos_gchat_zona(sismos_base, zona)
        + _eventos_alertas_gchat_zona(zona, alertas)
    )


def _dedup_pendiente(event_id: str, endpoint: str, endpoints_legacy: list[str],
                      ya_enviados: set[tuple[str, str]]) -> bool:
    """True si `event_id` NO se ha enviado aún bajo `endpoint` ni bajo
    ninguno de los `endpoints_legacy` (esquema pre multi-zona)."""
    if (event_id, endpoint) in ya_enviados:
        return False
    return not any((event_id, ep) in ya_enviados for ep in endpoints_legacy)


def _enviar_dedup(con: sqlite3.Connection, event_id: str, texto: str, endpoint: str,
                   endpoints_legacy: list[str], ya_enviados: set[tuple[str, str]]) -> None:
    """Envía un evento del canal interno con dedup por (event_id, endpoint) y
    además consulta `endpoints_legacy` (endpoints del esquema pre multi-zona)
    para no reenviar algo ya notificado antes de esa migración."""
    if not _dedup_pendiente(event_id, endpoint, endpoints_legacy, ya_enviados):
        return
    if _post_gchat(texto):
        con.execute(
            "INSERT OR IGNORE INTO sent(event_id, endpoint, sent_at) VALUES (?, ?, datetime('now'))",
            (event_id, endpoint))
        con.commit()
        ya_enviados.add((event_id, endpoint))


def _enviar_digest_zona(con: sqlite3.Connection, zona: dict, endpoint: str,
                         avisos_nuevos: list[dict], focos_nuevos: list[dict],
                         ya_enviados: set[tuple[str, str]]) -> None:
    """Manda el digest de avisos+incendios nuevos de la zona en UN mensaje y,
    si el POST tuvo éxito, marca cada event_id incluido como enviado bajo
    `endpoint` — el dedup sigue siendo por evento individual, el digest solo
    cambia el empaque de envío."""
    texto = _digest_zona_gchat(zona, avisos_nuevos, focos_nuevos)
    if texto is None:
        return
    if not _post_gchat(texto):
        return
    for ev in avisos_nuevos + focos_nuevos:
        con.execute(
            "INSERT OR IGNORE INTO sent(event_id, endpoint, sent_at) VALUES (?, ?, datetime('now'))",
            (ev["id"], endpoint))
        ya_enviados.add((ev["id"], endpoint))
    con.commit()


def _procesar_gchat(con: sqlite3.Connection, sismos_base: list[dict], ya_enviados: set[tuple[str, str]]) -> None:
    """Suscriptor de canal interno multi-zona: independiente de si hay
    suscripciones Web Push (no depende de la tabla `subs`)."""
    if not GCHAT_WEBHOOK_ALERTAS:
        return
    zonas = _cargar_zonas()
    if not zonas:
        return

    alertas = _load_json(ALERTAS_PATH).get("alertas", [])
    avisos = _load_json(AVISOS_PATH).get("avisos", [])
    focos = _load_json(INCENDIOS_PATH).get("focos", [])

    for ev in _eventos_nacionales_gchat(con, sismos_base, zonas, alertas):
        _enviar_dedup(con, ev["id"], ev["texto"], ENDPOINT_NACIONAL, [ENDPOINT_ZONA_LEGACY], ya_enviados)

    for zona in zonas:
        # Prefijo `slack:` histórico: clave de dedup ya persistida, no destino.
        endpoint = f"slack:zona:{zona['nombre']}"
        endpoints_legacy = [ENDPOINT_ZONA_LEGACY] if zona.get("legacy") else []

        for ev in _eventos_zona_gchat_individuales(sismos_base, zona, alertas):
            _enviar_dedup(con, ev["id"], ev["texto"], endpoint, endpoints_legacy, ya_enviados)

        avisos_nuevos = [a for a in _eventos_avisos_gchat(zona, avisos)
                          if _dedup_pendiente(a["id"], endpoint, endpoints_legacy, ya_enviados)]
        focos_nuevos = [f for f in _eventos_incendios_gchat(zona, focos)
                         if _dedup_pendiente(f["id"], endpoint, endpoints_legacy, ya_enviados)]
        _enviar_digest_zona(con, zona, endpoint, avisos_nuevos, focos_nuevos, ya_enviados)


def _evento_kit(ahora: datetime) -> dict:
    """Recordatorio semestral opcional (kit_reminder=1). id sintético
    kit:{YYYY}-{H1|H2} — cambia solo dos veces al año, así que `sent`
    lo dedup-ea de forma natural igual que cualquier otro evento."""
    semestre = "H1" if ahora.month <= 6 else "H2"
    return {
        "id": f"kit:{ahora.year}-{semestre}",
        "titulo": "¿Tu kit de emergencia sigue al día?",
        "body": "Revisa vencimientos de agua, pilas, medicamentos y comida (72 h por persona).",
        "url": KIT_URL, "tipo": "kit",
    }


def _cumple(ev: dict, sub: dict) -> bool:
    """Decide si una suscripción concreta debe recibir el evento."""
    tipo = ev["tipo"]
    if tipo == "tsunami":
        return True

    lat, lon = sub.get("lat"), sub.get("lon")
    con_ubicacion = lat is not None and lon is not None

    if tipo == "sismo":
        if not con_ubicacion:
            return ev["nacional"]
        if ev["nacional"]:
            return True
        radio = sub.get("radio_km") or RADIO_KM_ZONA
        umbral = sub.get("mag_min") or MAG_MIN_ZONA
        if ev["mag"] < umbral or _dist_km(lat, lon, ev["lat"], ev["lon"]) > radio:
            return False
        # Tope regional (además del radio): un sismo fuera de la región de la
        # sub no pushea aunque caiga dentro del radio — ej. Illapel (Coquimbo)
        # a ~180 km de Viña del Mar (Valparaíso) entraba en el radio de 200 km
        # por defecto. Cruces de borde cercanos (ej. Til Til, RM, a ~50 km de
        # Viña) también quedan fuera: trade-off aceptado, ver _misma_region.
        return _misma_region(lat, lon, ev["lat"], ev["lon"])

    # "regional": alertas rojas y volcanes naranja+. Sin ubicación en la sub
    # -> broadcast (comportamiento original). Con ubicación -> filtrar por
    # distancia, salvo que el propio evento no traiga coords (centroide no
    # calculable): ahí tampoco se puede filtrar, así que va a todos.
    if not con_ubicacion:
        return True
    if ev.get("lat") is None or ev.get("lon") is None:
        return True
    radio = sub.get("radio_km") or RADIO_KM_ZONA
    return _dist_km(lat, lon, ev["lat"], ev["lon"]) <= radio


def _ensure_schema(con: sqlite3.Connection) -> None:
    con.execute(
        "CREATE TABLE IF NOT EXISTS subs("
        "endpoint TEXT PRIMARY KEY, p256dh TEXT, auth TEXT, created TEXT)"
    )
    for ddl in (
        "ALTER TABLE subs ADD COLUMN lat REAL",
        "ALTER TABLE subs ADD COLUMN lon REAL",
        "ALTER TABLE subs ADD COLUMN radio_km INTEGER",
        "ALTER TABLE subs ADD COLUMN mag_min REAL",
        "ALTER TABLE subs ADD COLUMN kit_reminder INTEGER DEFAULT 0",
    ):
        try:
            con.execute(ddl)
        except sqlite3.OperationalError:
            pass

    # Migración: `sent` dedup-eaba por event_id global (un solo envío por
    # evento, a todas las subs). Ahora el envío se filtra por sub, así que el
    # dedup debe ser por (event_id, endpoint). Si existe el esquema viejo
    # (sin columna endpoint) se recrea: se pierde el historial de envíos ya
    # hechos, es decir en el peor caso se re-notifica una vez algo que ya se
    # había mandado antes de esta migración — aceptado, documentado aquí.
    cols = [r[1] for r in con.execute("PRAGMA table_info(sent)")]
    if cols and "endpoint" not in cols:
        con.execute("DROP TABLE sent")
    con.execute(
        "CREATE TABLE IF NOT EXISTS sent("
        "event_id TEXT, endpoint TEXT, sent_at TEXT, PRIMARY KEY(event_id, endpoint))"
    )
    # Estado de transición del suscriptor de canal interno (ver
    # _eventos_tsunami_gchat): solo lo usa "tsunami" hoy, pero se deja genérico
    # por clave. El nombre `slack_estado` es histórico y se conserva a propósito
    # — renombrar la tabla al migrar a Google Chat habría descartado el estado
    # vigente y reenviado un tsunami en curso (ver docstring del módulo).
    con.execute(
        "CREATE TABLE IF NOT EXISTS slack_estado("
        "clave TEXT PRIMARY KEY, valor TEXT, since TEXT)"
    )
    con.commit()


def _enviar_evento(con: sqlite3.Connection, subs: list[tuple[str, str, str]], titulo: str, body: str, url: str) -> tuple[set[str], set[str]]:
    """Envía a la lista de suscripciones ya filtrada para este evento.
    Devuelve (caducados, fallidos): caducados son los endpoints 404/410 (la
    sub ya se borró, no tiene sentido reintentar); fallidos son los que
    tuvieron un error transitorio (red, 5xx, firma) y deben reintentarse en
    el próximo ciclo de cron — el caller no debe marcarlos como enviados."""
    payload = json.dumps({"title": titulo, "body": body, "url": url})
    vapid_private_key = os.environ["VAPID_PRIVATE_KEY"]
    caducados = set()
    fallidos = set()

    for endpoint, p256dh, auth in subs:
        sub_info = {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}
        try:
            webpush(
                subscription_info=sub_info,
                data=payload,
                vapid_private_key=vapid_private_key,
                vapid_claims={"sub": VAPID_SUB},
            )
        except WebPushException as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status in (404, 410):
                con.execute("DELETE FROM subs WHERE endpoint = ?", (endpoint,))
                con.commit()
                caducados.add(endpoint)
                print(f"[push] suscripción caducada ({status}), eliminada: {endpoint[:48]}...")
            else:
                fallidos.add(endpoint)
                print(f"[push] error enviando a {endpoint[:48]}...: {exc}")
        except Exception as exc:  # red/DNS/cifrado: nunca debe tumbar el cron
            fallidos.add(endpoint)
            print(f"[push] error inesperado enviando a {endpoint[:48]}...: {exc}")

    return caducados, fallidos


def seleccionar(eventos: list[dict], subs: list[tuple], ya_enviados: set[tuple[str, str]]) -> list[tuple[dict, list[tuple[str, str, str]]]]:
    """Para cada evento, arma la lista de (endpoint,p256dh,auth) que debe
    recibirlo: cumple su criterio (`_cumple`, o kit_reminder=1 para el
    recordatorio de kit) y no está ya en `sent`. Separado de `main()` para
    poder probarlo sin enviar de verdad (ver push/send.py bajo test)."""
    resultado = []
    for ev in eventos:
        destinatarios = []
        for endpoint, p256dh, auth, lat, lon, radio_km, mag_min, kit_reminder in subs:
            if (ev["id"], endpoint) in ya_enviados:
                continue
            if ev["tipo"] == "kit":
                if kit_reminder != 1:
                    continue
            else:
                sub = {"lat": lat, "lon": lon, "radio_km": radio_km, "mag_min": mag_min}
                if not _cumple(ev, sub):
                    continue
            destinatarios.append((endpoint, p256dh, auth))
        if destinatarios:
            resultado.append((ev, destinatarios))
    return resultado


def main() -> None:
    ahora = datetime.now(timezone.utc)
    sismos_base = _eventos_sismos()
    eventos = sismos_base + _eventos_alertas() + _eventos_volcanes() + _eventos_tsunami()
    eventos.append(_evento_kit(ahora))

    con = sqlite3.connect(DB_PATH)
    _ensure_schema(con)

    ya_enviados = {(r[0], r[1]) for r in con.execute("SELECT event_id, endpoint FROM sent").fetchall()}

    # El suscriptor de canal interno no depende de que existan subs de Web Push.
    _procesar_gchat(con, sismos_base, ya_enviados)

    subs = con.execute(
        "SELECT endpoint, p256dh, auth, lat, lon, radio_km, mag_min, kit_reminder FROM subs"
    ).fetchall()
    if not subs:
        con.close()
        return

    if not VAPID_SUB:
        print("[push] VAPID_SUB no configurada (formato mailto:correo): los envíos a "
              "endpoints FCM (Chrome) van a fallar con 'Missing sub from claims'")

    caducados_global: set[str] = set()
    for ev, destinatarios in seleccionar(eventos, subs, ya_enviados):
        destinatarios = [d for d in destinatarios if d[0] not in caducados_global]
        if not destinatarios:
            continue
        caducados, fallidos = _enviar_evento(con, destinatarios, ev["titulo"], ev["body"], ev["url"])
        for endpoint, _, _ in destinatarios:
            if endpoint in fallidos:
                continue  # error transitorio: no se marca, el próximo ciclo de cron reintenta
            con.execute(
                "INSERT OR IGNORE INTO sent(event_id, endpoint, sent_at) VALUES (?, ?, datetime('now'))",
                (ev["id"], endpoint),
            )
        con.commit()
        caducados_global |= caducados

    con.close()


def _cli() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-zona", action="store_true",
                     help="manda un único mensaje de prueba al webhook real y termina (no toca `sent`)")
    args = ap.parse_args()

    if args.test_zona:
        if not GCHAT_WEBHOOK_ALERTAS:
            print("[gchat] GCHAT_WEBHOOK_ALERTAS no configurada, nada que probar")
            return 1
        return 0 if _post_gchat(MENSAJE_PRUEBA_ZONA) else 1

    main()
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
