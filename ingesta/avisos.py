"""Avisos meteorológicos derivados del propio pronóstico multi-modelo.

No es un aviso oficial: son umbrales propios (inspirados en los criterios
públicos de avisos de la Dirección Meteorológica de Chile, y en la regla
30-30-30 de manejo del fuego para el aviso de incendio, pero sin ninguna
relación operativa con la DMC ni con CONAF/SENAPRED) aplicados a la MEDIANA
horaria entre modelos del archivo de pronósticos, en la ventana de 120 h desde
ahora (el archivo llega a 168 h; 120 anticipa temporales largos con margen de
datos incluso con el run más viejo del ciclo, y el campo "acuerdo" transparenta
la confianza del ensamble a ese plazo). Las variables calibrables (temperatura, viento, humedad relativa) se
corrigen por sesgo (calibrate.py) antes de la mediana, para ser consistentes
con el pronóstico que ve el usuario; precipitación y nieve quedan crudas.
avisos.json lo declara explícitamente para que nadie lo confunda con un aviso
oficial.

Sin tabla propia: es barato de recalcular (SQL local + mediana, sin red), así
que se recalcula entero en cada corrida en vez de persistir estado.
"""
import json
import statistics
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import calibrate
import config

CL_TZ = ZoneInfo("America/Santiago")

# Umbrales (derivación propia; ver docstring). máx/mín = pico de la mediana
# horaria entre modelos en la ventana de VENTANA_H; lluvia/nieve = pico de la suma
# móvil de 24 h de esa misma mediana horaria. Viento y calor son umbrales
# FIJOS nacionales — ver _umbral_climatologico para el ajuste por estación.
VIENTO_AMARILLO, VIENTO_NARANJA = 60.0, 90.0     # km/h, máx mediana horaria
HELADA_AMARILLO, HELADA_NARANJA = 0.0, -4.0      # °C, mín mediana horaria
LLUVIA_AMARILLO, LLUVIA_NARANJA = 30.0, 60.0     # mm, máx suma móvil 24 h
CALOR_AMARILLO, CALOR_NARANJA = 34.0, 37.0       # °C, máx mediana horaria
NIEVE_AMARILLO, NIEVE_NARANJA = 10.0, 30.0       # cm, máx suma móvil 24 h

# Umbrales rojos: escalón reservado a eventos extremos (derivación propia,
# ver docstring del módulo). Viento y calor se desplazan por el mismo offset
# aditivo que aplica _umbral_climatologico al amarillo/naranja, para no
# perder la coherencia del ajuste por estación.
VIENTO_ROJO = 120.0    # km/h, máx mediana horaria
CALOR_ROJO = 40.0      # °C, máx mediana horaria
HELADA_ROJO = -8.0     # °C, mín mediana horaria
NIEVE_ROJO = 60.0      # cm, máx suma móvil 24 h

# Aviso lluvia persistente: temporales largos que acumulan agua sin cruzar
# nunca el umbral de 24 h (p.ej. 25 mm/día dos días seguidos) igual saturan el
# suelo y elevan el riesgo de crecidas — exactamente el caso que el aviso de
# lluvia de 24 h no ve. Se emite ADEMÁS del aviso de 24 h si ambos cruzan
# (productos distintos, sin dedupe). Derivación propia, sin relación operativa
# con la DMC, igual que el resto del módulo.
LLUVIA48_AMARILLO, LLUVIA48_NARANJA = 50.0, 90.0  # mm, máx suma móvil 48 h

# Rojo de lluvia por MACROZONA: a diferencia de amarillo/naranja (nacionales),
# el rojo es el escalón de impacto extremo y ahí la geografía pesa — 120 mm/48h
# es un temporal devastador en Valparaíso y un invierno normal en Valdivia.
# Umbral de impacto según climatología regional (referencia real: temporal de
# junio 2023 en la zona central, ~100-150 mm/48 h con daño severo). Derivación
# propia, sin relación operativa con la DMC. Estación sin región reconocida
# usa el umbral del sur (el más exigente = conservador, sin falsos rojos).
LLUVIA_ROJO = {"norte": 50.0, "centro": 80.0, "sur": 120.0}          # mm/24h
LLUVIA48_ROJO = {"norte": 80.0, "centro": 120.0, "sur": 180.0}       # mm/48h

MACROZONA_NORTE = {"XV", "I", "II", "III", "IV"}
MACROZONA_CENTRO = {"V", "RM", "VI", "VII"}
MACROZONA_SUR = {"VIII", "XVI", "IX", "XIV", "X", "XI", "XII"}


def _macrozona(region: str | None) -> str:
    if region in MACROZONA_NORTE:
        return "norte"
    if region in MACROZONA_CENTRO:
        return "centro"
    return "sur"  # incluye MACROZONA_SUR y región desconocida (conservador)

# Aviso aluvional: lluvia intensa + isoterma 0° alta significa que la cuenca
# recibe agua líquida en vez de nieve, con riesgo de crecidas repentinas y
# aluviones en quebradas y laderas. Requiere AMBAS condiciones a la vez sobre
# la misma ventana de 24 h del pico de lluvia (derivación propia, sin
# relación operativa con la DMC, igual que el resto del módulo).
ALUVION_LLUVIA_AMARILLO, ALUVION_LLUVIA_NARANJA = 20.0, 40.0     # mm, suma móvil 24 h
ALUVION_ISOTERMA_AMARILLO, ALUVION_ISOTERMA_NARANJA = 2900.0, 3400.0  # m, mediana en la ventana
# Sin escalón rojo: el aviso ya es compuesto y estricto (requiere AMBAS
# condiciones a la vez), y no hay un tercer punto de corte propio para el
# par lluvia+isoterma que no sea arbitrario — se prefiere no inventarlo.

# Aviso incendio: regla 30-30-30 (criterio establecido en manejo del fuego).
# Temperatura, humedad relativa y viento deben cumplirse en la MISMA hora de
# la mediana multi-modelo. Derivación propia, sin relación operativa con
# CONAF/SENAPRED.
INCENDIO_TEMP_AMARILLO, INCENDIO_TEMP_NARANJA = 30.0, 35.0        # °C
INCENDIO_HR_AMARILLO, INCENDIO_HR_NARANJA = 30.0, 25.0            # %, menor es peor
INCENDIO_VIENTO_AMARILLO, INCENDIO_VIENTO_NARANJA = 30.0, 40.0    # km/h
# Sin escalón rojo: la regla 30-30-30 es un criterio establecido de dos
# niveles; no define un tercer umbral, y estirarla a un "60-60-60" propio
# sería inventar un criterio sin respaldo, no derivarlo del existente.

