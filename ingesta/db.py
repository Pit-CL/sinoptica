"""Esquema y acceso SQLite del archivo científico."""
import sqlite3

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS stations (
  id      TEXT PRIMARY KEY,   -- ICAO (METAR) o código nacional DMC
  nombre  TEXT NOT NULL,
  lat     REAL NOT NULL,
  lon     REAL NOT NULL,
  alt     REAL                -- altitud (m); habilita corrección orográfica
);

-- Pronósticos archivados en formato largo.
-- run_tag = hora UTC de la ingesta (YYYY-MM-DDTHH): re-ejecutar dentro de la
-- misma hora es idempotente. member = -1 para deterministas, 0..N ensamble.
CREATE TABLE IF NOT EXISTS forecasts (
  station    TEXT NOT NULL,
  model      TEXT NOT NULL,
  run_tag    TEXT NOT NULL,
  valid_time TEXT NOT NULL,
  variable   TEXT NOT NULL,
  member     INTEGER NOT NULL DEFAULT -1,
  value      REAL,
  UNIQUE(station, model, run_tag, valid_time, variable, member) ON CONFLICT IGNORE
);

-- Observaciones (ground truth). Variables con nombres Open-Meteo
-- para que la comparación pronóstico/observación sea directa.
CREATE TABLE IF NOT EXISTS observations (
  station  TEXT NOT NULL,
  obs_time TEXT NOT NULL,          -- ISO UTC
  variable TEXT NOT NULL,
  value    REAL,
  source   TEXT NOT NULL,          -- 'metar' | 'dmc'
  UNIQUE(station, obs_time, variable, source) ON CONFLICT IGNORE
);

-- Fenómeno presente observado (wxString del METAR: RA, DZ, TSRA, FG…), el más
-- reciente por estación. Habilita mostrar el tiempo REAL en vez del weather_code
-- del modelo (que puede decir "llovizna" mientras la estación reporta lluvia).
CREATE TABLE IF NOT EXISTS obs_wx (
  station  TEXT PRIMARY KEY,
  obs_time TEXT NOT NULL,
  wx       TEXT NOT NULL,
  updated  TEXT NOT NULL
);

