#!/usr/bin/env bash
# prod-guard.sh — hook PreToolUse(Bash) del repo (.claude/settings.json).
#
# Producción de Vigía corre EN ESTA MISMA MÁQUINA: la copia de prod es
# /opt/vigia (con su .env y su data/, que NO están en el repo) y sus
# contenedores son `clima-web`, `clima-ingesta` y `clima-push`. Dev y prod
# conviven en el mismo host y no hay ssh de por medio, así que nada avisa
# "esto es prod" salvo este hook.
#
# Este archivo es SOLO la configuración y la política de este repo. El
# clasificador vive en el núcleo compartido ~/.claude/lib/prod-guard-core.sh
# (repo dotfiles, claude/lib/), el mismo que usan erp-rollitos, iktus-erp y
# rollitos-redesign — así los arreglos del clasificador llegan acá sin copiar
# nada a mano (era una copia divergente: cada repo arreglaba sus propios bugs).
#
# SIN allow-list de deploy, a propósito: el deploy desatendido
# (scripts/deploy-cron.sh) invoca `deploy/deploy.sh` DIRECTO, sin `claude -p` de
# por medio, así que en el cron no hay sesión de Claude ni hook que atravesar.
# La rama de modo cron del núcleo queda inerte (la variable no la exporta
# nadie) y, si algún día alguien la exportara, el efecto sería denegar todo lo
# que no sea lectura — el lado seguro. Si el deploy de Vigía llegara a pasar por
# un LLM, hay que ESCRIBIR esa allow-list; no basta con apagar la guarda.
#
# En sesión interactiva rige la deny-list del núcleo: se pregunta solo por lo
# que muta prod (rutas de /opt/vigia, los contenedores, la BD) y por el deploy
# mismo. Los diagnósticos —logs, `docker ps`, leer el status.json, contar filas
# en clima.db— pasan sin molestar.
set -uo pipefail

# ---------------------------------------------------------------------------
# Configuración de este proyecto
# ---------------------------------------------------------------------------
PG_PROYECTO='Vigía'
PG_PROD_DESC='/opt/vigia, los contenedores clima-web/clima-ingesta/clima-push o vigia.cavara.cl'

# Alcance: ¿el comando toca producción? Substring plano (cubre ~/, rutas
# relativas, comillas). El checkout de desarrollo
# (~/Documents/Recursos/Proyectos/clima) NO contiene ninguno de estos literales,
# así que trabajar en el repo no dispara falsos positivos. `deploy/deploy.sh` sí
# entra: es el camino normal a prod, y correrlo a mano en pleno día es
# exactamente lo que la guarda tiene que confirmar.
PG_PROD_RE='/opt/vigia|clima-web|clima-ingesta|clima-push|deploy/deploy\.sh|vigia\.cavara\.cl|clima\.cavara\.cl'

# Escribir ACÁ cambia el código, la config o los datos vivos de producción.
PG_PROD_ESCRITURA_RE='/opt/vigia'
# Borrar o cambiar permisos ACÁ toca producción (incluye data/, que guarda la
# serie histórica de clima.db, y los backups que deja deploy/backup.sh).
PG_PROD_RUTAS_RE='/opt/vigia'
PG_PROD_HOST_RE='vigia\.cavara\.cl|clima\.cavara\.cl'
PG_PROD_PROC_RE='clima-web|clima-ingesta|clima-push'

# Variable de modo cron: NO la exporta nadie (ver cabecera). Se declara porque
# el núcleo la exige, y su rama queda inerte.
PG_CRON_VAR='VIGIA_DEPLOY_CRON'
PG_CRON_LOG="${VIGIA_DEPLOY_CRON_LOG:-$HOME/.local/state/vigia-deploy-cron.log}"

# ---------------------------------------------------------------------------
# Política de modo cron: no hay ninguna, y eso es fail-closed
# ---------------------------------------------------------------------------
# El núcleo exige las dos funciones. Acá no autorizan nada: si la variable
# llegara a estar seteada, todo lo que no sea lectura pura se DENIEGA con su
# motivo. Es el lado correcto del error — un deploy bloqueado se ve y se
# arregla; uno permitido a ciegas, no.
cron_forbidden() {
  return 1
}

seg_cron_write() {
  return 1
}

