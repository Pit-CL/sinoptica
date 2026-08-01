"""Condensado permanente del ensamble ECMWF (ver ingesta/db.py: tabla
ensamble_stats).

`forecasts` purga el ensamble a los 60 días (RETENTION_DAYS/prune) y
Open-Meteo no sirve miembros históricos: lo purgado es irrecuperable. Este
paso agrega media/sd/percentiles por (station, run_tag, valid_time,
variable) ANTES de que la retención borre las filas crudas, para EMOS
estacional futuro.

Incremental: solo procesa los run_tag del ensamble que aún no tengan fila en
ensamble_stats — la primera corrida tras el deploy backfillea sola todo el
crudo vivo (una sola vez, minutos); las siguientes solo el run_tag nuevo
(segundos). Cada run_tag se agrega y commitea por separado: si el proceso
se interrumpe a mitad de camino, el run_tag en curso queda sin commitear (no
aparece en ensamble_stats) y la corrida siguiente lo reprocesa completo.
"""
import math

import config

UMBRAL_LLUVIA = 0.1  # mm; frac01 solo tiene sentido para variable='precipitation'


def _percentiles(valores: list) -> tuple:
    """p10/p50/p90 por interpolación lineal (sin scipy, ver regla 1 de
    CLAUDE.md) — mismo método que crecidas._percentil."""
    s = sorted(valores)
    n = len(s)
    if n == 0:
        return (None, None, None)

    def p(pct):
        if n == 1:
            return s[0]
        idx = pct / 100 * (n - 1)
        lo = int(idx)
        hi = min(lo + 1, n - 1)
        return s[lo] + (s[hi] - s[lo]) * (idx - lo)

    return p(10), p(50), p(90)


def _condensar_run_tag(con, run_tag: str) -> int:
    # Media y varianza en SQL (AVG es rápido en C sobre potencialmente
    # cientos de miles de filas); var = E[x²] − E[x]², clip a 0 por
    # redondeo de punto flotante antes del sqrt.
    agregados = {}
    for station, valid_time, variable, n, media, media_sq, frac01 in con.execute(
        "SELECT station, valid_time, variable, COUNT(*), AVG(value), AVG(value*value),"
        " AVG(CASE WHEN variable = 'precipitation' AND value > ? THEN 1.0 ELSE 0.0 END)"
        " FROM forecasts"
        " WHERE model = ? AND run_tag = ? AND member >= 0 AND value IS NOT NULL"
        " GROUP BY station, valid_time, variable",
        (UMBRAL_LLUVIA, config.ENSEMBLE_MODEL, run_tag),
    ):
        agregados[(station, valid_time, variable)] = (n, media, media_sq, frac01)

    # Percentiles: sqlite3 no tiene función de percentil, se calculan en
    # Python sobre los valores crudos del grupo (51 miembros, trivial).
    valores: dict = {}
    for station, valid_time, variable, value in con.execute(
        "SELECT station, valid_time, variable, value FROM forecasts"
        " WHERE model = ? AND run_tag = ? AND member >= 0 AND value IS NOT NULL",
        (config.ENSEMBLE_MODEL, run_tag),
    ):
        valores.setdefault((station, valid_time, variable), []).append(value)

    rows = []
    for (station, valid_time, variable), (n, media, media_sq, frac01) in agregados.items():
        varianza = max(0.0, media_sq - media * media)
        sd = math.sqrt(varianza)
        p10, p50, p90 = _percentiles(valores[(station, valid_time, variable)])
        rows.append((
            station, run_tag, valid_time, variable, n, media, sd, p10, p50, p90,
            frac01 if variable == "precipitation" else None,
        ))
    con.executemany(
        "INSERT OR IGNORE INTO ensamble_stats"
        "(station, run_tag, valid_time, variable, n, media, sd, p10, p50, p90, frac01)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)", rows)
    con.commit()
    return len(rows)


def update(con) -> int:
    """Condensa todos los run_tag del ensamble aún no presentes en
    ensamble_stats. Ver docstring del módulo para la semántica incremental."""
    faltantes = [r[0] for r in con.execute(
        "SELECT DISTINCT run_tag FROM forecasts"
        " WHERE model = ? AND member >= 0"
        " AND run_tag NOT IN (SELECT DISTINCT run_tag FROM ensamble_stats)"
        " ORDER BY run_tag",
        (config.ENSEMBLE_MODEL,),
    )]
    total = 0
    for run_tag in faltantes:
        total += _condensar_run_tag(con, run_tag)
    return total
