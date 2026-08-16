#!/bin/bash
# Backup semanal del activo irrecuperable: clima.db + .env (+ watchdog_state.json
# si existe). Pensado para cron del HOST (no vive en ningún contenedor) —
# ver la línea añadida al crontab de usuario. Sin esto, si el VPS muere se
# pierde el histórico de observaciones/pronósticos (base de la calibración).
#
# Método de backup de la BD: python3 stdlib (Connection.backup(), la misma
# API C que envuelve el comando `.backup` del CLI sqlite3) corriendo en el
# HOST directo sobre /opt/vigia/data/clima.db. No hace falta `docker exec`:
# data/ es un bind mount (docker-compose.yml: "./data:/data"), así que el
# archivo que ve el host ES el mismo inodo que ve el contenedor ingesta —
# pasar por docker exec sería un hop extra sin beneficio. Este host no tiene
# el CLI `sqlite3`, pero sí python3 con el módulo `sqlite3` (stdlib), que
# basta. La BD vive en modo WAL (verificado) con la ingesta escribiendo cada
# pocos minutos: un `cp` a nivel de archivo puede capturar una escritura a
# medias y corromper el respaldo — la backup API sí es segura en caliente.
set -euo pipefail

VIGIA_DIR="${VIGIA_DIR:-/opt/vigia}"
BACKUP_DIR="${BACKUP_DIR:-/home/rafael/Backups/vigia}"
DB_PATH="${DB_PATH:-$VIGIA_DIR/data/clima.db}"
ENV_PATH="${ENV_PATH:-$VIGIA_DIR/.env}"
WATCHDOG_PATH="${WATCHDOG_PATH:-$VIGIA_DIR/data/watchdog_state.json}"
KEEP=8

FECHA="$(date +%Y%m%d)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Avisa por stdout y, si hay GCHAT_WEBHOOK_ALERTAS en el .env de prod, también
# por Google Chat al espacio `alertas` — un backup que falla tiene que
# interrumpir. Nunca imprime el webhook. Termina el script con exit 1.
# El envío a Slack se retiró el 2026-08-16 al cancelarse Slack Pro.
fail() {
    echo "ERROR: backup falló: $1"
    if [ -f "$ENV_PATH" ]; then
        set -a; . "$ENV_PATH"; set +a
        if [ -n "${GCHAT_WEBHOOK_ALERTAS:-}" ]; then
            curl -s -o /dev/null --max-time 15 -X POST \
                -H 'Content-Type: application/json; charset=UTF-8' \
                -d "{\"text\":\"[VIGIA] 🔴 backup semanal falló: $1\"}" \
                "$GCHAT_WEBHOOK_ALERTAS" || true
        fi
    fi
    exit 1
}

[ -f "$DB_PATH" ] || fail "no se encontró la base de datos en $DB_PATH"
[ -f "$ENV_PATH" ] || fail "no se encontró .env en $ENV_PATH"

echo "==> Respaldando $DB_PATH (hot backup vía sqlite3 stdlib)..."
python3 - "$DB_PATH" "$TMP_DIR/clima.db" <<'PYEOF' || fail "el backup de la BD falló (ver salida arriba)"
import sqlite3
import sys

src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(f"file:{src_path}?mode=ro", uri=True)
dst = sqlite3.connect(dst_path)
with dst:
    src.backup(dst)
dst.close()
src.close()
PYEOF

echo "==> Verificando integridad del respaldo..."
CHECK="$(python3 -c "
import sqlite3
con = sqlite3.connect('$TMP_DIR/clima.db')
print(con.execute('PRAGMA integrity_check').fetchone()[0])
")"
[ "$CHECK" = "ok" ] || fail "integrity_check de la BD respaldada dio: $CHECK"
echo "    integrity_check: ok"

cp "$ENV_PATH" "$TMP_DIR/.env"
ARCHIVOS="clima.db .env"
if [ -f "$WATCHDOG_PATH" ]; then
    cp "$WATCHDOG_PATH" "$TMP_DIR/watchdog_state.json"
    ARCHIVOS="$ARCHIVOS watchdog_state.json"
fi

mkdir -p "$BACKUP_DIR"
TAR_PATH="$BACKUP_DIR/vigia-$FECHA.tar.gz"
tar czf "$TAR_PATH" -C "$TMP_DIR" $ARCHIVOS || fail "no se pudo crear $TAR_PATH"
chmod 600 "$TAR_PATH"
echo "==> Backup creado: $TAR_PATH ($(du -h "$TAR_PATH" | cut -f1))"

# Copia offsite a Google Drive (best-effort): el backup local YA está OK en
# este punto, así que un fallo acá NUNCA debe tumbar el resto del script —
# backup_drive.py maneja su propio aviso a Google Chat y sale con éxito si no hay
# credenciales GDRIVE_* configuradas (patrón "dormido").
set -a; . "$ENV_PATH"; set +a
if [ -n "${GDRIVE_REFRESH_TOKEN:-}" ]; then
    echo "==> Subiendo copia offsite a Google Drive..."
    python3 "$(dirname "$0")/backup_drive.py" "$TAR_PATH" \
        || echo "AVISO: la copia offsite a Drive falló (ver arriba); el backup local sí quedó OK."
fi

echo "==> Rotando (conservar los últimos $KEEP)..."
ls -1t "$BACKUP_DIR"/vigia-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9].tar.gz 2>/dev/null \
    | tail -n +$((KEEP + 1)) \
    | while read -r viejo; do
        echo "    borrando $viejo"
        rm -f "$viejo"
    done

echo "==> Backup completo."