# ---------------------------------------------------------------------------
# Patrones mutantes propios — sesión interactiva
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Críticos propios de Vigía (gancho (0) de muta_prod_critico del núcleo).
# Solo corre en la rama INTERACTIVA: el modo cron termina en cron_gate. Además
# el deploy de este repo es `deploy/deploy.sh` corriendo directo desde el cron,
# sin agente de por medio, así que nada de acá puede detener un deploy.
# ---------------------------------------------------------------------------
muta_prod_critico_proyecto() {
  local c="$1"

  # (1) SQL de escritura contra la BD de producción. El detector del núcleo mira
  #     `psql`, y acá la BD es SQLite dentro del contenedor: llega como
  #     `docker exec … sqlite3 /data/clima.db "DELETE FROM obs"`, como
  #     `docker compose exec … sh -c 'sqlite3 …'` o embebido en un
  #     `python3 -c "sqlite3.connect(…).execute(…)"`. Verificado el 2026-08-14:
  #     `DROP TABLE ingest_log`, `DELETE FROM obs` y `update obs set valor = 0`
  #     pasaban sin preguntar en las tres formas.
  #
  #     `deploy/deploy.sh` no toca la BD en ningún paso (solo rsync + recreación
  #     de contenedores), así que la regla no puede frenar un paso del deploy.
  if printf '%s' "$c" | grep -qE '(clima\.db|sqlite3?[[:space:]._(]|sqlite3\.connect)'; then
    printf '%s' "$c" \
      | grep -qiE "(^|[^[:alnum:]_])(drop|delete|update|insert|alter|truncate|replace|vacuum)([[:space:]]|$)" \
      && { printf 'RIESGO CRITICO — SQL de escritura contra la BD de produccion de Vigia (/data/clima.db): la serie historica de observaciones no se puede reconstruir, y el respaldo es semanal (domingo 04:30)'; return 0; }
  fi

  # (2) `rsync --delete` hacia /opt/vigia SIN excluir `data/`. El paso real del
  #     deploy (deploy/deploy.sh:63) excluye `data/`, `.env` y los JSON de
  #     estado justamente porque `--delete` borra en el destino todo lo que no
  #     esté en el origen: sin ese exclude, el mismo comando se lleva la BD de
  #     producción. Verificado el 2026-08-14: `rsync -a --delete ./ /opt/vigia/`
  #     pasaba sin preguntar.
  if printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])rsync([[:space:]]|$)' \
     && printf '%s' "$c" | grep -qE '(^|[[:space:]])--delete([-=][[:alnum:]-]*)?([[:space:]]|$)' \
     && printf '%s' "$c" | grep -qE "($PG_PROD_ESCRITURA_RE)"; then
    printf '%s' "$c" | grep -qE '(^|[[:space:]])--exclude([[:space:]]+|=)[^[:space:]]*data' \
      || { printf 'RIESGO CRITICO — rsync --delete hacia /opt/vigia sin excluir data/: borra en el destino todo lo que no este en el origen, o sea la BD de produccion. El paso del deploy (deploy/deploy.sh:63) la excluye'; return 0; }
  fi

  return 1
}