# Aviso ráfagas (wind_gusts_10m, pico de la mediana horaria): SIN ajuste
# climatológico ni escalón por umbral fijo nacional único — a diferencia de
# viento sostenido, no hay observaciones de ráfaga pareadas en la red (regla 6:
# invariante de que todo umbral climatológico se valida contra observaciones),
# así que el ajuste por estación de _umbral_climatologico no aplica aquí.
# La Patagonia (XI y XII) sí necesita un umbral fijo MÁS ALTO que el resto:
# el viento austral sostenido ya ronda 80-100 km/h en primavera, y un umbral
# nacional único dejaría esas dos regiones en aviso amarillo permanente
# (mismo problema que _umbral_climatologico resuelve para viento sostenido,
# pero aquí con un set de regiones fijo en vez de percentil, porque no hay
# observación de ráfaga con la que calcular ese percentil). Derivación propia.
RAFAGAS_AMARILLO, RAFAGAS_NARANJA, RAFAGAS_ROJO = 90.0, 120.0, 150.0        # km/h
RAFAGAS_AUSTRAL_AMARILLO, RAFAGAS_AUSTRAL_NARANJA, RAFAGAS_AUSTRAL_ROJO = 100.0, 130.0, 160.0
REGIONES_AUSTRAL = {"XI", "XII"}

# Aviso caída brusca de presión (precursor de ciclogénesis explosiva): máxima
# CAÍDA (hPa, positiva) de la mediana de pressure_msl en una ventana móvil de
# 24 h. 24 hPa/24h es el criterio clásico de ciclogénesis explosiva (Bergeron
# 1954, "bomb cyclone"), ajustado a latitudes medias — el escalón rojo. Es el
# precursor del temporal de viento: cae la presión antes de que la ráfaga
# aparezca en el pronóstico, dando anticipación adicional. Derivación propia.
PRESION_AMARILLO, PRESION_NARANJA, PRESION_ROJO = 12.0, 18.0, 24.0   # hPa/24h, máx caída
# Defensa en profundidad: ninguna ciclogénesis explosiva registrada cae más de
# esto en 24 h. Por encima es error de datos (sensor roto contaminando el
# bias, no clima real) — se descarta el aviso aunque haya pasado el gate de
# calibrate.py.
CAIDA_PRESION_MAX_PLAUSIBLE = 60.0

# Aviso nieve en cota baja (compuesto, patrón aluvional): suma móvil 24 h de
# precipitation Y mediana de freezing_level_height baja en la MISMA ventana —
# nieve real en rutas/ciudades del centro-sur, no solo en cordillera. Sin
# escalón rojo: como el aluvional, el par lluvia+isoterma no tiene un tercer
# corte no arbitrario — se prefiere no inventarlo. Derivación propia.
NIEVE_BAJA_LLUVIA_AMARILLO, NIEVE_BAJA_LLUVIA_NARANJA = 5.0, 10.0         # mm, suma móvil 24 h
NIEVE_BAJA_ISOTERMA_AMARILLO, NIEVE_BAJA_ISOTERMA_NARANJA = 1500.0, 1200.0  # m, mediana en la ventana (menor es peor)

# Aviso ola de calor: 3+ días LOCALES (America/Santiago) consecutivos con
# temperatura máxima diaria de la mediana sobre el umbral. Distinto de
# "calor" (pico puntual): esto exige sostenido varios días. Umbrales propios.
OLA_CALOR_DIAS_MIN = 3
OLA_CALOR_AMARILLO, OLA_CALOR_NARANJA, OLA_CALOR_ROJO = 32.0, 35.0, 38.0  # °C, máx diaria

# Aviso ola de frío: ídem con mínima diaria. Sin rojo: la helada puntual ya
# tiene su propio escalón rojo en HELADA_ROJO (-8°C); este aviso es sobre
# SOSTENIDO, no sobre el pico más extremo de una sola noche.
OLA_FRIO_DIAS_MIN = 3
OLA_FRIO_AMARILLO, OLA_FRIO_NARANJA = 0.0, -4.0  # °C, mín diaria

# Aviso tormenta eléctrica (CAPE, pico de la mediana horaria): CAPE es
# condición NECESARIA no suficiente para convección severa (energía potencial
# disponible, no pronóstico de rayos/granizo) — indicativo de potencial
# convectivo. Relevante sobre todo en el invierno boliviano del Altiplano
# (verano austral, humedad del NE sobre el altiplano andino). Sin escalón
# rojo: CAPE por sí solo no discrimina el tercer nivel sin más variables
# (cizalladura, humedad) que este módulo no deriva. Derivación propia.
TORMENTA_AMARILLO, TORMENTA_NARANJA = 1000.0, 2500.0  # J/kg, máx mediana horaria

# Aviso UV (uv_index, pico de la mediana horaria): escala OMI/OMS estándar,
# no un umbral propio — 9 = "muy alto", 11 = "extremo" son los cortes
# publicados por la Organización Mundial de la Salud. Sin escalón rojo: la
# escala OMS termina en "extremo" (≥11), no define un cuarto nivel.
UV_AMARILLO, UV_NARANJA = 9.0, 11.0

# Umbral climatológico (viento y calor SOLAMENTE): en zonas donde el umbral
# fijo nacional es habitual (p.ej. viento en Patagonia), un umbral fijo deja
# la estación en aviso permanente. Se sube el umbral a percentil 98 de sus
# propias observaciones cuando ese percentil supera al fijo, con gate de
# muestra mínima — sin muestra suficiente, el ajuste NO se aplica (se
# prefiere un umbral fijo conservador a un percentil poco confiable).
MIN_OBS_CLIMATOLOGICO = 1000
PERCENTIL_CLIMATOLOGICO = 98

# Gate de CANTIDAD de datos para avisos compuestos (aluvional, incendio,
# nieve_cota_baja): la mediana entre modelos puede salir de una lista de 1
# solo valor, un outlier de un único modelo disfrazado de consenso. Se exige
# un mínimo de modelos PRESENTES (con dato, sea cual sea su valor) en la
# hora/ventana que gatilla el aviso, para cada variable que lo compone. Esto
# protege contra falsos positivos por dato escaso — NO exige acuerdo entre
# modelos (eso es el campo "acuerdo", nunca un gate, ver _acuerdo_pico): un
# aviso con acuerdo 1/6 pero con los 6 modelos presentes debe seguir
# emitiéndose. Se tolera falso positivo por desacuerdo, NO se tolera falso
# negativo por dato insuficiente.
MIN_MODELOS_COMPUESTO = 3

# Frescura del pronóstico BASE (regla 8): los pronósticos corren 2x/día, así
# que más de un ciclo de margen (>24 h) significa que se perdió al menos una
# corrida — p.ej. por un 429 de Open-Meteo. avisos.json ya siempre queda con
# "updated" fresco (se recalcula cada corrida), pero si el run_tag que lo
# alimenta es viejo, el aviso está calculado sobre un pronóstico desactualizado
# y hay que decirlo explícito, no solo la fecha de cálculo.
STALE_HORAS = 24

VENTANA_H = 120
VARS = ["wind_speed_10m", "temperature_2m", "precipitation", "snowfall",
        "freezing_level_height", "relative_humidity_2m", "pressure_msl",
        # Avisos v3: sin observación pareada de ráfaga/CAPE/UV, quedan crudas
        # (no en config.CALIBRABLE_VARS) — mismo tratamiento que precipitation.
        "wind_gusts_10m", "cape", "uv_index"]

