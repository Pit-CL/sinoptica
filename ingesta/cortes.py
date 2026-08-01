"""Cortes de luz SEC (interrupciones en línea) — vía satélite en omen.

No fetchea la red: SEC bloquea IPs de datacenter (verificado desde el VPS,
funciona desde omen). Lee el JSON crudo que `satelite/fetch_cl.py` sube por
scp a `INCOMING_DIR/sec.json` y lo agrega por comuna.

Endpoint no documentado (`apps.sec.cl/INTONLINEv1/ClientesAfectados/
GetPorFecha`): igual que la RNVV, se etiqueta best-effort. Estructura
verificada desde omen: lista de registros por comuna/empresa con el campo
`CLIENTES_AFECTADOS` (mayúsculas — convención típica de estas APIs
gubernamentales chilenas); `_campo()` busca case-insensitive por si la
respuesta real varía.

Frescura: si `INCOMING_DIR/sec.json` no existe o su `fetched_utc` tiene más
de STALE_MIN, se conserva el cortes.json previo marcándolo `"stale": true`
(mismo patrón que el "parcial" de emergencia.py, aplicado a "todo el
archivo es viejo" en vez de "una categoría falló").

Guarda de plausibilidad (incidente 2026-07-17: dos colapsos de un solo
ciclo, ~300 comunas → 2, autorrecuperados al ciclo siguiente — "ciclo
corrupto" de la SEC, no un fallo del satélite ni de este parser: verificado
reproduciendo `_agregar()` contra el crudo real y con una consulta en vivo
desde omen en el mismo instante, ambas con el volumen completo). Si el
nuevo agregado cae muy por debajo del publicado, probablemente NO es un
apagón real sino la SEC devolviendo basura para un solo request: se retiene
el último ciclo bueno (ver `_es_degradado`/`_retenido_vencido`) en vez de
publicar el bajón. `updated` del retenido NUNCA se toca — la antigüedad
visible en la UI es la protección real (regla dura #8), no se disfraza de
fresco. Si la degradación persiste más de RETENCION_MAX_MIN, se deja de
retener (nunca se congela un dato viejo indefinidamente) y se publica lo
que llegue, marcado `"parcial"` con una nota. El registro histórico
(`raw_payloads`) siempre guarda el ciclo tal cual llegó, degradado o no —
la guarda solo afecta lo publicado en `cortes.json`.

El aviso a Slack cuando la retención se agota (agregado 2026-07-24) se
retiró 2026-08-01 a pedido del operador: mientras el sitio publique lo más
correcto posible basta, no hace falta notificación. Tanto el inicio de la
retención como su vencimiento quedan solo en el log de ingesta (`print`,
ver los dos `print("[aviso] ...")` en `update()`). La guarda de
plausibilidad en sí — qué se publica en cortes.json — no cambió.
"""
import json
import unicodedata
from datetime import datetime, timedelta, timezone

import config

STALE_MIN = 30
# Firma del incidente: colapsos de ~300 comunas a 2-3, jamás una caída
# proporcional real. Un período genuinamente tranquilo (publicado con pocas
# comunas) nunca dispara la guarda: exige que el publicado tuviera volumen
# real (>=UMBRAL_COMUNAS_PLAUSIBLE) antes de comparar la caída.
UMBRAL_COMUNAS_PLAUSIBLE = 20
RATIO_DEGRADADO = 0.10
RETENCION_MAX_MIN = 90


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower().strip()


def _campo(row: dict, *nombres):
    lower = {k.lower(): v for k, v in row.items()}
    for n in nombres:
        v = lower.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def _cargar_comunas() -> dict:
    """nombre normalizado -> {lat, lon, region}."""
    data = json.loads(config.COMUNAS_PATH.read_text())
    return {_norm(c["n"]): {"lat": c["lat"], "lon": c["lon"], "region": c["r"]} for c in data["comunas"]}


