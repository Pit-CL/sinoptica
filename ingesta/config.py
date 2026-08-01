"""Configuración de la ingesta de Vigía.

Todo punto de archivo de pronóstico ES una estación con observaciones:
calibrar donde no hay ground truth no aporta ciencia.
"""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = Path(os.environ.get("CLIMA_DB", ROOT / "data" / "clima.db"))
STATUS_PATH = Path(os.environ.get("CLIMA_STATUS", ROOT / "web" / "status.json"))
VERIF_PATH = Path(os.environ.get("CLIMA_VERIF", ROOT / "web" / "verificacion.json"))
ESTACIONES_PATH = Path(os.environ.get("CLIMA_ESTACIONES", ROOT / "web" / "estaciones.json"))
AIRE_PATH = Path(os.environ.get("CLIMA_AIRE", ROOT / "web" / "aire.json"))
BIAS_PATH = Path(os.environ.get("CLIMA_BIAS", ROOT / "web" / "bias.json"))
AVISOS_PATH = Path(os.environ.get("CLIMA_AVISOS", ROOT / "web" / "avisos.json"))

# ── Estaciones: red curada nacional (ver stations_cl.py) ────────
from stations_cl import STATIONS

# Variables continuas calibrables (sesgo aditivo). Excluidas a propósito:
# precipitation (resta da negativos), wind_direction_10m (circular, grados),
# cloud_cover (categórica acotada, pocos pares de obs).
CALIBRABLE_VARS = ["temperature_2m", "dew_point_2m", "pressure_msl",
                   "relative_humidity_2m", "wind_speed_10m"]

# ── Pronósticos a archivar (en las coordenadas de las estaciones) ──
MODELS = [
    "ecmwf_ifs025",
    "gfs_seamless",
    "icon_seamless",
    "gem_seamless",
    "meteofrance_seamless",
    # Modelo de IA de ECMWF (AIFS Single v2): la verificación pública
    # MAE/RMSE dirá si supera a IFS en Chile.
    "ecmwf_aifs025_single",
]

HOURLY_VARS = [
    "temperature_2m",
    "relative_humidity_2m",
    "dew_point_2m",
    "precipitation",
    "snowfall",
    "wind_speed_10m",
    "wind_direction_10m",
    "cloud_cover",
    "pressure_msl",
    "freezing_level_height",
    # Avisos v3 (ver ingesta/avisos.py): ráfagas, tormenta convectiva y UV.
    # Verificado empíricamente 2026-07-13 contra la API real (50 ubicaciones,
    # 6 modelos, 13 variables, forecast_days=7): 200 OK, ~2.6 s. La ponderación
    # de Open-Meteo es (variables/10)×(días/14) con mínimo 1/ubicación — con
    # 13 vars y 7 días da 0.65, sigue clavada en el mínimo, no sube costo.
    # cape y uv_index vienen null en algunos modelos/horas (p.ej. uv_index de
    # noche): el pipeline ya tolera None por diseño (ver _series_estacion).
    "wind_gusts_10m",
    "cape",
    "uv_index",
]

HORIZON_HOURS = 168         # 7 días: horizonte del determinista (medido 2026-07-13, sigue en el mínimo de costo de Open-Meteo)
ENSEMBLE_HORIZON_HOURS = 96  # 4 días: el ensamble no se extiende, sigue siendo solo para el rango calibrable
ENSEMBLE_MODEL = "ecmwf_ifs025"
# Open-Meteo no sirve miembros históricos: lo que no se archiva hoy es
# irrecuperable. Verificado en vivo 2026-08-01 contra la API real: las 3
# vars devuelven 51 miembros (control + 50 perturbados) sin colisión de
# prefijos, formato de sufijo "_memberNN" (dos dígitos, int() lo tolera).
ENSEMBLE_VARS = ["temperature_2m", "wind_speed_10m", "precipitation"]

API_FORECAST = "https://api.open-meteo.com/v1/forecast"
API_ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble"
API_METAR = "https://aviationweather.gov/api/data/metar"

# ── DMC (credenciales del registro gratuito; nunca en git) ──────
DMC_USUARIO = os.environ.get("DMC_USUARIO", "")
DMC_TOKEN = os.environ.get("DMC_TOKEN", "")
API_DMC = "https://climatologia.meteochile.gob.cl/application/servicios/getDatosRecientesEma"

# ── Peligros naturales ──────────────────────────────────────────
SISMOS_PATH = Path(os.environ.get("CLIMA_SISMOS", ROOT / "web" / "sismos.json"))
API_SISMOS_CSN = "https://api.xor.cl/sismo/recent"
API_SISMOS_USGS = "https://earthquake.usgs.gov/fdsnws/event/1/query"
CHILE_BBOX = (-76.0, -56.5, -66.0, -17.0)   # O, S, E, N (continental)

INCENDIOS_PATH = Path(os.environ.get("CLIMA_INCENDIOS", ROOT / "web" / "incendios.json"))
FIRMS_MAP_KEY = os.environ.get("FIRMS_MAP_KEY", "")
API_FIRMS = "https://firms.modaps.eosdis.nasa.gov/api/area/csv"

