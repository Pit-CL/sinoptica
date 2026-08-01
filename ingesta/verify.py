"""Verificación continua: ¿cuánto se equivoca cada modelo?

Compara cada pronóstico determinista archivado con la observación real de la
misma estación y hora (METAR + DMC), por variable y por plazo. Métricas:
  MAE  = error absoluto medio (magnitud típica del error)
  RMSE = raíz del error cuadrático medio (penaliza errores grandes/outliers)
  bias = error medio con signo (tendencia a pronosticar de más o de menos)

Estructura del JSON: models[modelo][variable][bucket] = {mae, rmse, bias, n}.
Incluye además un pseudo-modelo "persistencia" (ver _persistencia): la
referencia mínima que cualquier modelo serio debe superar.
"""
import bisect
import json
import math
from datetime import datetime, timezone

import config
import verify_avisos

WINDOW_DAYS = 14
BUCKETS = [(0, 24, "24"), (24, 48, "48"), (48, 72, "72"), (72, 96, "96")]
# Variables continuas con observación comparable directa (mismas que se calibran)
VARIABLES = config.CALIBRABLE_VARS


def _stats(s):
    n = s[3]
    return {"mae": round(s[0] / n, 2), "rmse": round(math.sqrt(s[2] / n), 2),
            "bias": round(s[1] / n, 2), "n": n}


