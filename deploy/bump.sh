#!/bin/bash
# Bump triple de cache-busting (regla 2 de CLAUDE.md): sube en +1 el ?v=N de
# app.js/app.css en index.html, sw.js y emergencia.html, y el contador
# independiente vigia-shell-vN de sw.js. Sin argumentos: siempre +1.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

N="$(grep -oE 'app\.js\?v=[0-9]+' web/index.html | head -1 | grep -oE '[0-9]+$')"
SHELL_N="$(grep -oE 'vigia-shell-v[0-9]+' web/sw.js | head -1 | grep -oE '[0-9]+$')"
N_NUEVO=$((N + 1))
SHELL_NUEVO=$((SHELL_N + 1))

echo "==> v=$N -> v=$N_NUEVO, vigia-shell-v$SHELL_N -> vigia-shell-v$SHELL_NUEVO"
sed -i -E "s/app\.js\?v=[0-9]+/app.js?v=$N_NUEVO/g; s/app\.css\?v=[0-9]+/app.css?v=$N_NUEVO/g" \
  web/index.html web/emergencia.html web/sw.js
sed -i -E "s/vigia-shell-v[0-9]+/vigia-shell-v$SHELL_NUEVO/" web/sw.js

echo "==> Autovalidando (mismos chequeos que deploy/deploy.sh)..."
N_SW="$(grep -oE 'app\.js\?v=[0-9]+' web/sw.js | head -1 | grep -oE '[0-9]+$')"
if [ "$N_NUEVO" != "$N_SW" ]; then
  echo "ERROR: index.html quedó en v=$N_NUEVO pero sw.js en v=$N_SW" >&2
  exit 1
fi
for f in web/index.html web/sw.js web/emergencia.html; do
  N_CSS="$(grep -oE 'app\.css\?v=[0-9]+' "$f" | head -1 | grep -oE '[0-9]+$')"
  if [ "$N_CSS" != "$N_NUEVO" ]; then
    echo "ERROR: $f usa app.css?v=$N_CSS pero app.js?v=$N_NUEVO — quedaron desincronizados" >&2
    exit 1
  fi
done

echo "==> OK: app.js/app.css en v=$N_NUEVO, vigia-shell-v$SHELL_NUEVO"
