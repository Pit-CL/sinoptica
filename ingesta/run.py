"""Orquestador de ingesta.

Uso:
  python3 ingesta/run.py            # observaciones + status (cada hora)
  python3 ingesta/run.py --forecasts  # además archiva pronósticos (cada 6 h)
  python3 ingesta/run.py --all
"""
import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

import alertas
import avisos
import combustible
import config
import cortes
import crecidas
import db
import emergencia
import ensamble_stats
import esval
import farmacias
import incendios
import marea
import remociones
import sismos
import sources
import tsunami
import volcanes
import verify
import calibrate


def write_status(con) -> None:
    q = lambda sql: con.execute(sql).fetchone()[0]
    forecast_rows = q("SELECT COALESCE(MAX(rowid), 0) FROM forecasts")
    obs_rows = q("SELECT COALESCE(MAX(rowid), 0) FROM observations")
    since_f = q("SELECT MIN(run_tag) FROM forecasts")
    since_o = q("SELECT MIN(obs_time) FROM observations")
    since = min(s for s in [since_f, since_o, "9999"] if s) if (since_f or since_o) else None
    status = {
        "forecast_rows": forecast_rows,
        "obs_rows": obs_rows,
        "since": (since or "")[:10] or None,
        "last_run": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "stations": len(config.STATIONS),
    }
    config.STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.STATUS_PATH.write_text(json.dumps(status, ensure_ascii=False) + "\n")
    print(f"status → {config.STATUS_PATH}: {status}")


