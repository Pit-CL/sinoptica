#!/usr/bin/env bash
#
# deploy-cron.sh — deploy desatendido de Vigía.
#
# Flujo que implementa: el usuario mergea el PR a main a mano (ese merge ES el
# sign-off humano) y de madrugada este cron deploya lo que ya está en main.
#
# Pensado para un crontab horario ("20 * * * *"), pero solo actúa a las 03:00
# hora de Chile (gate horario DST-proof: esta máquina NO corre en TZ
# America/Santiago, así que se recalcula la hora Chile en cada corrida en vez
# de fijar el minuto de cron en horario UTC).
#
# Horario escalonado del fleet (evita que dos deploys pesados compitan por CPU
# y disco en la misma VM): clima 03:20 · ERP Rollitos 04:00 · rollitos.cl 04:40
# · ERP iktus 05:20.
#
# **Sin `claude -p` de por medio**, a diferencia de los otros tres crons del
# fleet: el deploy de Vigía ya es un script determinístico y auditado
# (`deploy/deploy.sh [ref]`, con sus propios chequeos de cache-busting `v=N` y
# su smoke test), así que meter una capa de LLM solo agregaría costo y una
# fuente de error. Este cron se limita a decidir CUÁNDO correrlo y a avisar
# cómo salió. Corolario: tampoco hace falta la rama de "allow-list de cron" del
# hook prod-guard.sh — no hay sesión de Claude que pueda tocar prod acá.
#
# El esqueleto común con los otros 3 crons (lock, gate horario, avisos,
# recordatorio de PRs, marker) vive en ~/dotfiles/bin/lib/deploy-cron-common.sh.
#
# **Sin chequeo de integridad de BD** (`~/dotfiles/bin/lib/db-integrity-check.sh`),
# a diferencia de erp-rollitos e iktus-erp: Vigía no tiene Postgres. Su estado
# vive en SQLite dentro del bind mount de prod (`/opt/vigia/data/clima.db`,
# `CLIMA_DB` del docker-compose), así que `db_snapshot`/`db_compare` —que hablan
# psql contra un contenedor— no tienen dónde conectarse, y `db_backup_fresh` no
# tiene rama para `clima`: caería en su `*)` fail-closed y bloquearía el deploy
# para siempre. Lo que protege los datos acá es otra cosa: `deploy/deploy.sh`
# excluye `data/` del rsync y el smoke test valida el resultado. Si algún día
# Vigía migra a Postgres, hay que agregarle su rama a `db_backup_fresh` ANTES de
# enchufarle el chequeo.
#
# Flags de test (NO usar en el crontab real):
#   FORCE_HOUR=1  salta el gate horario (actúa sin importar la hora local)
#   DRY_RUN=1     no ejecuta deploy/deploy.sh, no escribe el marker y no postea
#                 a Google Chat — solo loguea lo que haría (git fetch y gh pr list sí
#                 corren: son de solo lectura y sirven para ver el dry-run con
#                 datos reales)
#
set -u

# cron trae un PATH mínimo (típicamente /usr/bin:/bin) y gh vive en
# ~/.local/bin — sin esto los binarios no se encuentran bajo cron.
export PATH="/home/rafael/.local/bin:/usr/local/bin:/usr/bin:/bin"

REPO_DIR="/home/rafael/Documents/Recursos/Proyectos/clima"
PROD="/opt/vigia"
STATE_DIR="/home/rafael/.local/state"
MARKER="$STATE_DIR/vigia-last-deployed"
DEPLOY_LOG="$STATE_DIR/vigia-deploy-cron.log"
LOCK="$STATE_DIR/vigia-deploy.lock"

mkdir -p "$STATE_DIR"

# La ruta canónica es la del repo dotfiles. El override existe para poder correr
# el script desde un worktree antes de que el PR de la librería esté mergeado.
DEPLOY_CRON_LIB="${DEPLOY_CRON_LIB:-$HOME/dotfiles/bin/lib/deploy-cron-common.sh}"
# shellcheck source=/dev/null
if ! . "$DEPLOY_CRON_LIB"; then
  echo "[vigia-deploy-cron] no se pudo cargar la librería $DEPLOY_CRON_LIB" >&2
  exit 1
fi

# Google Chat, único canal desde el 2026-08-16: el envío a Slack se retiró al
# cancelarse Slack Pro, y con él `SLACK_CHANNEL`, `slack_token` y `slack_post`.
#
# El espacio lo elige cada caller por el resultado —deploy fallido a `alertas`,
# rutina (deploy OK, bootstrap, recordatorio de PRs) a `infra`—, que es la misma
# regla del spec de la migración. El criterio de fondo no cambió respecto de
# Slack: un "deploy OK" diario no debe interrumpir a nadie.
#
# `deploy_gchat_post` vive en la librería común de dotfiles. La guarda se
# mantiene aunque esa librería ya esté mergeada: las tres máquinas del fleet no
# actualizan dotfiles a la vez, y morir con "command not found" justo en el paso
# de avisar es la peor forma de fallar para un cron cuyo trabajo es avisar.
#   gchat_post <espacio> <texto>
gchat_post() {
  command -v deploy_gchat_post >/dev/null 2>&1 || { deploy_log "ADVERTENCIA: deploy_gchat_post no disponible (dotfiles desactualizados) — no se avisó por Google Chat"; return 1; }
  deploy_gchat_post "$1" "[VIGIA] $2"
}

# --- 1. Lock: evita corridas solapadas ---
deploy_lock "$LOCK" "vigia-deploy-cron"

# --- 2. Gate horario ---
deploy_hour_gate 03

deploy_log "=== inicio (hora Chile: $DEPLOY_HOUR_CHILE, gate: $DEPLOY_TARGET_HOUR, FORCE_HOUR=${FORCE_HOUR:-0}, DRY_RUN=${DRY_RUN:-0}) ==="