# Variables de VARS que además son calibrables (config.CALIBRABLE_VARS): se
# corrige cada valor por modelo con el bias de calibrate.py ANTES de la
# mediana, para que el aviso sea consistente con el pronóstico que ve el
# usuario. precipitation/snowfall/freezing_level_height quedan crudas
# (regla 5: nunca se calibra precipitation, y snowfall/isoterma no están en
# CALIBRABLE_VARS).
VARS_CALIBRABLES = [v for v in VARS if v in config.CALIBRABLE_VARS]


def _series_estacion(con, station_id: str, run_tag: str, desde: str, hasta: str) -> tuple[dict, dict, dict]:
    """(series, por_modelo, series_crudo):
    - series: {variable: [(valid_time, mediana_entre_modelos)]}, ordenado, sin None.
    - por_modelo: {variable: {model: [(valid_time, value)]}}, ordenado, sin None.
      Base del acuerdo de ensamble (B1): cada model=... es un modelo determinista
      distinto archivado con member=-1 (ver forecasts en db.py); la mediana entre
      todas esas filas por hora es lo que arma `series`.
    - series_crudo: igual forma que `series`, pero SIN la corrección de sesgo
      (auditoría de avisos_emitidos, ver _valor_crudo). Para variables fuera de
      VARS_CALIBRABLES es idéntica a `series` (calibrate.correct nunca se les
      aplica).

    Para las variables en VARS_CALIBRABLES, cada valor se corrige por sesgo
    (calibrate.correct, gate + shrinkage incluidos) antes de entrar a la
    mediana y al desglose por modelo — misma base que el pronóstico servido.
    """
    placeholders = ",".join("?" * len(VARS))
    rows = con.execute(
        f"SELECT variable, model, valid_time, value FROM forecasts"
        f" WHERE station=? AND run_tag=? AND member=-1 AND variable IN ({placeholders})"
        f" AND valid_time >= ? AND valid_time <= ?",
        (station_id, run_tag, *VARS, desde, hasta))
    run_dt = datetime.fromisoformat(run_tag + ":00")
    por_hora: dict = {}
    por_hora_crudo: dict = {}
    por_modelo_raw: dict = {}
    for var, model, vt, val_crudo in rows:
        if val_crudo is None:
            continue
        val = val_crudo
        if var in VARS_CALIBRABLES:
            lead_hours = (datetime.fromisoformat(vt) - run_dt).total_seconds() / 3600
            val = calibrate.correct(con, station_id, model, var, lead_hours, val_crudo)
        por_hora.setdefault(var, {}).setdefault(vt, []).append(val)
        por_hora_crudo.setdefault(var, {}).setdefault(vt, []).append(val_crudo)
        por_modelo_raw.setdefault(var, {}).setdefault(model, []).append((vt, val))
    series = {var: [(vt, statistics.median(horas[vt])) for vt in sorted(horas)]
              for var, horas in por_hora.items()}
    series_crudo = {var: [(vt, statistics.median(horas[vt])) for vt in sorted(horas)]
                     for var, horas in por_hora_crudo.items()}
    por_modelo = {var: {m: sorted(vals) for m, vals in modelos.items()}
                  for var, modelos in por_modelo_raw.items()}
    return series, por_modelo, series_crudo


def _modelos_presentes(por_modelo: dict, var: str, hora: str) -> int:
    """Cuenta cuántos modelos de por_modelo[var] tienen dato en 'hora' (valid_time
    exacto), sin importar su valor — gate de CANTIDAD, no de acuerdo (ver
    MIN_MODELOS_COMPUESTO). Reusada por los tres avisos compuestos para no
    triplicar la lógica de conteo."""
    modelos = por_modelo.get(var, {})
    return sum(1 for serie in modelos.values() if hora in dict(serie))


def _rolling_sum(serie: list, n_horas: int) -> list:
    """[(valid_time_de_fin_de_ventana, suma)], solo ventanas de n_horas puntos
    completas. Aproximado: si falta la mediana de alguna hora (todos los
    modelos None), esa hora no cuenta como punto y la ventana de "n_horas
    puntos" puede cubrir algo más de n_horas de reloj — aceptable para un
    aviso derivado, no oficial."""
    return [
        (serie[i][0], sum(v for _, v in serie[i - (n_horas - 1):i + 1]))
        for i in range(n_horas - 1, len(serie))
    ]


def _nivel(valor: float, amarillo: float, naranja: float, mayor_es_peor: bool,
           rojo: float | None = None) -> str | None:
    if mayor_es_peor:
        if rojo is not None and valor >= rojo:
            return "rojo"
        if valor >= naranja:
            return "naranja"
        if valor >= amarillo:
            return "amarillo"
    else:
        if rojo is not None and valor <= rojo:
            return "rojo"
        if valor <= naranja:
            return "naranja"
        if valor <= amarillo:
            return "amarillo"
    return None


def _percentil(valores_ordenados: list, p: float) -> float:
    """Percentil por índice (nearest-rank, sin scipy). `valores_ordenados` YA
    ordenado ascendente."""
    n = len(valores_ordenados)
    idx = min(n - 1, max(0, round(p / 100 * (n - 1))))
    return valores_ordenados[idx]


def _umbral_climatologico(con, station_id: str, variable: str,
                           amarillo_fijo: float, naranja_fijo: float,
                           rojo_fijo: float | None = None) -> tuple[float, float, float | None]:
    """Umbral efectivo = max(fijo, percentil 98 de las OBSERVACIONES de esa
    estación para esa variable), con gate de muestra mínima. `naranja` conserva
    la separación ABSOLUTA amarillo/naranja del umbral fijo (offset, no razón:
    temperatura es escala de intervalo, no de razón — escalar por cociente
    depende de si se mide en °C o K, lo que es un error de unidades). `rojo`,
    si se entrega, se desplaza con el mismo offset aditivo que naranja, para
    mantener coherente el mecanismo de ajuste."""
    rows = con.execute(
        "SELECT value FROM observations WHERE station=? AND variable=? AND value IS NOT NULL",
        (station_id, variable)).fetchall()
    if len(rows) < MIN_OBS_CLIMATOLOGICO:
        return amarillo_fijo, naranja_fijo, rojo_fijo
    valores = sorted(v for (v,) in rows)
    p98 = _percentil(valores, PERCENTIL_CLIMATOLOGICO)
    amarillo_efectivo = max(amarillo_fijo, p98)
    naranja_efectivo = amarillo_efectivo + (naranja_fijo - amarillo_fijo)
    rojo_efectivo = (amarillo_efectivo + (rojo_fijo - amarillo_fijo)
                     if rojo_fijo is not None else None)
    return amarillo_efectivo, naranja_efectivo, rojo_efectivo


