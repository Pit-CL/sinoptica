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
# El esqueleto común con los otros 3 crons (lock, gate horario, Slack,
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
#                 a Slack — solo loguea lo que haría (git fetch y gh pr list sí
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

# Canal #status-deploy, NO #vigia. La regla dura 10 del CLAUDE.md reserva #vigia
# para eventos de zona/emergencia y fallas reales: un "deploy OK" diario ahí
# sería exactamente el ruido informativo que esa regla prohíbe. #status-deploy
# es el canal del flujo de deploy del fleet (el mismo del digest de las 18:00).
# El ID no es secreto: va fijo para no depender de la API ni del .env.
SLACK_CHANNEL="${SLACK_CHANNEL_DEPLOY:-C0BPKD0FHJP}"

# Token del bot Heraldo, del .env de prod (mismo origen que usa push/send.py).
slack_token() {
  local v
  [ -f "$PROD/.env" ] || return 0
  v="$(grep -oP '(?<=^SLACK_BOT_TOKEN=).*' "$PROD/.env" 2>>"$DEPLOY_LOG" | head -1)"
  v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
  printf '%s' "$v"
}

slack_post() {
  deploy_slack_post "$SLACK_CHANNEL" "$1" "$(slack_token)"
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

# --- 3. Recordatorio Slack de PRs abiertos (independiente del deploy) ---
PR_LIST="$(deploy_pr_reminder)"
if [ -n "$PR_LIST" ]; then
  PR_COUNT="$(printf '%s\n' "$PR_LIST" | wc -l)"
  deploy_log "PRs abiertos sin mergear: $PR_COUNT"
  TEXT="$(printf '📬 Vigía: %s PR(s) abiertos sin mergear — no entran al deploy de hoy:\n%s' "$PR_COUNT" "$PR_LIST")"
  if [ "${DRY_RUN:-0}" = "1" ]; then
    deploy_log "[DRY_RUN] omitiendo el envío a Slack. Mensaje que se enviaría:"
    printf '%s\n' "$TEXT" >>"$DEPLOY_LOG"
  else
    slack_post "$TEXT" || deploy_log "ADVERTENCIA: el recordatorio de PRs no se pudo enviar"
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
    deploy_log "[DRY_RUN] omitiendo escritura del marker y aviso a Slack"
  else
    printf '%s\n' "$REMOTE_SHA" >"$MARKER"
    slack_post "🟡 Deploy automático de Vigía inicializado en main \`${REMOTE_SHA:0:7}\`. Lo anterior a este commit NO se auto-deploya: si hay cambios pendientes de subir, corre \`bash deploy/deploy.sh\` a mano." \
      && deploy_log "aviso de bootstrap enviado a Slack"
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
  deploy_log "[DRY_RUN] omitiendo escritura del marker ($REMOTE_SHA) y notificación a Slack"
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
  slack_post "$(printf '🟢 Deploy automático de Vigía OK — main `%s` en prod, smoke test verde.' "${REMOTE_SHA:0:7}")" \
    && deploy_log "notificación de éxito enviada a Slack"
else
  TAIL="$(tail -n 15 "$DEPLOY_LOG")"
  deploy_log "FALLO: el deploy salió con exit $DEPLOY_RC, el marker queda en $DEPLOY_LAST_SHA"
  slack_post "$(printf '🔴 Deploy automático de Vigía FALLÓ (main `%s`, exit %s). Prod queda en la versión anterior; el próximo tick reintenta.\nRevisar %s\nÚltimas líneas:\n```\n%s\n```' "${REMOTE_SHA:0:7}" "$DEPLOY_RC" "$DEPLOY_LOG" "$TAIL")" \
    && deploy_log "notificación de fallo enviada a Slack"
  deploy_log "=== fin ==="
  exit 1
fi

deploy_log "=== fin ==="