def write_estaciones(con) -> int:
    """Última observación por estación (mapa en vivo de la PWA)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(hours=4)).strftime("%Y-%m-%dT%H:%M:%SZ")
    latest: dict = {}
    for station, variable, value, obs_time in con.execute(
        "SELECT station, variable, value, obs_time FROM observations"
        " WHERE obs_time >= ? ORDER BY obs_time", (cutoff,)):
        d = latest.setdefault(station, {"obs": {}, "obs_time": obs_time})
        d["obs"][variable] = value
        if obs_time > d["obs_time"]:
            d["obs_time"] = obs_time
    # fenómeno presente reciente (METAR wxString), solo si es de las últimas 2 h
    wx_cut = (datetime.now(timezone.utc) - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    wx = {st: w for st, w in con.execute(
        "SELECT station, wx FROM obs_wx WHERE obs_time >= ?", (wx_cut,))}
    estaciones = [{
        "id": s["id"], "nombre": s["nombre"], "lat": s["lat"], "lon": s["lon"],
        "region": s.get("region"),
        "fuente": "metar" if s.get("metar") else "dmc",
        "obs_time": latest[s["id"]]["obs_time"] if s["id"] in latest else None,
        "obs": latest[s["id"]]["obs"] if s["id"] in latest else {},
        "wx": wx.get(s["id"]),
    } for s in config.STATIONS]
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "estaciones": estaciones,
    }
    config.ESTACIONES_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.ESTACIONES_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    con_datos = sum(1 for e in estaciones if e["obs"])
    print(f"estaciones → {config.ESTACIONES_PATH}: {con_datos}/{len(estaciones)} con datos")
    return con_datos


def write_aire(con, run_at: str) -> int:
    """Archiva SINCA y publica aire.json (estaciones oficiales de V/RM)."""
    _, estaciones = sources.ingest_sinca(con, run_at)
    payload = {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "SINCA · Ministerio del Medio Ambiente de Chile",
        "estaciones": estaciones,
    }
    config.AIRE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.AIRE_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    con_pm = sum(1 for e in estaciones if e.get("pm2_5") is not None)
    print(f"aire → {config.AIRE_PATH}: {len(estaciones)} estaciones SINCA ({con_pm} con MP2,5)")
    return len(estaciones)


def step(con, run_at: str, kind: str, fn) -> bool:
    try:
        n = fn()
        db.log(con, run_at, kind, True, n)
        print(f"[ok] {kind}: {n} filas")
        return True
    except Exception as err:
        db.log(con, run_at, kind, False, 0, str(err))
        print(f"[ERROR] {kind}: {err}", file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--forecasts", action="store_true", help="archiva pronósticos (det + ensamble)")
    ap.add_argument("--obs", action="store_true", help="archiva observaciones (METAR, DMC)")
    ap.add_argument("--avisos", action="store_true",
                     help="avisos meteorológicos derivados del pronóstico propio (barato, sin red)")
    ap.add_argument("--sismos", action="store_true", help="archiva catálogo sísmico (CSN + USGS)")
    ap.add_argument("--incendios", action="store_true", help="archiva focos de calor (NASA FIRMS)")
    ap.add_argument("--alertas", action="store_true", help="alertas naturales vigentes (SENAPRED)")
    ap.add_argument("--volcanes", action="store_true", help="alerta técnica volcánica (SERNAGEOMIN RNVV)")
    ap.add_argument("--marea", action="store_true", help="marea, oleaje y temperatura del mar (Open-Meteo Marine)")
    ap.add_argument("--tsunami", action="store_true", help="estado de amenaza de tsunami (PTWC + catálogo sísmico)")
    ap.add_argument("--crecidas", action="store_true",
                     help="pronóstico de crecidas de ríos (GloFAS/Copernicus vía Open-Meteo Flood API)")
    ap.add_argument("--cortes", action="store_true",
                     help="cortes de luz SEC (best effort, vía satélite en omen — solo lee incoming/, sin red)")
    ap.add_argument("--farmacias", action="store_true",
                     help="farmacias de turno MINSAL (vía satélite en omen — solo lee incoming/, sin red)")
    ap.add_argument("--esval", action="store_true",
                     help="cortes de agua Esval, V Región (best effort, vía satélite en omen — solo lee incoming/, sin red)")
    ap.add_argument("--combustible", action="store_true",
                     help="precios de bencina en línea (CNE, dormida sin CNE_EMAIL/CNE_PASSWORD — accesible directo desde el VPS)")
    ap.add_argument("--hazards", action="store_true",
                     help="peligros naturales (sismos + incendios + alertas + volcanes + tsunami + crecidas + cortes + farmacias + esval + combustible)")
    ap.add_argument("--emergencia", action="store_true",
                     help="infraestructura de emergencia comunitaria (SENAPRED, cuasi-estático semanal)")
    ap.add_argument("--remociones", action="store_true",
                     help="catastro de remociones en masa (SENAPRED, cuasi-estático semanal)")
    ap.add_argument("--all", action="store_true")
    args = ap.parse_args()
    do_forecasts = args.forecasts or args.all
    do_obs = args.obs or args.all or not (
        args.forecasts or args.all or args.sismos or args.incendios
        or args.alertas or args.volcanes or args.hazards or args.emergencia
        or args.remociones or args.avisos or args.marea or args.tsunami
        or args.cortes or args.farmacias or args.esval or args.combustible or args.crecidas)
    do_sismos = args.sismos or args.hazards or args.all
    do_incendios = args.incendios or args.hazards or args.all
    do_alertas = args.alertas or args.hazards or args.all
    do_volcanes = args.volcanes or args.hazards or args.all
    do_marea = args.marea or args.all
    do_tsunami = args.tsunami or args.hazards or args.all
    do_crecidas = args.crecidas or args.hazards or args.all
    do_cortes = args.cortes or args.hazards or args.all
    do_farmacias = args.farmacias or args.hazards or args.all
    do_esval = args.esval or args.hazards or args.all
    do_combustible = args.combustible or args.hazards or args.all
    do_emergencia = args.emergencia or args.all
    do_remociones = args.remociones or args.emergencia or args.all
    # Avisos son baratos (SQL local + mediana, sin red): se recalculan en toda
    # corrida de observaciones o de pronósticos, no solo con --avisos explícito.
    do_avisos = args.avisos or do_obs or do_forecasts

    now = datetime.now(timezone.utc)
    run_at = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    run_tag = now.strftime("%Y-%m-%dT%H")

    con = db.connect()
    ok = True
    if do_obs:
        ok &= step(con, run_at, "metar", lambda: sources.ingest_metar(con, run_at))
        ok &= step(con, run_at, "dmc", lambda: sources.ingest_dmc(con, run_at))
        ok &= step(con, run_at, "sinca", lambda: write_aire(con, run_at))
    if do_forecasts:
        ok &= step(con, run_at, "openmeteo_det", lambda: sources.ingest_openmeteo_det(con, run_tag))
        ok &= step(con, run_at, "openmeteo_ens", lambda: sources.ingest_openmeteo_ens(con, run_tag))
        ok &= step(con, run_at, "ensamble_stats", lambda: ensamble_stats.update(con))
        ok &= step(con, run_at, "prune", lambda: db.prune(con))
    if do_sismos:
        ok &= step(con, run_at, "sismos", lambda: sismos.update(con, run_at))
    if do_incendios:
        ok &= step(con, run_at, "incendios", lambda: incendios.update(con, run_at))
    if do_alertas:
        ok &= step(con, run_at, "alertas", lambda: alertas.update(con, run_at))
    if do_volcanes:
        ok &= step(con, run_at, "volcanes", lambda: volcanes.update(con, run_at))
    if do_marea:
        ok &= step(con, run_at, "marea", lambda: marea.update(con, run_at))
    if do_tsunami:
        # Depende de la tabla `quakes` (sismos.py): si corre solo, sin
        # --sismos en esta misma invocación, usa la tabla de una corrida previa.
        ok &= step(con, run_at, "tsunami", lambda: tsunami.update(con, run_at))
    if do_crecidas:
        ok &= step(con, run_at, "crecidas", lambda: crecidas.update(con, run_at))
    if do_cortes:
        ok &= step(con, run_at, "cortes", lambda: cortes.update(con, run_at))
    if do_farmacias:
        ok &= step(con, run_at, "farmacias", lambda: farmacias.update(con, run_at))
    if do_esval:
        ok &= step(con, run_at, "esval", lambda: esval.update(con, run_at))
    if do_combustible:
        ok &= step(con, run_at, "combustible", lambda: combustible.update(con, run_at))
    if do_emergencia:
        ok &= step(con, run_at, "emergencia", lambda: emergencia.update(con, run_at))
    if do_remociones:
        ok &= step(con, run_at, "remociones", lambda: remociones.update(con, run_at))
    # Verificación y calibración solo con los pronósticos (2 veces al día):
    # con la red de 152 estaciones recalcularlas cada hora tarda más que el
    # propio ciclo horario y las corridas se apilan. estaciones.json sí se
    # refresca en cada corrida de observaciones (es barato: última obs).
    if do_forecasts:
        ok &= step(con, run_at, "verificacion", lambda: verify.write(con, run_at))
        ok &= step(con, run_at, "calibracion", lambda: calibrate.update(con))
        ok &= step(con, run_at, "bias_json", lambda: calibrate.export_json(con))
    if do_obs or do_forecasts:
        ok &= step(con, run_at, "estaciones", lambda: write_estaciones(con))
    if do_avisos:
        ok &= step(con, run_at, "avisos", lambda: avisos.update(con, run_at))
    write_status(con)
    con.close()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