def _acuerdo_pico(por_modelo: dict, var: str, amarillo: float, naranja: float,
                   mayor_es_peor: bool) -> str:
    """'n_superan/n_modelos_con_datos': cuántos modelos, por sí solos (su propio
    pico horario en la ventana), superan el umbral amarillo de este aviso.
    Información de confianza del ensamble — NUNCA un gate: un aviso con
    acuerdo 1/6 igual se emite si la mediana lo cruza."""
    modelos = por_modelo.get(var, {})
    n_supera = sum(
        1 for serie in modelos.values()
        if _nivel(max(v for _, v in serie) if mayor_es_peor else min(v for _, v in serie),
                  amarillo, naranja, mayor_es_peor) is not None
    )
    return f"{n_supera}/{len(modelos)}"


def _acuerdo_rolling(por_modelo: dict, var: str, amarillo: float, naranja: float,
                      n_horas: int = 24) -> str:
    """Ídem _acuerdo_pico para lluvia/nieve/aluvional/lluvia persistente: la
    suma móvil de n_horas de cada modelo por sí solo. El denominador son los
    modelos con ventana de n_horas puntos completa (los demás no tienen forma
    de opinar)."""
    modelos = por_modelo.get(var, {})
    n_con_ventana = n_supera = 0
    for serie in modelos.values():
        rolling = _rolling_sum(serie, n_horas)
        if not rolling:
            continue
        n_con_ventana += 1
        if _nivel(max(v for _, v in rolling), amarillo, naranja, mayor_es_peor=True) is not None:
            n_supera += 1
    return f"{n_supera}/{n_con_ventana}"


def _rolling_caida(serie: list, n_horas: int) -> list:
    """[(valid_time_de_fin_de_ventana, caida)]: caida = valor al INICIO de la
    ventana menos valor al FIN (positiva = presión bajando). Solo ventanas de
    n_horas puntos completas — mismo criterio de completitud que _rolling_sum."""
    return [
        (serie[i][0], serie[i - (n_horas - 1)][1] - serie[i][1])
        for i in range(n_horas - 1, len(serie))
    ]


def _acuerdo_caida(por_modelo: dict, var: str, amarillo: float, naranja: float,
                    n_horas: int = 24) -> str:
    """Ídem _acuerdo_rolling para el aviso de presión: la caída de n_horas de
    cada modelo por sí solo."""
    modelos = por_modelo.get(var, {})
    n_con_ventana = n_supera = 0
    for serie in modelos.values():
        caidas = _rolling_caida(serie, n_horas)
        if not caidas:
            continue
        n_con_ventana += 1
        if _nivel(max(v for _, v in caidas), amarillo, naranja, mayor_es_peor=True) is not None:
            n_supera += 1
    return f"{n_supera}/{n_con_ventana}"


def _dia_local(valid_time: str):
    """Fecha LOCAL America/Santiago de un valid_time UTC ("YYYY-MM-DDTHH:MM").
    Rapa Nui (UTC-6) queda desplazado hasta ±2 h del huso continental: se
    acepta el desvío (aviso derivado, no oficial) en vez de mantener un huso
    por estación."""
    dt_utc = datetime.fromisoformat(valid_time).replace(tzinfo=timezone.utc)
    return dt_utc.astimezone(CL_TZ).date()


def _extremos_diarios_locales(serie: list, mayor_es_peor: bool) -> list:
    """Agrupa 'serie' [(valid_time, valor)] por día LOCAL y devuelve
    [(fecha, valid_time_del_extremo, valor_extremo)] ordenado por fecha. Incluye
    días parciales en el borde de la ventana de 120 h (ola de calor/frío es
    sobre el extremo diario disponible, no exige el día completo)."""
    por_dia: dict = {}
    for vt, val in serie:
        d = _dia_local(vt)
        actual = por_dia.get(d)
        if actual is None or (val > actual[1] if mayor_es_peor else val < actual[1]):
            por_dia[d] = (vt, val)
    return [(d, *por_dia[d]) for d in sorted(por_dia)]


def _racha_mas_larga(dias: list, umbral: float, mayor_es_peor: bool) -> list:
    """Racha de días CONSECUTIVOS (diferencia de 1 día calendario) más larga
    donde el extremo diario cruza 'umbral'. 'dias' = salida de
    _extremos_diarios_locales, ya ordenada por fecha."""
    mejor: list = []
    actual: list = []
    prev_fecha = None
    for fecha, vt, val in dias:
        cumple = val >= umbral if mayor_es_peor else val <= umbral
        if cumple and prev_fecha is not None and (fecha - prev_fecha).days == 1:
            actual.append((fecha, vt, val))
        elif cumple:
            actual = [(fecha, vt, val)]
        else:
            actual = []
        if len(actual) > len(mejor):
            mejor = actual
        prev_fecha = fecha
    return mejor


def _acuerdo_incendio(por_modelo: dict) -> str:
    """Ídem para incendio: cuántos modelos, con su propia temperatura/HR/viento
    (sin pasar por la mediana), cumplen 30-30-30 en alguna hora común."""
    temp_m = por_modelo.get("temperature_2m", {})
    hr_m = por_modelo.get("relative_humidity_2m", {})
    viento_m = por_modelo.get("wind_speed_10m", {})
    modelos = set(temp_m) & set(hr_m) & set(viento_m)
    n_supera = 0
    for m in modelos:
        temp_h, hr_h, viento_h = dict(temp_m[m]), dict(hr_m[m]), dict(viento_m[m])
        horas = set(temp_h) & set(hr_h) & set(viento_h)
        if any(temp_h[h] >= INCENDIO_TEMP_AMARILLO and hr_h[h] <= INCENDIO_HR_AMARILLO
               and viento_h[h] >= INCENDIO_VIENTO_AMARILLO for h in horas):
            n_supera += 1
    return f"{n_supera}/{len(modelos)}"


def _aviso(st: dict, tipo: str, nivel: str, valor: float, unidad: str, valid_time: str,
           **extra) -> dict:
    d = {
        "estacion_id": st["id"], "nombre": st["nombre"], "region": st.get("region"),
        "lat": st["lat"], "lon": st["lon"],
        "tipo": tipo, "nivel": nivel,
        "valor": round(valor, 1), "unidad": unidad,
        "hora_peak": valid_time + ":00Z",   # valid_time siempre "YYYY-MM-DDTHH:MM"
    }
    d.update(extra)
    return d


def _suma_ventana(serie: list, n_horas: int) -> float | None:
    """Suma de los primeros n_horas puntos horarios de la serie (mediana entre
    modelos), o None si la variable no tiene ningún dato en la ventana (p.ej.
    snowfall recién agregado, sin filas hasta la próxima corrida de forecasts).
    0.0 es información válida (no llueve/no nieva), por eso no se confunde con
    la ausencia de datos."""
    if not serie:
        return None
    return round(sum(v for _, v in serie[:n_horas]), 1)


def _acumulado_estacion(st: dict, series: dict) -> dict:
    precip = series.get("precipitation") or []
    nieve = series.get("snowfall") or []
    return {
        "id": st["id"], "nombre": st["nombre"], "region": st.get("region"),
        "lat": st["lat"], "lon": st["lon"],
        "lluvia_24h": _suma_ventana(precip, 24),
        "lluvia_48h": _suma_ventana(precip, 48),
        "nieve_24h": _suma_ventana(nieve, 24),
        "nieve_48h": _suma_ventana(nieve, 48),
    }


