#!/bin/bash
# Deploy versionado de Vigía a producción (local, /opt/vigia en este mismo VPS),
# con smoke test al final. Reemplaza el rsync manual documentado en docs/DEPLOY.md.
#
# Uso: bash deploy/deploy.sh [ref]   (ref por defecto: origin/main)
#
# Lo invoca a mano el usuario o, de madrugada, scripts/deploy-cron.sh (gate
# 03:20 Chile) cuando origin/main avanzó desde el último deploy.
set -e

REF="${1:-origin/main}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESTINO="/opt/vigia/"

EXPORT_DIR="$(mktemp -d)"
trap 'rm -rf "$EXPORT_DIR"' EXIT

# Sin esto, un merge hecho en GitHub (no localmente) deja el origin/main local
# desactualizado y el archive de abajo exporta el commit viejo en silencio
# (pasó el 2026-07-16: dos deploys seguidos "verificados OK" que en realidad
# no llevaban el último merge).
echo "==> Actualizando origin/main..."
git -C "$REPO_ROOT" fetch origin main --quiet

echo "==> Exportando $REF..."
git -C "$REPO_ROOT" archive "$REF" | tar -x -C "$EXPORT_DIR"

echo "==> Verificando el export..."
for f in docker-compose.yml deploy/nginx.conf web/app.js; do
  if [ ! -f "$EXPORT_DIR/$f" ]; then
    echo "ERROR: falta $f en el export de $REF" >&2
    exit 1
  fi
done

N_INDEX="$(grep -oE 'app\.js\?v=[0-9]+' "$EXPORT_DIR/web/index.html" | head -1 | grep -oE '[0-9]+$')"
if [ -z "$N_INDEX" ]; then
  echo "ERROR: no se encontró app.js?v=N en web/index.html" >&2
  exit 1
fi
N_SW="$(grep -oE 'app\.js\?v=[0-9]+' "$EXPORT_DIR/web/sw.js" | head -1 | grep -oE '[0-9]+$')"
if [ "$N_INDEX" != "$N_SW" ]; then
  echo "ERROR: index.html usa v=$N_INDEX pero el array SHELL de sw.js usa v=$N_SW — cache-busting desincronizado" >&2
  exit 1
fi
echo "    versión v=$N_INDEX consistente entre index.html y sw.js"

# app.css debe compartir la versión de app.js en AMBOS archivos: el smoke
# post-deploy lo exige, y fallar aquí evita desplegar algo que el smoke
# rechazará (ya pasó dos veces: PRs que subían solo app.js). emergencia.html
# también carga app.css directo (sin app.js) y sufrió el mismo drift una vez.
for f in web/index.html web/sw.js web/emergencia.html; do
  N_CSS="$(grep -oE 'app\.css\?v=[0-9]+' "$EXPORT_DIR/$f" | head -1 | grep -oE '[0-9]+$')"
  if [ "$N_CSS" != "$N_INDEX" ]; then
    echo "ERROR: $f usa app.css?v=$N_CSS pero app.js?v=$N_INDEX — sincroniza ambos antes de desplegar" >&2
    exit 1
  fi
done
echo "    app.css?v=$N_INDEX sincronizado con app.js en index.html, sw.js y emergencia.html"

echo "==> Copiando a $DESTINO (local)..."
rsync -a --delete \
  --exclude data/ --exclude .git/ --exclude .env --exclude .claude/ \
  --exclude 'web/status.json' --exclude 'web/verificacion.json' --exclude 'web/estaciones.json' \
  --exclude 'web/aire.json' --exclude 'web/bias.json' --exclude 'web/avisos.json' \
  --exclude 'web/sismos.json' --exclude 'web/incendios.json' --exclude 'web/alertas.json' \
  --exclude 'web/volcanes.json' --exclude 'web/emergencia.json' --exclude 'web/remociones.json' \
  --exclude 'web/tsunami_vias.json' --exclude 'web/tsunami_areas.json' \
  --exclude 'web/marea.json' --exclude 'web/tsunami.json' \
  "$EXPORT_DIR/" "$DESTINO"

echo "==> Reiniciando contenedores..."
# restart explícito de TODOS los servicios: `up -d` no recrea contenedores cuyo
# config/imagen no cambió (el código va por bind-mount), e ingesta/push cargan
# su crontab a /etc/crontabs/root solo en el arranque — sin restart, un crontab
# nuevo queda en disco pero no rige (pasó con #111).
(cd "$DESTINO" && docker compose up -d && docker compose restart)

echo "==> Esperando 3 s antes del smoke test..."
sleep 3

echo "==> Corriendo smoke test (stdlib)..."
if ! python3 "$REPO_ROOT/deploy/smoke.py"; then
  echo "DEPLOY CON FALLAS EN SMOKE TEST" >&2
  exit 1
fi

PLAYWRIGHT_PY="$HOME/.venvs/playwright/bin/python"
if [ -x "$PLAYWRIGHT_PY" ]; then
  echo "==> Corriendo smoke test de navegador (Playwright)..."
  if ! "$PLAYWRIGHT_PY" "$REPO_ROOT/deploy/smoke_browser.py"; then
    echo "DEPLOY CON FALLAS EN SMOKE TEST" >&2
    exit 1
  fi
else
  echo "    Playwright no disponible en $PLAYWRIGHT_PY — se omite el smoke test de navegador"
fi

echo "==> Deploy completo y verificado."