def _persistencia(con, combos) -> dict:
    """Baseline de persistencia: pronóstico := la observación de hace `lead`
    horas. Se evalúa sobre el conjunto DISTINTO de (station, variable,
    valid_time, lead) que participa en la verificación de los modelos (mismos
    pares, para que la comparación de skill sea justa) — no una vez por
    modelo, sino una vez por combinación real evaluada; `combos` ya viene
    deduplicado desde compute() (evita repetir el JOIN forecasts↔observations,
    que es la parte cara de la consulta, una segunda vez). Para cada combo, la
    predicción de persistencia es la observación más cercana a
    valid_time − lead, con tolerancia ±1 h; sin observación en ese entorno,
    el par se descarta (nunca se inventa un dato).
    """
    if not combos:
        return {}

    placeholders = ",".join("?" * len(VARIABLES))
    # Observaciones candidatas para el lookup "hace `lead` horas": mismo
    # rango que los pronósticos archivados pero corrido hacia atrás lo que
    # alcanza el lead máximo de los buckets (96 h) + la tolerancia de 1 h.
    max_lead = max(hi for _, hi, _ in BUCKETS)
    obs_sql = f"""
    SELECT station, variable, obs_time, value FROM observations
    WHERE variable IN ({placeholders})
      AND obs_time >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?, ?)
    """
    # OJO: dos modificadores SEPARADOS, no un solo string combinado — SQLite
    # solo reconoce "-N days"/"-N hours" como modificador individual; un
    # string tipo "-14 days -97 hours" no es válido y strftime devuelve NULL
    # en silencio, lo que descarta TODAS las filas de la comparación (bug
    # real detectado en pruebas: n=0 en persistencia pese a haber datos).
    obs_by_key: dict = {}
    for station, variable, obs_time, value in con.execute(
            obs_sql, (*VARIABLES, f"-{WINDOW_DAYS} days", f"-{max_lead + 1} hours")):
        if value is None:
            continue
        ts = datetime.strptime(obs_time, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
        obs_by_key.setdefault((station, variable), []).append((ts, value))
    for lst in obs_by_key.values():
        lst.sort()

    TOLERANCE_S = 3600
    # acc[variable][bucket] = [sum|e|, sum e, sum e², n]
    acc: dict = {}
    for station, variable, valid_time, lead, ob in combos:
        candidates = obs_by_key.get((station, variable))
        if not candidates:
            continue
        target = (datetime.strptime(valid_time + ":00Z", "%Y-%m-%dT%H:%M:%SZ")
                  .replace(tzinfo=timezone.utc).timestamp()) - lead * 3600
        idx = bisect.bisect_left(candidates, (target, float("-inf")))
        best = None
        for cand_idx in (idx - 1, idx):
            if 0 <= cand_idx < len(candidates):
                ts, value = candidates[cand_idx]
                diff = abs(ts - target)
                if diff <= TOLERANCE_S and (best is None or diff < best[0]):
                    best = (diff, value)
        if best is None:
            continue  # sin obs en el entorno de ±1h: se descarta, no se inventa
        fc = best[1]
        for lo, hi, key in BUCKETS:
            if lo < lead <= hi:
                a = acc.setdefault(variable, {}).setdefault(key, [0.0, 0.0, 0.0, 0])
                e = fc - ob
                a[0] += abs(e)
                a[1] += e
                a[2] += e * e
                a[3] += 1
                break

    return {
        variable: {key: _stats(s) for key, s in buckets.items() if s[3] > 0}
        for variable, buckets in acc.items()
    }


def compute(con) -> dict:
    placeholders = ",".join("?" * len(VARIABLES))
    # El filtro por `o.obs_time` es redundante en teoría (lo implica la
    # igualdad del JOIN con f.valid_time, ya acotado) pero es la diferencia
    # entre segundos y minutos en la práctica: sin él, el planner de SQLite
    # conduce el JOIN desde `observations` completa (retención 180 días) y
    # busca en `forecasts` (retención 60 días, decenas de millones de filas)
    # solo con una cota inferior — para el grueso de observaciones viejas que
    # jamás calzan, igual recorre todo el rango reciente de esa estación-
    # variable antes de descartarlas (medido: >12 min en la copia de prod,
    # ~104M filas en forecasts). Acotar ambos lados dispara el índice de
    # observations y lo vuelve un lookup en vez de un escaneo.
    sql = f"""
    SELECT f.station, f.model, f.variable,
           CAST((julianday(f.valid_time) - julianday(f.run_tag || ':00')) * 24 AS INTEGER),
           f.valid_time, f.value, o.value
    FROM forecasts f
    JOIN observations o
      ON o.station = f.station
     AND o.variable = f.variable
     AND o.obs_time = f.valid_time || ':00Z'
    WHERE f.member = -1 AND f.variable IN ({placeholders})
      AND f.valid_time >= strftime('%Y-%m-%dT%H:%M', 'now', ?)
      AND o.obs_time >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
    """
    # acc[model][variable][bucket] = [sum|e|, sum e, sum e², n]
    acc: dict = {}
    # Pares (station, variable, valid_time, lead, obs) DISTINTOS de esta misma
    # consulta, para el baseline de persistencia (_persistencia) — se arma acá
    # y no con una segunda consulta porque el JOIN forecasts↔observations es
    # la parte cara y ya se pagó una vez.
    combos: list = []
    combos_seen: set = set()
    for station, model, variable, lead, valid_time, fc, ob in con.execute(
            sql, (*VARIABLES, f"-{WINDOW_DAYS} days", f"-{WINDOW_DAYS} days")):
        if fc is None or ob is None or lead is None or lead <= 0:
            continue
        for lo, hi, key in BUCKETS:
            if lo < lead <= hi:
                a = acc.setdefault(model, {}).setdefault(variable, {}).setdefault(key, [0.0, 0.0, 0.0, 0])
                e = fc - ob
                a[0] += abs(e)
                a[1] += e
                a[2] += e * e
                a[3] += 1
                break
        combo_key = (station, variable, valid_time, lead)
        if combo_key not in combos_seen:
            combos_seen.add(combo_key)
            combos.append((station, variable, valid_time, lead, ob))

    models = {
        model: {
            variable: {key: _stats(s) for key, s in buckets.items() if s[3] > 0}
            for variable, buckets in varmap.items()
        }
        for model, varmap in acc.items()
    }
    models["persistencia"] = _persistencia(con, combos)
    return {
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
        "window_days": WINDOW_DAYS,
        "variables": VARIABLES,
        "stations_n": len(config.STATIONS),
        "models": models,
    }


def write(con, run_ts: str | None = None) -> int:
    data = compute(con)
    data["avisos"] = verify_avisos.compute_and_persist(con, run_ts)
    config.VERIF_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.VERIF_PATH.write_text(json.dumps(data, ensure_ascii=False) + "\n")
    n_modelos = len(data["models"]) - (1 if "persistencia" in data["models"] else 0)
    pares = sum(b["n"] for m in data["models"].values()
                for v in m.values() for b in v.values())
    print(f"verificación → {config.VERIF_PATH}: {n_modelos} modelos, "
          f"{len(VARIABLES)} variables, {pares} pares (incl. persistencia); avisos: "
          f"{data['avisos']['n_avisos_evaluados']} evaluados")
    return pares