def _aviso_incendio(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Regla 30-30-30: temperatura ≥30 °C, humedad relativa ≤30 % y viento
    ≥30 km/h EN LA MISMA HORA de la mediana multi-modelo (≥35°/≤25 %/≥40 km/h
    = naranja). hora_peak = la primera hora que alcanza el nivel más alto
    alcanzado en toda la ventana."""
    temp = dict(series.get("temperature_2m") or [])
    hr = dict(series.get("relative_humidity_2m") or [])
    viento = dict(series.get("wind_speed_10m") or [])
    horas = sorted(set(temp) & set(hr) & set(viento))

    def nivel_hora(h: str) -> str | None:
        t, r, v = temp[h], hr[h], viento[h]
        if t >= INCENDIO_TEMP_NARANJA and r <= INCENDIO_HR_NARANJA and v >= INCENDIO_VIENTO_NARANJA:
            return "naranja"
        if t >= INCENDIO_TEMP_AMARILLO and r <= INCENDIO_HR_AMARILLO and v >= INCENDIO_VIENTO_AMARILLO:
            return "amarillo"
        return None

    niveles = {h: nivel_hora(h) for h in horas}
    if "naranja" in niveles.values():
        nivel_top = "naranja"
    elif "amarillo" in niveles.values():
        nivel_top = "amarillo"
    else:
        return None
    h = next(h for h in horas if niveles[h] == nivel_top)  # horas ordenadas asc.
    n_temp = _modelos_presentes(por_modelo, "temperature_2m", h)
    n_hr = _modelos_presentes(por_modelo, "relative_humidity_2m", h)
    n_viento = _modelos_presentes(por_modelo, "wind_speed_10m", h)
    if min(n_temp, n_hr, n_viento) < MIN_MODELOS_COMPUESTO:
        print(f"[aviso] incendio: datos insuficientes descartado "
              f"(estación {st['id']}: temp={n_temp} hr={n_hr} viento={n_viento}"
              f" modelos, mínimo {MIN_MODELOS_COMPUESTO})")
        return None
    t, r, v = temp[h], hr[h], viento[h]
    acuerdo = _acuerdo_incendio(por_modelo)
    return _aviso(st, "incendio", nivel_top, t, "°C", h, acuerdo=acuerdo,
                  hr=round(r, 1), viento=round(v, 1))


def _aviso_rafagas(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Pico de la mediana horaria de wind_gusts_10m. Sin ajuste climatológico
    (ver docstring de RAFAGAS_AMARILLO): umbral fijo nacional, más alto en la
    Patagonia (XI/XII) para no dejarla en aviso permanente."""
    serie = series.get("wind_gusts_10m") or []
    if not serie:
        return None
    vt, val = max(serie, key=lambda p: p[1])
    if st.get("region") in REGIONES_AUSTRAL:
        amarillo, naranja, rojo = RAFAGAS_AUSTRAL_AMARILLO, RAFAGAS_AUSTRAL_NARANJA, RAFAGAS_AUSTRAL_ROJO
    else:
        amarillo, naranja, rojo = RAFAGAS_AMARILLO, RAFAGAS_NARANJA, RAFAGAS_ROJO
    nivel = _nivel(val, amarillo, naranja, mayor_es_peor=True, rojo=rojo)
    if not nivel:
        return None
    acuerdo = _acuerdo_pico(por_modelo, "wind_gusts_10m", amarillo, naranja, True)
    return _aviso(st, "rafagas", nivel, val, "km/h", vt, acuerdo=acuerdo, umbral=round(amarillo, 1))


def _aviso_presion(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Máxima caída de la mediana de pressure_msl en ventana móvil de 24 h.
    Precursor de ciclogénesis explosiva (ver docstring de PRESION_ROJO): da
    anticipación antes de que la ráfaga aparezca en el pronóstico."""
    serie = series.get("pressure_msl") or []
    caidas = _rolling_caida(serie, 24)
    if not caidas:
        return None
    vt, val = max(caidas, key=lambda p: p[1])
    if val > CAIDA_PRESION_MAX_PLAUSIBLE:
        print(f"[aviso] presion: caída implausible descartada "
              f"(estación {st['id']}: {val} hPa/24h — probable error de datos)")
        return None
    nivel = _nivel(val, PRESION_AMARILLO, PRESION_NARANJA, mayor_es_peor=True, rojo=PRESION_ROJO)
    if not nivel:
        return None
    acuerdo = _acuerdo_caida(por_modelo, "pressure_msl", PRESION_AMARILLO, PRESION_NARANJA)
    return _aviso(st, "presion", nivel, val, "hPa/24h", vt, acuerdo=acuerdo)


def _aviso_nieve_baja(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Compuesto (patrón del aluvional): suma móvil 24 h de precipitation Y
    mediana de freezing_level_height baja en la MISMA ventana → nieve real en
    rutas/ciudades del centro-sur, no solo cordillera. Null-safe: si
    freezing_level_height o precipitation aún no tienen filas, no evalúa."""
    precip = series.get("precipitation") or []
    rolling = _rolling_sum(precip, 24)
    if not rolling:
        return None
    vt, val = max(rolling, key=lambda p: p[1])
    iso_serie = series.get("freezing_level_height") or []
    if not iso_serie:
        return None
    idx = next(i for i, (t, _) in enumerate(precip) if t == vt)
    ventana_times = [t for t, _ in precip[idx - 23:idx + 1]]
    iso_por_hora = dict(iso_serie)
    iso_vals = [iso_por_hora[t] for t in ventana_times if t in iso_por_hora]
    if not iso_vals:
        return None
    iso_mediana = statistics.median(iso_vals)
    if val >= NIEVE_BAJA_LLUVIA_NARANJA and iso_mediana <= NIEVE_BAJA_ISOTERMA_NARANJA:
        nivel = "naranja"
    elif val >= NIEVE_BAJA_LLUVIA_AMARILLO and iso_mediana <= NIEVE_BAJA_ISOTERMA_AMARILLO:
        nivel = "amarillo"
    else:
        return None
    n_lluvia = _modelos_presentes(por_modelo, "precipitation", vt)
    n_iso = _modelos_presentes(por_modelo, "freezing_level_height", vt)
    if min(n_lluvia, n_iso) < MIN_MODELOS_COMPUESTO:
        print(f"[aviso] nieve_cota_baja: datos insuficientes descartado "
              f"(estación {st['id']}: lluvia={n_lluvia} iso={n_iso} modelos,"
              f" mínimo {MIN_MODELOS_COMPUESTO})")
        return None
    acuerdo = _acuerdo_rolling(por_modelo, "precipitation",
                                NIEVE_BAJA_LLUVIA_AMARILLO, NIEVE_BAJA_LLUVIA_NARANJA)
    aviso = _aviso(st, "nieve_cota_baja", nivel, val, "mm", vt, acuerdo=acuerdo)
    aviso["isoterma_m"] = round(iso_mediana / 100) * 100
    return aviso


def _aviso_ola_calor(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """3+ días LOCALES consecutivos con temperatura máxima diaria de la
    mediana ≥ OLA_CALOR_AMARILLO. Distinto de "calor" (pico puntual): esto
    exige persistencia."""
    temp = series.get("temperature_2m") or []
    if not temp:
        return None
    dias = _extremos_diarios_locales(temp, mayor_es_peor=True)
    racha = _racha_mas_larga(dias, OLA_CALOR_AMARILLO, mayor_es_peor=True)
    if len(racha) < OLA_CALOR_DIAS_MIN:
        return None
    _, vt_pico, val_pico = max(racha, key=lambda d: d[2])
    nivel = _nivel(val_pico, OLA_CALOR_AMARILLO, OLA_CALOR_NARANJA, mayor_es_peor=True, rojo=OLA_CALOR_ROJO)
    acuerdo = _acuerdo_pico(por_modelo, "temperature_2m", OLA_CALOR_AMARILLO, OLA_CALOR_NARANJA, True)
    aviso = _aviso(st, "ola_calor", nivel, val_pico, "°C", vt_pico, acuerdo=acuerdo)
    aviso["dias"] = len(racha)
    return aviso


def _aviso_ola_frio(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Ídem ola de calor con mínima diaria ≤ OLA_FRIO_AMARILLO. Sin rojo: la
    helada puntual ya tiene su propio escalón rojo en HELADA_ROJO."""
    temp = series.get("temperature_2m") or []
    if not temp:
        return None
    dias = _extremos_diarios_locales(temp, mayor_es_peor=False)
    racha = _racha_mas_larga(dias, OLA_FRIO_AMARILLO, mayor_es_peor=False)
    if len(racha) < OLA_FRIO_DIAS_MIN:
        return None
    _, vt_pico, val_pico = min(racha, key=lambda d: d[2])
    nivel = _nivel(val_pico, OLA_FRIO_AMARILLO, OLA_FRIO_NARANJA, mayor_es_peor=False)
    acuerdo = _acuerdo_pico(por_modelo, "temperature_2m", OLA_FRIO_AMARILLO, OLA_FRIO_NARANJA, False)
    aviso = _aviso(st, "ola_frio", nivel, val_pico, "°C", vt_pico, acuerdo=acuerdo)
    aviso["dias"] = len(racha)
    return aviso


def _aviso_tormenta(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Pico de la mediana horaria de CAPE: condición NECESARIA no suficiente
    para convección severa (energía potencial disponible, no pronóstico de
    rayos/granizo). Relevante sobre todo en el invierno boliviano del
    Altiplano. Sin rojo: CAPE solo no discrimina un tercer nivel sin más
    variables (cizalladura, humedad) que este módulo no deriva."""
    serie = series.get("cape") or []
    if not serie:
        return None
    vt, val = max(serie, key=lambda p: p[1])
    nivel = _nivel(val, TORMENTA_AMARILLO, TORMENTA_NARANJA, mayor_es_peor=True)
    if not nivel:
        return None
    acuerdo = _acuerdo_pico(por_modelo, "cape", TORMENTA_AMARILLO, TORMENTA_NARANJA, True)
    return _aviso(st, "tormenta", nivel, val, "J/kg", vt, acuerdo=acuerdo)


def _aviso_uv(series: dict, por_modelo: dict, st: dict) -> dict | None:
    """Pico de la mediana horaria de uv_index. Escala OMS estándar (9 = "muy
    alto", 11 = "extremo"), no un umbral propio. Solo se emite si la variable
    tiene datos: algunos modelos/horas la entregan None (radiación nocturna),
    ya tolerado por _series_estacion."""
    serie = series.get("uv_index") or []
    if not serie:
        return None
    vt, val = max(serie, key=lambda p: p[1])
    nivel = _nivel(val, UV_AMARILLO, UV_NARANJA, mayor_es_peor=True)
    if not nivel:
        return None
    acuerdo = _acuerdo_pico(por_modelo, "uv_index", UV_AMARILLO, UV_NARANJA, True)
    return _aviso(st, "uv", nivel, val, "índice UV", vt, acuerdo=acuerdo)


def _avisos_estacion(series: dict, por_modelo: dict, st: dict,
                      viento_umbral: tuple, calor_umbral: tuple) -> list:
    avisos = []
    viento_amarillo, viento_naranja, viento_rojo = viento_umbral
    calor_amarillo, calor_naranja, calor_rojo = calor_umbral
    macrozona = _macrozona(st.get("region"))
    lluvia_rojo = LLUVIA_ROJO[macrozona]
    lluvia48_rojo = LLUVIA48_ROJO[macrozona]

    viento = series.get("wind_speed_10m") or []
    if viento:
        vt, val = max(viento, key=lambda p: p[1])
        nivel = _nivel(val, viento_amarillo, viento_naranja, mayor_es_peor=True, rojo=viento_rojo)
        if nivel:
            acuerdo = _acuerdo_pico(por_modelo, "wind_speed_10m", viento_amarillo, viento_naranja, True)
            avisos.append(_aviso(st, "viento", nivel, val, "km/h", vt,
                                  acuerdo=acuerdo, umbral=round(viento_amarillo, 1)))

    temp = series.get("temperature_2m") or []
    if temp:
        vt_min, val_min = min(temp, key=lambda p: p[1])
        nivel = _nivel(val_min, HELADA_AMARILLO, HELADA_NARANJA, mayor_es_peor=False, rojo=HELADA_ROJO)
        if nivel:
            acuerdo = _acuerdo_pico(por_modelo, "temperature_2m", HELADA_AMARILLO, HELADA_NARANJA, False)
            avisos.append(_aviso(st, "helada", nivel, val_min, "°C", vt_min, acuerdo=acuerdo))

        vt_max, val_max = max(temp, key=lambda p: p[1])
        nivel = _nivel(val_max, calor_amarillo, calor_naranja, mayor_es_peor=True, rojo=calor_rojo)
        if nivel:
            acuerdo = _acuerdo_pico(por_modelo, "temperature_2m", calor_amarillo, calor_naranja, True)
            avisos.append(_aviso(st, "calor", nivel, val_max, "°C", vt_max,
                                  acuerdo=acuerdo, umbral=round(calor_amarillo, 1)))

    precip = series.get("precipitation") or []
    rolling = _rolling_sum(precip, 24)
    if rolling:
        vt, val = max(rolling, key=lambda p: p[1])
        nivel = _nivel(val, LLUVIA_AMARILLO, LLUVIA_NARANJA, mayor_es_peor=True, rojo=lluvia_rojo)
        if nivel:
            acuerdo = _acuerdo_rolling(por_modelo, "precipitation", LLUVIA_AMARILLO, LLUVIA_NARANJA)
            avisos.append(_aviso(st, "lluvia", nivel, val, "mm", vt, acuerdo=acuerdo))

    # Lluvia persistente: pico de la suma móvil de 48 h (ventana propia,
    # independiente del pico de 24 h de arriba). Se emite ADEMÁS del aviso de
    # 24 h si ambos cruzan (productos distintos, sin dedupe) — ver docstring
    # de LLUVIA48_AMARILLO/NARANJA.
    rolling48 = _rolling_sum(precip, 48)
    if rolling48:
        vt48, val48 = max(rolling48, key=lambda p: p[1])
        nivel48 = _nivel(val48, LLUVIA48_AMARILLO, LLUVIA48_NARANJA, mayor_es_peor=True, rojo=lluvia48_rojo)
        if nivel48:
            acuerdo48 = _acuerdo_rolling(por_modelo, "precipitation",
                                          LLUVIA48_AMARILLO, LLUVIA48_NARANJA, n_horas=48)
            avisos.append(_aviso(st, "lluvia_persistente", nivel48, val48, "mm/48h", vt48,
                                  acuerdo=acuerdo48))

        # Isoterma 0° mediana durante la misma ventana de 24 h del pico de
        # lluvia. Null-safe: si freezing_level_height aún no tiene filas
        # (primera corrida antes del próximo --forecasts), no evalúa.
        iso_serie = series.get("freezing_level_height") or []
        if iso_serie:
            idx = next(i for i, (t, _) in enumerate(precip) if t == vt)
            ventana_times = [t for t, _ in precip[idx - 23:idx + 1]]
            iso_por_hora = dict(iso_serie)
            iso_vals = [iso_por_hora[t] for t in ventana_times if t in iso_por_hora]
            if iso_vals:
                iso_mediana = statistics.median(iso_vals)
                if val >= ALUVION_LLUVIA_NARANJA and iso_mediana >= ALUVION_ISOTERMA_NARANJA:
                    nivel_aluv = "naranja"
                elif val >= ALUVION_LLUVIA_AMARILLO and iso_mediana >= ALUVION_ISOTERMA_AMARILLO:
                    nivel_aluv = "amarillo"
                else:
                    nivel_aluv = None
                if nivel_aluv:
                    n_lluvia = _modelos_presentes(por_modelo, "precipitation", vt)
                    n_iso = _modelos_presentes(por_modelo, "freezing_level_height", vt)
                    if min(n_lluvia, n_iso) < MIN_MODELOS_COMPUESTO:
                        print(f"[aviso] aluvional: datos insuficientes descartado "
                              f"(estación {st['id']}: lluvia={n_lluvia} iso={n_iso}"
                              f" modelos, mínimo {MIN_MODELOS_COMPUESTO})")
                    else:
                        # Acuerdo del componente lluvia (el más variable entre
                        # modelos); la isoterma es más homogénea regionalmente y
                        # no se desglosa por modelo aquí.
                        acuerdo = _acuerdo_rolling(por_modelo, "precipitation",
                                                   ALUVION_LLUVIA_AMARILLO, ALUVION_LLUVIA_NARANJA)
                        aviso_aluv = _aviso(st, "aluvional", nivel_aluv, val, "mm", vt, acuerdo=acuerdo)
                        aviso_aluv["isoterma_m"] = round(iso_mediana / 100) * 100
                        avisos.append(aviso_aluv)

    nieve = series.get("snowfall") or []
    rolling_nieve = _rolling_sum(nieve, 24)
    if rolling_nieve:
        vt, val = max(rolling_nieve, key=lambda p: p[1])
        nivel = _nivel(val, NIEVE_AMARILLO, NIEVE_NARANJA, mayor_es_peor=True, rojo=NIEVE_ROJO)
        if nivel:
            acuerdo = _acuerdo_rolling(por_modelo, "snowfall", NIEVE_AMARILLO, NIEVE_NARANJA)
            avisos.append(_aviso(st, "nieve", nivel, val, "cm", vt, acuerdo=acuerdo))

    aviso_incendio = _aviso_incendio(series, por_modelo, st)
    if aviso_incendio:
        avisos.append(aviso_incendio)

    for f in (_aviso_rafagas, _aviso_presion, _aviso_nieve_baja,
              _aviso_ola_calor, _aviso_ola_frio, _aviso_tormenta, _aviso_uv):
        aviso = f(series, por_modelo, st)
        if aviso:
            avisos.append(aviso)

    return avisos


# Variable subyacente del campo "valor" de cada tipo de aviso (auditoría de
# avisos_emitidos, ver _valor_crudo). None = compuesto sin un único valor
# crudo bien definido.
_TIPO_VARIABLE = {
    "viento": "wind_speed_10m", "helada": "temperature_2m", "calor": "temperature_2m",
    "lluvia": "precipitation", "lluvia_persistente": "precipitation", "nieve": "snowfall",
    "rafagas": "wind_gusts_10m", "presion": "pressure_msl", "nieve_cota_baja": "precipitation",
    "ola_calor": "temperature_2m", "ola_frio": "temperature_2m", "tormenta": "cape",
    "uv": "uv_index", "aluvional": "precipitation",
    "incendio": None,  # compuesto de 3 variables calibrables, ver _valor_crudo
}


def _valor_crudo(tipo: str, valid_time: str, series_crudo: dict) -> float | None:
    """Valor SIN corrección de bias para el mismo (variable, valid_time) que
    produjo el "valor" ya corregido del aviso — auditoría de avisos_emitidos
    (regla: nunca cambiar la lógica de emisión, esto solo la observa).

    - Variables no calibrables (precipitation, snowfall, wind_gusts_10m, cape,
      uv_index): crudo == corregido por construcción, `series_crudo` ya trae
      el mismo valor (calibrate.correct nunca se les aplica).
    - "presion": el valor emitido es una CAÍDA entre el inicio y el fin de una
      ventana de 24 h, no un punto — se recalcula la caída con _rolling_caida
      sobre la serie cruda y se busca la ventana que termina en valid_time.
    - "incendio": la emisión la gatillan EN CONJUNTO tres variables calibrables
      (temperatura, humedad relativa, viento) en la misma hora, pero solo la
      temperatura queda expuesta como "valor" — un único valor_crudo no
      reflejaría si fue la corrección de HR o de viento la que disparó o
      suprimió el aviso, así que se guarda NULL (ver _TIPO_VARIABLE).
    - Resto (viento/helada/calor/rafagas/ola_calor/ola_frio/tormenta/uv): punto
      de la mediana cruda en el mismo valid_time del pico ya corregido.

    Redondeado a 1 decimal como "valor" (ver _aviso): sin este redondeo, con
    bias 0 igual aparecerían diferencias espurias entre la mediana cruda sin
    redondear y el "valor" ya redondeado, que no reflejan corrección real.
    """
    if tipo == "presion":
        caidas = dict(_rolling_caida(series_crudo.get("pressure_msl") or [], 24))
        val = caidas.get(valid_time)
    else:
        var = _TIPO_VARIABLE.get(tipo)
        if var is None:
            return None
        val = dict(series_crudo.get(var) or []).get(valid_time)
    return round(val, 1) if val is not None else None


def _guardar_avisos_emitidos(con, run_ts: str, avisos: list, series_crudo_por_estacion: dict) -> None:
    """Inserta en avisos_emitidos una fila por cada aviso de esta corrida, con
    su valor_crudo (ver _valor_crudo). Aditivo: nunca borra ni pisa histórico
    (solo INSERT); la retención de 365 días se aplica aparte en update()."""
    for a in avisos:
        valid_time = a["hora_peak"][:-4]  # hora_peak = valid_time + ":00Z"
        series_crudo = series_crudo_por_estacion[a["estacion_id"]]
        valor_crudo = _valor_crudo(a["tipo"], valid_time, series_crudo)
        con.execute(
            "INSERT INTO avisos_emitidos(run_ts, station_id, tipo, nivel, valor,"
            " valor_crudo, unidad, umbral, acuerdo, valid_time) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (run_ts, a["estacion_id"], a["tipo"], a["nivel"], a["valor"],
             valor_crudo, a["unidad"], a.get("umbral"), a.get("acuerdo"), valid_time),
        )


def _cargar_estado_avisos() -> dict:
    try:
        return json.loads(config.AVISOS_STATE_PATH.read_text())
    except Exception:
        return {}


def _guardar_estado_avisos(run_tag: str) -> None:
    config.AVISOS_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.AVISOS_STATE_PATH.write_text(json.dumps({"run_tag": run_tag}, ensure_ascii=False) + "\n")


def _purgar_vencidos(ahora: datetime) -> int | None:
    """Refiltrado barato del avisos.json ya publicado, SIN tocar `forecasts`:
    quita los avisos cuyo hora_peak ya pasó y refresca pronostico_horas/stale.
    Usada por el early-exit de update() cuando el run_tag de pronóstico no
    cambió — la ventana de vigencia (desde=ahora) sí avanza cada hora, así que
    un skip total dejaría avisos vencidos publicados hasta 12 h (hasta la
    próxima ingesta de pronóstico). No recalcula acumulados (dependen de toda
    la serie horaria, no solo de qué avisos siguen vigentes) ni descubre
    avisos nuevos que recién entren por el extremo lejano de la ventana; eso
    espera al próximo run_tag. Devuelve el conteo de avisos vigentes, o None
    si no hay avisos.json previo (fuerza el cálculo completo)."""
    try:
        payload = json.loads(config.AVISOS_PATH.read_text())
    except Exception:
        return None
    corte = ahora.strftime("%Y-%m-%dT%H:%M:%SZ")
    payload["avisos"] = [a for a in payload.get("avisos", []) if a["hora_peak"] >= corte]
    payload["updated"] = ahora.strftime("%Y-%m-%d %H:%M UTC")
    pronostico_run = payload.get("pronostico_run")
    if pronostico_run:
        pronostico_horas = round((ahora - datetime.fromisoformat(pronostico_run + ":00")
                                   .replace(tzinfo=timezone.utc)).total_seconds() / 3600)
        payload["pronostico_horas"] = pronostico_horas
        if pronostico_horas > STALE_HORAS:
            payload["stale"] = True
    config.AVISOS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    return len(payload["avisos"])


def update(con, fetched_at: str) -> int:
    ahora = datetime.now(timezone.utc)
    desde = ahora.strftime("%Y-%m-%dT%H:%M")
    hasta = (ahora + timedelta(hours=VENTANA_H)).strftime("%Y-%m-%dT%H:%M")

    # Early-exit: el pronóstico solo se ingesta 2x/día pero update() corre
    # 24x/día (cada corrida horaria); si el run_tag no cambió desde la última
    # corrida completa, evita las 152 consultas pesadas por estación (ver
    # _purgar_vencidos para por qué no es un skip total). Se usa la primera
    # estación como "canario" en vez de MAX(run_tag) global: todas las
    # estaciones reciben el mismo run_tag en el mismo lote de ingesta
    # (openmeteo_det/ens corren una sola vez por corrida de --forecasts para
    # las 152 estaciones), y filtrar por station=? sí tiene índice — sin
    # station, ningún índice cubre member como prefijo de run_tag y el
    # planner cae a un scan completo (medido: minutos sobre 140M filas).
    ultimo_run_tag = con.execute(
        "SELECT MAX(run_tag) FROM forecasts WHERE station=? AND member=-1",
        (config.STATIONS[0]["id"],)).fetchone()[0]
    if ultimo_run_tag and ultimo_run_tag == _cargar_estado_avisos().get("run_tag"):
        n = _purgar_vencidos(ahora)
        if n is not None:
            return n

    avisos = []
    acumulados = []
    run_tags_usados = []
    series_crudo_por_estacion = {}
    for st in config.STATIONS:
        run_tag = con.execute(
            "SELECT MAX(run_tag) FROM forecasts WHERE station=? AND member=-1",
            (st["id"],)).fetchone()[0]
        if not run_tag:
            continue
        run_tags_usados.append(run_tag)
        # Una sola consulta de series por estación: avisos y acumulados
        # comparten la misma mediana horaria multi-modelo.
        series, por_modelo, series_crudo = _series_estacion(con, st["id"], run_tag, desde, hasta)
        series_crudo_por_estacion[st["id"]] = series_crudo
        viento_umbral = _umbral_climatologico(con, st["id"], "wind_speed_10m",
                                               VIENTO_AMARILLO, VIENTO_NARANJA, VIENTO_ROJO)
        calor_umbral = _umbral_climatologico(con, st["id"], "temperature_2m",
                                              CALOR_AMARILLO, CALOR_NARANJA, CALOR_ROJO)
        avisos.extend(_avisos_estacion(series, por_modelo, st, viento_umbral, calor_umbral))
        acumulados.append(_acumulado_estacion(st, series))

    # Histórico de auditoría (regla: cambio aditivo, nunca toca el JSON
    # público ni la lógica de emisión de arriba). run_ts = fetched_at, el
    # mismo run_at que run.py usa para el "avisos" de ingest_log — permite
    # cruzar ambas tablas (ver comentario de avisos_emitidos en db.py).
    _guardar_avisos_emitidos(con, fetched_at, avisos, series_crudo_por_estacion)
    con.execute("DELETE FROM avisos_emitidos WHERE run_ts < datetime('now', '-365 days')")
    con.commit()

    payload = {
        "updated": ahora.strftime("%Y-%m-%d %H:%M UTC"),
        "fuente": "Derivado del pronóstico multi-modelo calibrado de Vigía"
                  " (mediana de 6 modelos con corrección de sesgo, 120 h)",
        "nota": "Aviso derivado de modelos, no es un aviso oficial de la DMC",
        "avisos": avisos,
        "acumulados": acumulados,
    }
    if run_tags_usados:
        pronostico_run = max(run_tags_usados)
        pronostico_horas = round((ahora - datetime.fromisoformat(pronostico_run + ":00")
                                   .replace(tzinfo=timezone.utc)).total_seconds() / 3600)
        payload["pronostico_run"] = pronostico_run
        payload["pronostico_horas"] = pronostico_horas
        if pronostico_horas > STALE_HORAS:
            payload["stale"] = True
    config.AVISOS_PATH.parent.mkdir(parents=True, exist_ok=True)
    config.AVISOS_PATH.write_text(json.dumps(payload, ensure_ascii=False) + "\n")
    if ultimo_run_tag:
        _guardar_estado_avisos(ultimo_run_tag)
    return len(avisos)