if ! cd "$REPO_DIR"; then
  deploy_log "ERROR: no se pudo entrar a $REPO_DIR"
  exit 1
fi

# --- 3. Recordatorio de PRs abiertos (independiente del deploy) ---
PR_LIST="$(deploy_pr_reminder)"
if [ -n "$PR_LIST" ]; then
  PR_COUNT="$(printf '%s\n' "$PR_LIST" | wc -l)"
  deploy_log "PRs abiertos sin mergear: $PR_COUNT"
  TEXT="$(printf '📬 Vigía: %s PR(s) abiertos sin mergear — no entran al deploy de hoy:\n%s' "$PR_COUNT" "$PR_LIST")"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    deploy_log "[DRY_RUN] omitiendo el envío a Google Chat. Mensaje que se enviaría:"
    printf '%s\n' "$TEXT" >>"$DEPLOY_LOG"
  else
    gchat_post infra "$TEXT" || deploy_log "ADVERTENCIA: el recordatorio de PRs no se pudo enviar"
  fi
else
  deploy_log "Sin PRs abiertos — sin recordatorio"
fi

# --- 4. ¿Avanzó origin/main? ---
if ! git fetch origin main --quiet 2>>"$DEPLOY_LOG"; then
  deploy_log "ERROR: git fetch origin main falló"
fi

REMOTE_SHA="$(git rev-parse origin/main 2>>"$DEPLOY_LOG")"
if [ -z "$REMOTE_SHA" ]; then
  deploy_log "ERROR: no se pudo resolver origin/main"
  deploy_log "=== fin ==="
  exit 1
fi

deploy_marker_check "$MARKER" "$REMOTE_SHA"
MARKER_RC=$?

# Bootstrap: sin marker no hay forma de saber qué está en prod. La primera
# corrida NO deploya a ciegas — inicializa el marker en el SHA actual y avisa
# una sola vez (mismo patrón que rollitos-redesign).
if [ "$MARKER_RC" -eq 2 ]; then
  deploy_log "sin marker: inicializando en $REMOTE_SHA sin deployar"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    deploy_log "[DRY_RUN] omitiendo escritura del marker y aviso a Google Chat"
  else
    printf '%s\n' "$REMOTE_SHA" >"$MARKER"
    BOOTSTRAP_TEXT="🟡 Deploy automático de Vigía inicializado en main \`${REMOTE_SHA:0:7}\`. Lo anterior a este commit NO se auto-deploya: si hay cambios pendientes de subir, corre \`bash deploy/deploy.sh\` a mano."
    gchat_post infra "$BOOTSTRAP_TEXT" \
      && deploy_log "aviso de bootstrap enviado a Google Chat"
  fi
  deploy_log "=== fin ==="
  exit 0
fi

if [ "$MARKER_RC" -eq 1 ]; then
  deploy_log "sin commits nuevos (origin/main=$REMOTE_SHA)"
  deploy_log "=== fin ==="
  exit 0
fi

deploy_log "commits nuevos detectados: $DEPLOY_LAST_SHA -> $REMOTE_SHA"

# --- 5. Deploy ---
# deploy/deploy.sh es idempotente y seguro de re-correr: exporta origin/main a
# un directorio temporal, valida el cache-busting, rsyncea a /opt/vigia
# (preservando data/, .env y los JSON generados), recrea los contenedores y
# corre el smoke test. Si algo falla, sale !=0 y NO se avanza el marker.
if [ "${DRY_RUN:-0}" = "1" ]; then
  deploy_log "[DRY_RUN] omitiendo: bash $REPO_DIR/deploy/deploy.sh origin/main"
  deploy_log "[DRY_RUN] omitiendo escritura del marker ($REMOTE_SHA) y notificación a Google Chat"
  deploy_log "=== fin ==="
  exit 0
fi

bash "$REPO_DIR/deploy/deploy.sh" origin/main >>"$DEPLOY_LOG" 2>&1
DEPLOY_RC=$?
deploy_log "deploy/deploy.sh terminó con exit $DEPLOY_RC"

# --- 6. Veredicto y marker ---
# A diferencia de los crons con `claude -p`, acá el marker lo escribe ESTE
# script: no hay skill que lo haga como último paso. Se escribe solo con exit 0
# del deploy (que incluye el smoke test), así que un fallo a mitad de camino
# deja el marker atrás y el próximo tick reintenta.
if [ "$DEPLOY_RC" -eq 0 ]; then
  printf '%s\n' "$REMOTE_SHA" >"$MARKER"
  deploy_log "deploy OK, marker en $REMOTE_SHA"
  OK_TEXT="$(printf '🟢 Deploy automático de Vigía OK — main `%s` en prod, smoke test verde.' "${REMOTE_SHA:0:7}")"
  gchat_post infra "$OK_TEXT" \
    && deploy_log "notificación de éxito enviada a Google Chat"
else
  TAIL="$(tail -n 15 "$DEPLOY_LOG")"
  deploy_log "FALLO: el deploy salió con exit $DEPLOY_RC, el marker queda en $DEPLOY_LAST_SHA"
  FAIL_TEXT="$(printf '🔴 Deploy automático de Vigía FALLÓ (main `%s`, exit %s). Prod queda en la versión anterior; el próximo tick reintenta.\nRevisar %s\nÚltimas líneas:\n```\n%s\n```' "${REMOTE_SHA:0:7}" "$DEPLOY_RC" "$DEPLOY_LOG" "$TAIL")"
  gchat_post alertas "$FAIL_TEXT" \
    && deploy_log "notificación de fallo enviada a Google Chat"
  deploy_log "=== fin ==="
  exit 1
fi

deploy_log "=== fin ==="