# El núcleo ya cubre lo genérico por DESTINO (rm/mv/cp/chmod y redirecciones
# contra /opt/vigia, SQL mutante, docker que crea/para/recrea contenedores,
# systemctl sobre los servicios de prod, curl de escritura contra el host).
# Acá va lo propio de Vigía.
muta_prod_proyecto() {
  # Normalización propia, a partir del $CMD crudo: el rsync documentado en
  # docs/DEPLOY.md viene partido en varias líneas con `\`, y el núcleo convierte
  # TODO salto de línea en `;` — así el origen y el destino quedan en segmentos
  # distintos y ningún patrón los ve juntos. Acá se pegan primero las
  # continuaciones y recién después se separan las líneas de verdad.
  local nl=$'\n' c
  c="${CMD//\\$nl/ }"
  c="$(printf '%s' "$c" | tr -d '\042\047\134' | tr '\t\n' ' ;')"

  # El deploy completo: exporta el ref, sincroniza /opt/vigia, recrea los
  # contenedores y corre el smoke test. Es UN comando y UNA confirmación.
  printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])(bash[[:space:]]+)?[^[:space:];|&]*deploy/deploy\.sh([[:space:]]|$|;)' \
    && { printf 'es el deploy completo a produccion: reemplaza /opt/vigia con el ref indicado y recrea los contenedores'; return 0; }

  # rsync/scp hacia la copia de prod (el sync manual de docs/DEPLOY.md).
  printf '%s' "$c" | grep -qE "(^|[^[:alnum:]_-])(rsync|scp)[[:space:]][^;|&]*($PG_PROD_ESCRITURA_RE)" \
    && { printf 'rsync/scp que REEMPLAZA archivos de produccion con los del working tree actual, tal cual este ahora'; return 0; }

  # git que cambia estado dentro de la copia de prod. Se exigen las dos cosas en
  # el mismo comando —el verbo y la ruta— pero no en el mismo segmento: la forma
  # habitual es `cd /opt/vigia && git pull`, con la ruta en el `cd`. Un
  # `git pull` en el checkout de desarrollo no nombra /opt/vigia y no pregunta.
  if printf '%s' "$c" | grep -qE "$PG_PROD_ESCRITURA_RE"; then
    printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])git[[:space:]]+([^;|&]*[[:space:]])?(pull|reset|checkout|switch|clean|stash|rebase)([[:space:]]|$|;)' \
      && { printf 'git que reemplaza el contenido de la copia de produccion'; return 0; }
  fi

  # SQL que escribe, con el criterio de frontera ampliado: el patrón compartido
  # del núcleo exige un espacio antes del verbo, y acá el SQL viaja dentro de
  # una llamada de Python (`sqlite3.connect(...).execute('DROP TABLE …')`), o
  # sea pegado a un paréntesis.
  printf '%s' "$c" | grep -qiE '[^[:alnum:]_-](drop[[:space:]]+(table|index|view)|delete[[:space:]]+from|truncate([[:space:]]+table)?|insert[[:space:]]+into|update[[:space:]]+[a-z_]+[[:space:]]+set|alter[[:space:]]+table)' \
    && { printf 'SQL que escribe datos o cambia el esquema de clima.db en produccion'; return 0; }

  # Edición in situ de un archivo de producción: escribe sin usar la
  # redirección del shell, así que no cae en las reglas de destino del núcleo.
  printf '%s' "$c" | grep -qE "(^|[^[:alnum:]_-])(sed|perl)[[:space:]]+[^;|&]*(-[[:alnum:]]*i|--in-place)[^;|&]*($PG_PROD_ESCRITURA_RE)" \
    && { printf 'edita en el lugar (-i) un archivo del codigo o la config de produccion'; return 0; }

  # Exfiltración: subir un archivo de producción (el .env trae las credenciales
  # de las fuentes y el token de Slack) a un host cualquiera.
  printf '%s' "$c" | grep -qE "(^|[^[:alnum:]_-])(curl|wget)[^;|&]*(-T|--upload-file|--post-file|-F|--form|--data-binary)[^;|&]*($PG_PROD_RUTAS_RE)" \
    && { printf 'sube un archivo de produccion (secretos incluidos) a un host externo'; return 0; }

  return 1
}

# ---------------------------------------------------------------------------
# Núcleo compartido
# ---------------------------------------------------------------------------
# Ruta absoluta a propósito: con una ruta relativa el hook muere apenas el cwd
# no es la raíz del repo (worktrees, subdirectorios). Si el núcleo no está
# instalado (dotfiles → install.sh), NO se sale con exit 0: eso haría
# desaparecer la guarda en silencio, que es el peor modo de falla posible (los
# hooks fallan non-blocking). Se pide confirmación con el motivo explícito.
PG_NUCLEO="$HOME/.claude/lib/prod-guard-core.sh"
if [ ! -r "$PG_NUCLEO" ]; then
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"prod-guard: nucleo del prod-guard no encontrado en %s. Sin el no puedo clasificar el comando contra produccion de Vigia, asi que no lo dejo pasar en silencio. Instalalo con ./install.sh del repo dotfiles (claude/lib/prod-guard-core.sh). Confirma solo si sabes lo que el comando hace."}}\n' "$PG_NUCLEO"
  exit 0
fi
# shellcheck source=/dev/null
. "$PG_NUCLEO"