-- Payloads crudos: nunca perder datos aunque aún no exista parser (DMC).
CREATE TABLE IF NOT EXISTS raw_payloads (
  fetched_at TEXT NOT NULL,
  source     TEXT NOT NULL,
  url        TEXT NOT NULL,
  payload    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingest_log (
  run_at TEXT NOT NULL,
  kind   TEXT NOT NULL,
  ok     INTEGER NOT NULL,
  rows   INTEGER NOT NULL DEFAULT 0,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_forecasts_lookup
  ON forecasts(station, variable, valid_time);
CREATE INDEX IF NOT EXISTS idx_observations_lookup
  ON observations(station, variable, obs_time);
-- Filtro principal de ingesta/verify.py (member=-1, variable IN(...),
-- valid_time>=ventana): sin este índice el planner conduce el JOIN desde
-- `forecasts` con un SCAN completo (medido: >100M filas, minutos de CPU
-- en producción con la retención de 60 días llena) en vez de acotar por
-- rango — idx_forecasts_lookup no sirve para este filtro porque su columna
-- líder (station) no está en el WHERE.
CREATE INDEX IF NOT EXISTS idx_forecasts_verif
  ON forecasts(member, variable, valid_time);
-- Búsqueda de ensamble_stats.py: agrega por (model, run_tag, member>=0). Sin
-- este índice el planner recurre a idx_forecasts_lookup con un SCAN completo
-- de la tabla (medido: >30 min y sin terminar para un solo run_tag sobre
-- ~18M filas de ensamble) porque ninguno de los índices existentes tiene
-- run_tag — con este índice pasa a SEARCH (seek) y cada run_tag se resuelve
-- en segundos.
CREATE INDEX IF NOT EXISTS idx_forecasts_ens_run
  ON forecasts(model, run_tag, member);

-- Condensado PERMANENTE del ensamble ECMWF (config.ENSEMBLE_MODEL, 51
-- miembros), ver ingesta/ensamble_stats.py. `forecasts` purga el ensamble a
-- los 60 días (RETENTION_DAYS) y Open-Meteo no sirve miembros históricos: lo
-- purgado es irrecuperable. Esta tabla NO entra en ninguna retención (no
-- está en RETENTION_DAYS/prune): media/sd/percentiles se conservan para
-- siempre, pensados para EMOS estacional futuro. n = miembros con valor no
-- nulo agregados; frac01 = fracción de miembros > 0.1 mm, solo tiene sentido
-- para variable='precipitation' (NULL en las demás). Si algún día se archiva
-- otro ensamble, agregar columna `model` en vez de asumir ECMWF.
CREATE TABLE IF NOT EXISTS ensamble_stats (
  station    TEXT NOT NULL,
  run_tag    TEXT NOT NULL,
  valid_time TEXT NOT NULL,
  variable   TEXT NOT NULL,
  n          INTEGER NOT NULL,
  media      REAL,
  sd         REAL,
  p10        REAL,
  p50        REAL,
  p90        REAL,
  frac01     REAL,
  UNIQUE(station, run_tag, valid_time, variable)
);
CREATE INDEX IF NOT EXISTS idx_ensamble_stats_lookup
  ON ensamble_stats(station, variable, valid_time);

-- Umbrales de crecida por punto de río (ver ingesta/crecidas.py), calculados
-- una sola vez desde el reanálisis histórico GloFAS (bootstrap). Tabla propia:
-- estos puntos NO son estaciones (regla 6 de CLAUDE.md), no hay ground truth.
CREATE TABLE IF NOT EXISTS crecidas_umbral (
  punto   TEXT PRIMARY KEY,
  rp2     REAL NOT NULL,   -- período de retorno ~2 años (mediana de máximas anuales)
  rp5     REAL NOT NULL,   -- ~5 años (percentil 80)
  rp20    REAL NOT NULL,   -- ~20 años (percentil 95)
  n_anios INTEGER NOT NULL,
  updated TEXT NOT NULL
);

-- Histórico de avisos emitidos en cada corrida (auditoría científica, ver
-- avisos.py): avisos.json se recalcula entero y se sobrescribe en cada
-- corrida, así que sin esta tabla es imposible medir retrospectivamente
-- falsos positivos/negativos. `valor` es el valor YA corregido por
-- calibrate.py (el mismo que va al JSON público); `valor_crudo` es la
-- mediana SIN corrección de bias para la misma variable/hora — permite ver
-- si la corrección de bias fue lo que disparó o suprimió el aviso. NULL en
-- `valor_crudo` cuando el aviso es compuesto y no tiene un único valor crudo
-- bien definido (ver _valor_crudo en avisos.py). Solo AGREGA filas, nunca se
-- pisa el histórico. Para distinguir "no hubo aviso en esta corrida" de "la
-- corrida no ocurrió": cruzar con ingest_log (kind='avisos', run_at=run_ts) —
-- si existe esa fila con ok=1 y no hay avisos_emitidos con ese run_ts, no
-- hubo aviso; si no existe la fila en ingest_log, la corrida no se ejecutó.
CREATE TABLE IF NOT EXISTS avisos_emitidos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ts      TEXT NOT NULL,
  station_id  TEXT NOT NULL,
  tipo        TEXT NOT NULL,
  nivel       TEXT NOT NULL,
  valor       REAL NOT NULL,
  valor_crudo REAL,
  unidad      TEXT NOT NULL,
  umbral      REAL,
  acuerdo     TEXT,
  valid_time  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_avisos_emitidos_run
  ON avisos_emitidos(run_ts, tipo);

-- Métricas POD/FAR/CSI de avisos_emitidos contra observaciones (ver
-- verify_avisos.py). Una fila por tipo en cada corrida de verificación
-- (2 veces al día, colgada del mismo paso que verify.py); solo INSERT,
-- nunca se pisa el histórico.
CREATE TABLE IF NOT EXISTS avisos_verif (
  run_ts       TEXT NOT NULL,
  tipo         TEXT NOT NULL,
  ventana_dias INTEGER NOT NULL,
  hits         INTEGER NOT NULL,
  falsas       INTEGER NOT NULL,
  misses       INTEGER NOT NULL,
  pod          REAL,
  far          REAL,
  csi          REAL
);

CREATE INDEX IF NOT EXISTS idx_avisos_verif_run
  ON avisos_verif(run_ts, tipo);
"""


def connect() -> sqlite3.Connection:
    config.DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(config.DB_PATH, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    # migración: la primera versión del esquema llamaba 'icao' a la PK
    cols = [r[1] for r in con.execute("PRAGMA table_info(stations)")]
    if "icao" in cols:
        con.execute("ALTER TABLE stations RENAME COLUMN icao TO id")
    con.executescript(SCHEMA)
    # migración: columna alt añadida después (poblar siempre por si faltaba)
    cols = [r[1] for r in con.execute("PRAGMA table_info(stations)")]
    if "alt" not in cols:
        con.execute("ALTER TABLE stations ADD COLUMN alt REAL")
    for s in config.STATIONS:
        con.execute(
            "INSERT OR IGNORE INTO stations(id, nombre, lat, lon, alt) VALUES (?,?,?,?,?)",
            (s["id"], s["nombre"], s["lat"], s["lon"], s.get("alt")),
        )
        con.execute("UPDATE stations SET alt=? WHERE id=? AND alt IS NULL",
                    (s.get("alt"), s["id"]))
    con.commit()
    return con


# QC de rango físico (práctica estándar meteorológica): descarta observaciones
# imposibles antes de insertarlas — un sensor roto (ej. estación DMC 390043
# reportando 501.6 hPa constante) contamina la calibración EWMA con un bias
# gigante que luego arruina el pronóstico corregido. Márgenes generosos sobre
# récords mundiales: no tocan clima real, solo basura de hardware.
RANGO_FISICO = {
    "pressure_msl": (870, 1085),
    "temperature_2m": (-45, 48),
    "dew_point_2m": (-60, 40),
    "relative_humidity_2m": (0, 100),
    "wind_speed_10m": (0, 250),
    "wind_gusts_10m": (0, 250),
    "precipitation": (0, 120),
    "cloud_cover": (0, 100),
}


def qc_filtrar_observaciones(rows):
    """Separa filas (station, obs_time, variable, value, source) dentro/fuera
    de rango físico. Devuelve (rows_ok, descartadas); descartadas es una lista
    de dicts (station, variable, value) para que el caller imprima el resumen
    — nunca se descarta en silencio."""
    ok, descartadas = [], []
    for row in rows:
        station, _obs_time, variable, value, _source = row
        rango = RANGO_FISICO.get(variable)
        if rango is not None and value is not None and not (rango[0] <= value <= rango[1]):
            descartadas.append({"station": station, "variable": variable, "value": value})
            continue
        ok.append(row)
    return ok, descartadas


def qc_reportar(descartadas) -> None:
    """Imprime el resumen de QC (máx. 5 ejemplos). Nunca silencioso."""
    if not descartadas:
        return
    ejemplos = ", ".join(f"{d['station']}: {d['variable']}={d['value']}" for d in descartadas[:5])
    print(f"[aviso] QC: {len(descartadas)} observaciones descartadas por rango físico ({ejemplos})")


def log(con: sqlite3.Connection, run_at: str, kind: str, ok: bool, rows: int, detail: str = "") -> None:
    con.execute(
        "INSERT INTO ingest_log(run_at, kind, ok, rows, detail) VALUES (?,?,?,?,?)",
        (run_at, kind, int(ok), rows, detail[:500]),
    )
    con.commit()


RETENTION_DAYS = {
    "forecasts": 60,       # ≥ WINDOW_DAYS de calibración (45)
    "observations": 180,
    "obs_wx": 180,
    "raw_payloads": 14,
    "ingest_log": 90,
}

_RETENTION_COL = {
    "forecasts": "valid_time",
    "observations": "obs_time",
    "obs_wx": "obs_time",
    "raw_payloads": "fetched_at",
    "ingest_log": "run_at",
}


def prune(con: sqlite3.Connection) -> int:
    """Borra filas fuera de la ventana de retención. SQLite reutiliza las
    páginas liberadas, así que el archivo llega a un plateau sin VACUUM."""
    borradas = 0
    for tabla, dias in RETENTION_DAYS.items():
        col = _RETENTION_COL[tabla]
        cur = con.execute(
            f"DELETE FROM {tabla} WHERE {col} < datetime('now', ?)", (f"-{dias} days",)
        )
        borradas += cur.rowcount
    con.commit()
    return borradas