def _incoming_fresco() -> dict | None:
    path = config.INCOMING_DIR / "sec.json"
    if not path.exists():
        return None
    try:
        crudo = json.loads(path.read_text())
        fetched = datetime.strptime(crudo["fetched_utc"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except (OSError, json.JSONDecodeError, KeyError, ValueError):
        return None
    if datetime.now(timezone.utc) - fetched > timedelta(minutes=STALE_MIN):
        return None
    return crudo


def _agregar(filas: list, comunas: dict) -> tuple[list, list]:
    """Agrupa por comuna: suma clientes afectados, junta empresas. Devuelve
    (cortes, sin_georef); comunas sin match en comunas.json van igual, con
    lat/lon null."""
    por_comuna: dict = {}
    for fila in filas:
        if not isinstance(fila, dict):
            continue
        comuna = _campo(fila, "COMUNA", "NOMBRE_COMUNA", "COMUNA_NOMBRE")
        if not comuna:
            continue
        # El payload real de GetPorFecha no trae campo de empresa (verificado
        # 2026-07-16): _campo() siempre da None aquí y "empresas" queda [].
        # Se deja el fallback por si la fuente cambia de formato.
        empresa = _campo(fila, "EMPRESA", "NOMBRE_EMPRESA", "EMPRESA_NOMBRE")
        clientes_raw = _campo(fila, "CLIENTES_AFECTADOS", "CLIENTES", "N_CLIENTES_AFECTADOS")
        try:
            clientes = int(float(clientes_raw)) if clientes_raw is not None else 0
        except (TypeError, ValueError):
            clientes = 0
        d = por_comuna.setdefault(comuna, {"clientes": 0, "empresas": set()})
        d["clientes"] += clientes
        if empresa:
            d["empresas"].add(str(empresa))

    cortes, sin_georef = [], []
    for comuna, d in por_comuna.items():
        geo = comunas.get(_norm(comuna))
        cortes.append({
            "comuna": comuna,
            "region": geo["region"] if geo else None,
            "lat": geo["lat"] if geo else None,
            "lon": geo["lon"] if geo else None,
            "clientes": d["clientes"],
            "empresas": sorted(d["empresas"]),
        })
        if not geo:
            sin_georef.append(comuna)
    cortes.sort(key=lambda c: -c["clientes"])
    return cortes, sin_georef


def _cargar_previo() -> dict | None:
    if not config.CORTES_PATH.exists():
        return None
    try:
        return json.loads(config.CORTES_PATH.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def _es_degradado(n_nuevas: int, previo: dict | None) -> bool:
    """True si el nuevo agregado tiene pinta de ciclo corrupto: el publicado
    ya tenía volumen real y el nuevo trae menos del RATIO_DEGRADADO de eso.
    Sin publicado previo, o publicado ya con pocas comunas (período
    genuinamente tranquilo), nunca es "degradado" — no hay contra qué
    comparar una caída real."""
    if not previo:
        return False
    n_previo = previo.get("n_comunas") or 0
    if n_previo < UMBRAL_COMUNAS_PLAUSIBLE:
        return False
    return n_nuevas < n_previo * RATIO_DEGRADADO


def _retenido_vencido(previo: dict) -> bool:
    """True si el último ciclo bueno retenido ya lleva más de
    RETENCION_MAX_MIN minutos — ahí se deja de retener (nunca se congela un
    dato viejo indefinidamente; el mecanismo stale existente cubre el resto
    si además pasa STALE_MIN sin incoming fresco)."""
    try:
        actualizado = datetime.strptime(previo["updated"], "%Y-%m-%d %H:%M UTC").replace(tzinfo=timezone.utc)
    except (KeyError, ValueError):
        return True  # sin fecha parseable: no se puede confiar en la antigüedad retenida
    return datetime.now(timezone.utc) - actualizado > timedelta(minutes=RETENCION_MAX_MIN)


def update(con, fetched_at: str) -> int:
    crudo = _incoming_fresco()
    if crudo is None:
        # Sin incoming fresco (satélite caído o nunca instalado): conserva el
        # cortes.json previo marcado stale, no lo borra ni lo deja a 0.
        if not config.CORTES_PATH.exists():
            return 0
        try:
            previo = json.loads(config.CORTES_PATH.read_text())
        except (OSError, json.JSONDecodeError):
            return 0
        previo["stale"] = True
        config.CORTES_PATH.write_text(json.dumps(previo, ensure_ascii=False) + "\n")
        return 0

    filas = crudo.get("data")
    if not isinstance(filas, list):
        raise RuntimeError("cortes SEC: incoming/sec.json sin campo 'data' de tipo lista")
    comunas = _cargar_comunas()
    cortes, sin_georef = _agregar(filas, comunas)

    # El histórico siempre guarda el ciclo tal cual llegó, degradado o no —
    # la guarda de plausibilidad (más abajo) solo decide qué se PUBLICA.
    con.execute(
        "INSERT INTO raw_payloads(fetched_at, source, url, payload) VALUES (?,?,?,?)",
        (fetched_at, "cortes", "apps.sec.cl/INTONLINEv1/ClientesAfectados/GetPorFecha",
         json.dumps({"n_comunas": len(cortes), "sin_georef": len(sin_georef)})))
    con.commit()

    previo = _cargar_previo()
    degradado = _es_degradado(len(cortes), previo)

    if degradado and not _retenido_vencido(previo):
        # Ciclo con pinta de corrupto y el retenido todavía no vence: NO se
        # publica el agregado nuevo, se conserva el previo (el último bueno)
        # marcado parcial+nota. "updated" no se toca a propósito.
        n_previo = previo.get("n_comunas") or 0
        print(f"[aviso] ciclo SEC degradado: {len(cortes)} comunas vs {n_previo} del ciclo anterior — se retiene el último ciclo completo")
        previo["parcial"] = True
        previo["nota"] = (
            f"Ciclo SEC degradado ({len(cortes)} comunas vs {n_previo} del "
            "ciclo anterior); mostrando el último ciclo completo."
        )
        config.CORTES_PATH.write_text(json.dumps(previo, ensure_ascii=False) + "\n")
        return len(cortes)

    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SEC (interrupciones en línea) · best effort",
        "stale": False,
        "n_comunas": len(cortes),
        "total_clientes": sum(c["clientes"] for c in cortes),
        "cortes": cortes,
    }
    if sin_georef:
        payload["sin_georef"] = sin_georef
    if degradado:
        # Degradación sostenida: el retenido ya venció (>RETENCION_MAX_MIN
        # min). Se deja de retener y se publica lo que llegue, avisando —
        # nunca se congela un dato viejo indefinidamente.
        hora_ultimo_bueno = (previo.get("updated") or "").split(" ")[-2] if previo else "?"
        print(f"[aviso] ciclo SEC degradado sostenido (retención agotada tras {RETENCION_MAX_MIN} min): publicando datos posiblemente incompletos")
        # Un solo log: esta rama solo se alcanza en el ciclo exacto donde
        # vence la retención — el próximo ciclo compara contra este mismo
        # n_comunas (bajo), que ya no supera UMBRAL_COMUNAS_PLAUSIBLE, así
        # que _es_degradado da False de inmediato y no se repite solo.
        payload["parcial"] = True
        payload["nota"] = f"Fuente SEC entregando datos posiblemente incompletos desde {hora_ultimo_bueno} UTC."
    config.CORTES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.CORTES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(cortes)
