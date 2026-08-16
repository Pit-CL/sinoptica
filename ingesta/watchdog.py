"""Vigilancia de frescura de los JSON críticos, con aviso a Google Chat.

Hoy nadie se entera si la ingesta muere o una fuente de peligro lleva horas
caída (cero monitoreo; el smoke test solo corre al deployar). Este script,
pensado para correr cada 10 min por cron, compara el campo "updated" de
cada JSON crítico contra un umbral propio y avisa solo en las
transiciones (anti-spam pedido explícito): al ENTRAR en falla, cada 6 h de
recordatorio mientras siga caído, y al recuperarse.

No es un paso de la ingesta (no fetchea nada externo ni escribe en la BD):
es un monitor independiente, igual que push/send.py — se invoca directo
desde cron, no se integra a run.py.

Patrón "dormido" (igual que combustible.py): sin GCHAT_WEBHOOK_ALERTAS,
exit 0 silencioso — no es un error, es que el operador no configuró avisos.

Transporte: webhook del espacio `alertas` de Google Chat. Es el único desde
el 2026-08-16: el envío a Slack se retiró al cancelarse Slack Pro.

El veredicto de la entrega decide las transiciones de estado (ver
`_notificar`): `run()` solo registra la transición si el aviso salió de
verdad, así que un fallo del canal hace reintentar en la corrida siguiente en
vez de dar por avisado algo que nadie vio.

Nunca debe filtrar el webhook: urllib incluye la URL completa
en sus excepciones, así que el manejo de errores solo reporta "HTTP
<código>" o "error de red", jamás el error crudo (que trae la URL/token).
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import config

RECORDATORIO_HORAS = 6

# (clave, path, umbral_min, nombre legible, qué implica para el usuario)
CHECKS = [
    ("tsunami", config.TSUNAMI_PATH, 30,
     "estado de amenaza de tsunami",
     "los usuarios están viendo el estado de tsunami de hace rato sin saberlo"),
    ("sismos", config.SISMOS_PATH, 30,
     "catálogo sísmico",
     "los usuarios están viendo sismos de hace rato sin saberlo"),
    ("alertas", config.ALERTAS_PATH, 180,
     "alertas SENAPRED vigentes",
     "el mapa de alertas puede estar mostrando información vencida"),
    ("incendios", config.INCENDIOS_PATH, 180,
     "focos de incendio activo (NASA FIRMS)",
     "la capa de incendios puede mostrar focos ya apagados o le pueden faltar focos nuevos"),
    ("estaciones", config.ESTACIONES_PATH, 240,
     "observaciones de estaciones (mapa en vivo)",
     "el mapa de estaciones puede estar mostrando datos viejos"),
    ("avisos", config.AVISOS_PATH, 240,
     "avisos meteorológicos",
     "los avisos meteorológicos pueden no reflejar el pronóstico actual"),
    ("volcanes", config.VOLCANES_PATH, 900,
     "alerta técnica volcánica (RNVV)",
     "el mapa de volcanes puede no reflejar la alerta técnica vigente"),
    ("marea", config.MAREA_PATH, 480,
     "marea, oleaje y temperatura del mar",
     "la capa de marea/oleaje puede estar mostrando un pronóstico vencido"),
    ("aire", config.AIRE_PATH, 240,
     "calidad del aire (SINCA)",
     "la capa de aire puede estar mostrando lecturas de MP2,5/MP10 viejas"),
    ("combustible", config.COMBUSTIBLE_PATH, 1560,
     "precios de combustible (CNE)",
     "los precios de bencina en el mapa pueden estar desactualizados"),
    ("tsunami_vias", config.TSUNAMI_VIAS_PATH, 12960,
     "vías de evacuación (SENAPRED)",
     "la capa de evacuación puede estar mostrando vías desactualizadas"),
    ("tsunami_areas", config.TSUNAMI_AREAS_PATH, 12960,
     "áreas de evacuación ante tsunami (SENAPRED)",
     "la capa de evacuación puede estar mostrando áreas desactualizadas"),
    ("emergencia", config.EMERGENCIA_PATH, 12960,
     "infraestructura de emergencia (SENAPRED)",
     "el mapa de postas/bomberos/carabineros puede estar mostrando datos desactualizados"),
    # A diferencia de los anteriores (JSON publicados con campo "updated"),
    # estos son los crudos que sube satelite/fetch_cl.py por scp — ver
    # ingesta/cortes.py y ingesta/farmacias.py. Si se congelan, cortes.json y
    # farmacias.json quedan sirviendo el último dato bueno marcado "stale"
    # sin que nadie se entere (incidente 2026-07-16: 22 h ciego hasta que
    # avisó la prensa, no el sistema). Checks separados: MINSAL puede caerse
    # con SEC sano (y viceversa), un solo archivo no cubre al otro.
    ("satelite", config.INCOMING_DIR / "sec.json", 60,
     "crudo de cortes de luz (SEC, satélite omen)",
     "los cortes de luz quedan congelados sin que nadie se entere"),
    # Umbral más holgado: el crudo viaja cada 15 min, pero su consumidor
    # (ingesta/farmacias.py, STALE_MIN de 26 h) corre 2x/día — una caída
    # transitoria de MINSAL no afecta al usuario y no amerita alerta.
    ("satelite-farmacias", config.INCOMING_DIR / "farmacias_raw.json", 240,
     "crudo de farmacias de turno (MINSAL, satélite omen)",
     "las farmacias de turno pueden quedar desactualizadas sin que nadie se entere"),
    # Esval viaja cada 15 min igual que SEC (mismo cron, ver satelite/fetch_cl.py)
    # y su consumidor (ingesta/esval.py) también usa STALE_MIN=30: mismo umbral
    # que satelite (sec.json).
    ("satelite-esval", config.INCOMING_DIR / "esval.json", 60,
     "crudo de cortes de agua (Esval, satélite omen)",
     "los cortes de agua quedan congelados sin que nadie se entere"),
]


def _leer_updated(path: Path):
    """Datetime UTC de frescura del archivo: campo "updated" (JSON
    publicados) o "fetched_utc" (crudo del satélite, ver satelite/fetch_cl.py).
    None si el archivo falta o no se puede parsear (ambos cuentan como falla)."""
    try:
        data = json.loads(path.read_text())
        if "updated" in data:
            return datetime.strptime(data["updated"], "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)
        return datetime.strptime(data["fetched_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _cargar_estado() -> dict:
    try:
        return json.loads(config.WATCHDOG_STATE_PATH.read_text())
    except Exception:
        return {}


def _guardar_estado(estado: dict) -> None:
    config.WATCHDOG_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.WATCHDOG_STATE_PATH.write_text(json.dumps(estado, ensure_ascii=False) + "\n")


# Los webhooks de Chat no resuelven los shortcodes de emoji que quedaron en los
# textos (herencia del formato de Slack): se traducen antes de enviar. Si
# aparece uno no listado se deja tal cual — un emoji sin convertir no es motivo
# para perder el aviso.
_GCHAT_EMOJI = {
    ":red_circle:": "🔴",
    ":large_green_circle:": "🟢",
    ":white_check_mark:": "✅",
    ":warning:": "⚠️",
    ":x:": "❌",
    ":robot_face:": "🤖",
    ":wrench:": "🔧",
}


def _post_gchat(texto: str) -> bool:
    """Manda `texto` al espacio `alertas` de Google Chat, único canal desde el
    2026-08-16 (se retiró Slack al cancelarse Slack Pro).

    Devuelve si la entrega se concretó de verdad, y eso ahora es crítico: este
    valor es el que decide si la transición queda registrada en el estado. Un
    `True` sin entrega perdería el aviso en silencio; un `False` con entrega
    hecha lo repetiría cada 10 minutos. Por eso el 2xx se mira explícitamente
    en vez de asumir éxito si no hubo excepción.

    Nunca propaga la URL del webhook en el error: lleva `key` y `token`."""
    if not config.GCHAT_WEBHOOK_ALERTAS:
        return False
    for corto, unicode_ in _GCHAT_EMOJI.items():
        texto = texto.replace(corto, unicode_)
    body = json.dumps({"text": f"[VIGIA] {texto}"}).encode("utf-8")
    req = urllib.request.Request(
        config.GCHAT_WEBHOOK_ALERTAS, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=UTF-8"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        print(f"[error] gchat: HTTP {err.code}", file=sys.stderr)
        return False
    except Exception:
        print("[error] gchat: error de red", file=sys.stderr)
        return False


def _notificar(texto: str) -> bool:
    """Envía el aviso y devuelve si se entregó. Queda como función propia,
    aunque hoy sea un solo canal, porque es el punto donde vive el invariante
    del anti-spam: `run()` solo registra la transición en el estado cuando esto
    devuelve verdadero, así que el valor TIENE que reflejar la entrega real.

    Cuando había doble envío, el veredicto era el de Slack (y luego el OR de
    ambos). Al retirarse Slack el 2026-08-16, pasa a ser el de Google Chat: es
    el movimiento que el propio código dejaba anotado como pendiente para este
    momento."""
    return _post_gchat(texto)


def _fmt_min(minutos: float) -> str:
    return f"{minutos:.0f} min" if minutos < 120 else f"{minutos / 60:.1f} h"


def run(now: datetime | None = None) -> int:
    now = now or datetime.now(timezone.utc)
    estado = _cargar_estado()
    cambios = False

    for clave, path, umbral_min, nombre, impacto in CHECKS:
        updated = _leer_updated(path)
        atraso_min = (now - updated).total_seconds() / 60 if updated else None
        fallando = atraso_min is None or atraso_min > umbral_min
        prev = estado.get(clave)

        if fallando and prev is None:
            # transición sano -> caído: notifica y arranca el conteo
            detalle = (f"hace {_fmt_min(atraso_min)}" if atraso_min is not None
                        else "el archivo no existe o no se pudo leer")
            texto = (
                f":red_circle: *Vigía* — {nombre} sin actualizar\n"
                f"Archivo: `{path.name}` — última actualización {detalle} (umbral: {umbral_min} min)\n"
                f"Implica: {impacto}\n"
                f"Revisa: `docker logs clima-ingesta` y el `ingesta.log`")
            if _notificar(texto):
                estado[clave] = {"since": now.isoformat(), "last_notified": now.isoformat()}
                cambios = True
        elif fallando and prev is not None:
            last_notified = datetime.fromisoformat(prev["last_notified"])
            if now - last_notified >= timedelta(hours=RECORDATORIO_HORAS):
                since = datetime.fromisoformat(prev["since"])
                caido_desde = _fmt_min((now - since).total_seconds() / 60)
                texto = (
                    f":red_circle: *Vigía* (recordatorio) — {nombre} sigue sin actualizar\n"
                    f"Archivo: `{path.name}` — caído desde hace {caido_desde}\n"
                    f"Revisa: `docker logs clima-ingesta` y el `ingesta.log`")
                if _notificar(texto):
                    prev["last_notified"] = now.isoformat()
                    cambios = True
        elif not fallando and prev is not None:
            texto = f":large_green_circle: *Vigía* — {nombre} se recuperó (`{path.name}`)"
            if _notificar(texto):
                del estado[clave]
                cambios = True

    if cambios:
        _guardar_estado(estado)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--test", action="store_true",
                     help="manda un único mensaje de prueba al webhook real y termina")
    args = ap.parse_args()

    # El gate mira el mismo canal del que sale el veredicto de `_notificar`, y
    # eso no es cosmético: si el watchdog corriera con el webhook sin
    # configurar, `_notificar` devolvería siempre False, `run()` nunca guardaría
    # el estado de la transición y volvería a intentar el aviso en cada corrida
    # —cada 10 min por el mismo archivo caído—. Dormido y en silencio es el
    # comportamiento correcto, igual que cuando el canal era Slack.
    if not config.GCHAT_WEBHOOK_ALERTAS:
        return 0

    if args.test:
        return 0 if _notificar("✅ Vigía watchdog operativo — mensaje de prueba") else 1

    return run()


if __name__ == "__main__":
    sys.exit(main())