# Precios de combustible en línea (CNE, API v4 con login dinámico).
# Mismo patrón que FIRMS: sin credenciales registradas la capa queda dormida
# (0 estaciones, sin error) — ver ingesta/combustible.py. Accesible directo
# desde el VPS (a diferencia de SEC/MINSAL, no requiere el satélite en omen).
COMBUSTIBLE_PATH = Path(os.environ.get("CLIMA_COMBUSTIBLE", ROOT / "web" / "combustible.json"))
CNE_EMAIL = os.environ.get("CNE_EMAIL", "")
CNE_PASSWORD = os.environ.get("CNE_PASSWORD", "")
CNE_LOGIN_URL = os.environ.get("CNE_LOGIN_URL", "https://api.cne.cl/api/login")
CNE_ESTACIONES_URL = os.environ.get("CNE_ESTACIONES_URL", "https://api.cne.cl/api/v4/estaciones")

ALERTAS_PATH = Path(os.environ.get("CLIMA_ALERTAS", ROOT / "web" / "alertas.json"))
VOLCANES_PATH = Path(os.environ.get("CLIMA_VOLCANES", ROOT / "web" / "volcanes.json"))
# FeatureServers del dashboard oficial de alertas SENAPRED (ArcGIS).
# Si SENAPRED mueve el servicio, se corrige por env sin tocar código.
ALERTAS_ARCGIS_BASE = os.environ.get(
    "ALERTAS_ARCGIS_BASE",
    "https://services3.arcgis.com/CNzkI2T3GmfwkaAR/arcgis/rest/services")
API_RNVV = "https://rnvv.sernageomin.cl/"
API_RNVV_FALLBACK = "https://www.sernageomin.cl/alertas-volcanicas/"

EMERGENCIA_PATH = Path(os.environ.get("CLIMA_EMERGENCIA", ROOT / "web" / "emergencia.json"))
REMOCIONES_PATH = Path(os.environ.get("CLIMA_REMOCIONES", ROOT / "web" / "remociones.json"))
# FeatureServers del visor oficial "Chile Preparado" (SENAPRED).
EMERGENCIA_ARCGIS_BASE = os.environ.get(
    "EMERGENCIA_ARCGIS_BASE",
    "https://services5.arcgis.com/i7S5PSnIJAUcWvSE/arcgis/rest/services")
TSUNAMI_VIAS_PATH = Path(os.environ.get("CLIMA_TSUNAMI_VIAS", ROOT / "web" / "tsunami_vias.json"))
TSUNAMI_AREAS_PATH = Path(os.environ.get("CLIMA_TSUNAMI_AREAS", ROOT / "web" / "tsunami_areas.json"))

MAREA_PATH = Path(os.environ.get("CLIMA_MAREA", ROOT / "web" / "marea.json"))
TSUNAMI_PATH = Path(os.environ.get("CLIMA_TSUNAMI", ROOT / "web" / "tsunami.json"))

# Pronóstico de crecidas de ríos (GloFAS/Copernicus vía Open-Meteo Flood API).
# Puntos curados en rios_cl.py; umbrales propios en la tabla crecidas_umbral.
CRECIDAS_PATH = Path(os.environ.get("CLIMA_CRECIDAS", ROOT / "web" / "crecidas.json"))

# ── Satélite (omen): fuentes que bloquean IPs de datacenter ─────
# INCOMING_DIR es donde satelite/fetch_cl.py sube los JSON crudos por scp
# (sec.json, farmacias_raw.json, esval.json); ingesta/cortes.py y hermanos
# solo los leen, nunca fetchean la red (ver satelite/README.md).
INCOMING_DIR = Path(os.environ.get("CLIMA_INCOMING", ROOT / "data" / "incoming"))
CORTES_PATH = Path(os.environ.get("CLIMA_CORTES", ROOT / "web" / "cortes.json"))
FARMACIAS_PATH = Path(os.environ.get("CLIMA_FARMACIAS", ROOT / "web" / "farmacias.json"))
ESVAL_PATH = Path(os.environ.get("CLIMA_ESVAL", ROOT / "web" / "esval.json"))
COMUNAS_PATH = ROOT / "web" / "comunas.json"  # catastro INE versionado, no lo genera la ingesta

# ── Watchdog de frescura (aviso a Slack, ver watchdog.py) ───────
# Patrón "dormido" (igual que combustible.py): sin webhook, el watchdog
# no hace nada. El estado de transiciones (para no re-notificar) vive en
# CLIMA_WATCHDOG_STATE, junto a los demás datos de /data en prod.
SLACK_WEBHOOK_URL = os.environ.get("SLACK_WEBHOOK_URL", "")
WATCHDOG_STATE_PATH = Path(os.environ.get("CLIMA_WATCHDOG_STATE", ROOT / "data" / "watchdog_state.json"))
