"""Vigilancia de frescura de los JSON críticos, con aviso a Slack.

Hoy nadie se entera si la ingesta muere o una fuente de peligro lleva horas
caída (cero monitoreo; el smoke test solo corre al deployar). Este script,
pensado para correr cada 10 min por cron, compara el campo "updated" de
cada JSON crítico contra un umbral propio y avisa por Slack solo en las
transiciones (anti-spam pedido explícito): al ENTRAR en falla, cada 6 h de
recordatorio mientras siga caído, y al recuperarse.

No es un paso de la ingesta (no fetchea nada externo ni escribe en la BD):
es un monitor independiente, igual que push/send.py — se invoca directo
desde cron, no se integra a run.py.

Patrón "dormido" (igual que combustible.py): sin SLACK_BOT_TOKEN ni
SLACK_WEBHOOK_URL, exit 0 silencioso — no es un error, es que el operador no
configuró avisos.

Transporte: bot Heraldo (chat.postMessage) si hay SLACK_BOT_TOKEN; si falla
o no está configurado, reintenta por el webhook — Vigía no puede quedar sin
ruta de envío mientras el bot no esté invitado a todos los canales.

Doble envío (migración 2026-08-16): el mismo aviso sale además al espacio
`alertas` de Google Chat vía GCHAT_WEBHOOK_ALERTAS, sin retirar nada de
Slack. El veredicto que decide las transiciones de estado sigue siendo el de
Slack (ver `_notificar`), para que el canal nuevo no pueda provocar
re-notificaciones si falla.

Nunca debe filtrar el webhook ni el token: urllib incluye la URL completa
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


def _post_slack(texto: str) -> bool:
    """Manda `texto` a Slack: bot Heraldo (chat.postMessage) si hay
    SLACK_BOT_TOKEN; si falla (ej. canal sin invitar) o no hay token,
    reintenta por el webhook como red de seguridad. Nunca propaga la
    URL/token en el error."""
    if config.SLACK_BOT_TOKEN and _post_slack_bot(texto):
        return True
    if config.SLACK_WEBHOOK_URL:
        return _post_slack_webhook(texto)
    return False


def _post_slack_bot(texto: str) -> bool:
    body = json.dumps({"channel": config.SLACK_CHANNEL_ID, "text": texto}).encode("utf-8")
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {config.SLACK_BOT_TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read())
            if not data.get("ok"):
                print(f"[error] slack bot: {data.get('error', 'desconocido')}", file=sys.stderr)
            return bool(data.get("ok"))
    except urllib.error.HTTPError as err:
        print(f"[error] slack bot: HTTP {err.code}", file=sys.stderr)
        return False
    except Exception:
        print("[error] slack bot: error de red", file=sys.stderr)
        return False


def _post_slack_webhook(texto: str) -> bool:
    body = json.dumps({"text": texto}).encode("utf-8")
    req = urllib.request.Request(
        config.SLACK_WEBHOOK_URL, data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        print(f"[error] slack webhook: HTTP {err.code}", file=sys.stderr)
        return False
    except Exception:
        print("[error] slack webhook: error de red", file=sys.stderr)
        return False


# Los webhooks de Google Chat no resuelven los shortcodes de emoji que sí
# entiende Slack: se traducen antes de enviar. Si aparece uno no listado se
# deja tal cual — un emoji sin convertir no es motivo para perder el aviso.
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
    """Manda `texto` al espacio `alertas` de Google Chat (doble envío,
    migración 2026-08-16). Best-effort a propósito: su resultado NO decide las
    transiciones de estado del watchdog — eso lo sigue mandando Slack — para que
    un fallo del canal nuevo no re-notifique ni silencie lo que ya funcionaba.
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
    """Doble envío: manda el mismo aviso a Slack y a Google Chat, y devuelve el
    veredicto de SLACK. Ese veredicto es el que decide si la transición queda
    registrada en el estado, así que el canal nuevo no puede alterarlo: si Chat
    fallara y mandara el resultado, el watchdog re-notificaría en la siguiente
    corrida un aviso que Slack ya entregó."""
    ok_slack = _post_slack(texto)
    _post_gchat(texto)
    return ok_slack


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

    if not (config.SLACK_BOT_TOKEN or config.SLACK_WEBHOOK_URL
            or config.GCHAT_WEBHOOK_ALERTAS):
        return 0

    if args.test:
        return 0 if _notificar("✅ Vigía watchdog operativo — mensaje de prueba") else 1

    return run()


if __name__ == "__main__":
    sys.exit(main())
