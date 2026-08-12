#!/usr/bin/env bash
# prod-guard.sh — hook PreToolUse(Bash) del repo (.claude/settings.json).
#
# Producción de Vigía corre EN ESTA MISMA MÁQUINA: la copia de prod es
# /opt/vigia (con su .env y su data/, que NO están en el repo) y sus
# contenedores son `clima-web`, `clima-ingesta` y `clima-push`. Dev y prod
# conviven en el mismo host y no hay ssh de por medio, así que nada avisa
# "esto es prod" salvo este hook.
#
# Qué hace: en sesión interactiva, cualquier comando que toque prod y no sea
# inequívocamente de SOLO LECTURA pide confirmación (`ask`). El deploy
# desatendido (scripts/deploy-cron.sh) invoca `deploy/deploy.sh` DIRECTO, sin
# `claude -p` de por medio: no hay sesión de Claude en el cron, así que no hay
# hook que sortear y este guard no necesita la rama de "allow-list de cron" que
# sí tienen erp-rollitos, iktus-erp y rollitos-redesign. Si algún día el deploy
# de Vigía pasara por un LLM, esa rama hay que agregarla — no basta con
# apagar la guarda.
#
# Adaptado del patrón ya probado de rollitos-redesign/scripts/hooks/prod-guard.sh
# (allow-list fail-closed de solo lectura, endurecido por security review
# 2026-07-04/2026-08-11).
#
# Fail-closed: si jq falta o no parsea, se analiza el stdin crudo en vez de
# permitir en silencio; la emisión del JSON usa printf, no jq.
set -uo pipefail

IN=$(cat)
if CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null); then
  [ -z "$CMD" ] && exit 0
else
  CMD="$IN"
fi

# ---------------------------------------------------------------------------
# Alcance: ¿el comando toca producción de este proyecto?
# ---------------------------------------------------------------------------
# Se detecta por substring plano (cubre ~/, rutas relativas, comillas). El
# checkout de desarrollo (~/Documents/Recursos/Proyectos/clima) NO contiene
# ninguno de estos literales, así que trabajar en el repo no dispara falsos
# positivos. `deploy/deploy.sh` sí entra: es el camino normal a prod, y correrlo
# a mano en pleno día es exactamente lo que la guarda tiene que confirmar.
PROD_RE='/opt/vigia|clima-web|clima-ingesta|clima-push|deploy/deploy\.sh'
# El alcance ya NO termina el hook: los destructivos globales de más abajo se
# evalúan igual aunque el comando no nombre prod (ahí estaba el hueco).
TOCA_PROD=1
printf '%s' "$CMD" | grep -qE "$PROD_RE" || TOCA_PROD=0

ask() {
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"%s"}}\n' "$1"
  exit 0
}

# ---------------------------------------------------------------------------
# Destructivos globales: se evalúan aunque el comando NO nombre producción
# ---------------------------------------------------------------------------
# Todo el resto de este guard solo mira comandos que mencionan prod de este
# proyecto (PROD_RE). Eso dejaba un hueco verificado: un `rm -rf /` suelto no
# nombra nada de prod, así que el hook salía sin decisión y con exit 0 — es
# decir, pasaba.
#
# Esta lista es lo contrario de la allow-list del resto del archivo: enumera
# patrones inequívocamente destructivos a nivel de MÁQUINA, donde un falso
# positivo cuesta una confirmación y un falso negativo cuesta el servidor. Por
# eso cada patrón exige que el blanco sea la raíz, el home completo, un
# directorio de sistema entero o un dispositivo de bloque: un
# `rm -rf /opt/vigia/data` NO cae acá, lo sigue clasificando el flujo normal.
#
# Este repo no tiene rama de modo cron (su deploy no pasa por `claude -p`), así
# que el veredicto es siempre `ask`. En una sesión headless un `ask` se resuelve
# como denegación, así que igual queda bloqueado.
#
# Las comillas se quitan antes de comparar (`tr -d '\042\047'`, o sea " y '),
# para que `rm -rf "/"` no esquive el patrón por una comilla.
#
# Devuelve 0 e imprime el motivo si el comando es un destructivo global.
destructivo_global() {
  local c
  c="$(printf '%s' "$1" | tr -d '\042\047')"

  # rm sobre la raíz, el home completo o un directorio de sistema entero.
  printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])rm[[:space:]]+(-[^[:space:]]+[[:space:]]+)*(/|~|\$HOME|/home/[A-Za-z0-9._-]+|/(etc|usr|var|bin|sbin|lib|lib64|boot|root|home|opt|srv|dev|proc|sys))/?\*?[[:space:]]*($|[;&|])' \
    && { printf 'rm sobre la raiz, el home completo o un directorio de sistema entero'; return 0; }

  # Formatear un filesystem: no tiene vuelta atrás.
  printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])mkfs(\.[a-z0-9]+)?([[:space:]]|$)' \
    && { printf 'mkfs: formatea un filesystem completo'; return 0; }

  # Escritura directa a un dispositivo. /dev/null y compañía son inofensivos y
  # quedan explícitamente fuera (`dd of=/dev/null` es un no-op legítimo).
  if printf '%s' "$c" | grep -qE 'of=/dev/'; then
    printf '%s' "$c" | grep -qE 'of=/dev/(null|zero|stdout|stderr|tty|full|random|urandom)([[:space:]]|$)' \
      || { printf 'dd escribiendo directo a un dispositivo'; return 0; }
  fi
  printf '%s' "$c" | grep -qE '(>[[:space:]]*|(^|[^[:alnum:]_-])tee[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)/dev/(sd[a-z]|nvme[0-9]|vd[a-z]|hd[a-z]|mmcblk[0-9]|loop[0-9]|md[0-9]|dm-[0-9]|disk[0-9]|mapper/)' \
    && { printf 'escritura directa a un dispositivo de bloque'; return 0; }

  # Podas de docker: barren recursos de TODOS los stacks de la VM, no solo de
  # este proyecto (en esta máquina conviven Vigía, los dos ERP y el chatbot).
  printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])docker[[:space:]]+(system|volume|builder|image|network|container)[[:space:]]+prune([[:space:]]|$)' \
    && { printf 'docker prune: barre recursos de todos los stacks de la maquina'; return 0; }
  printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])docker[[:space:]]+volume[[:space:]]+rm([[:space:]]|$)' \
    && { printf 'docker volume rm: borra el volumen de datos de un stack'; return 0; }

  # chmod/chown recursivo cuyo blanco es la raíz: deja la máquina inarrancable.
  # Se exige el flag recursivo Y que el último argumento sea `/` — un
  # `chown -R rafael /opt/vigia` no cae acá.
  if printf '%s' "$c" | grep -qE '(^|[^[:alnum:]_-])(chmod|chown)[[:space:]]'; then
    printf '%s' "$c" | grep -qE '(^|[[:space:]])(-[[:alnum:]]*R[[:alnum:]]*|--recursive)([[:space:]]|$)' \
      && printf '%s' "$c" | grep -qE '[[:space:]]/(\*)?[[:space:]]*($|[;&|])' \
      && { printf 'chmod/chown recursivo sobre la raiz del sistema'; return 0; }
  fi

  # Fork bomb: una función que se llama a sí misma en pipe y en background.
  printf '%s' "$c" | grep -qE '[A-Za-z_:][A-Za-z0-9_:]*\(\)[[:space:]]*\{[^}]*\|[^}]*&' \
    && { printf 'fork bomb'; return 0; }

  # Apagar o reiniciar la VM: se lleva por delante TODOS los servicios. Se ancla
  # a posición de comando (inicio o tras `;`/`|`/`&`) para no dispararse con un
  # `grep -i reboot /var/log/syslog`.
  printf '%s' "$c" | grep -qE '(^|[;&|])[[:space:]]*(sudo[[:space:]]+(-[^[:space:]]+[[:space:]]+)*)?(systemctl[[:space:]]+)?(/sbin/|/usr/sbin/)?(shutdown|reboot|poweroff|halt)([[:space:]]|$)' \
    && { printf 'apagado o reinicio de la maquina completa'; return 0; }
  printf '%s' "$c" | grep -qE '(^|[;&|])[[:space:]]*(sudo[[:space:]]+)?init[[:space:]]+[06]([[:space:]]|$)' \
    && { printf 'init 0/6: apagado o reinicio de la maquina completa'; return 0; }

  return 1
}

# Quita el prefijo `sudo` (y sus flags) de un segmento: clasificar
# `sudo docker ps` como verbo desconocido convertiría la guarda en ruido.
strip_sudo() {
  local seg="$1"
  while :; do
    case "$seg" in
      sudo\ *) seg="${seg#sudo }" ;;
      *) break ;;
    esac
    # Flags de sudo con y sin argumento.
    while :; do
      case "$seg" in
        -n\ *|-E\ *|-H\ *|-S\ *|-b\ *) seg="${seg#* }" ;;
        -u\ *|-g\ *) seg="${seg#* }"; seg="${seg#* }" ;;
        *) break ;;
      esac
    done
  done
  printf '%s' "$seg"
}

# Primera sustitución `$(...)` del texto, con paréntesis BALANCEADOS (recursión
# PCRE de GNU grep). Un patrón plano `\$\([^()]*\)` no matchea las que llevan
# paréntesis adentro — `$(sudo -n grep -oP '(?<=^SLACK_BOT_TOKEN=).*' .env)` o
# un `sed -E 's/(a)/\1/'` — y esas quedarían como "sustitución no resuelta",
# denegando pasos legítimos del deploy.
primera_subst() {
  printf '%s' "$1" | grep -oP '\$(\((?:[^()]++|(?1))*\))' 2>/dev/null | head -1
}

# Clasificador de UN segmento: 0 = solo lectura, 1 = desconocido o escribe.
# Allowlist fail-closed: verbo desconocido o flag de escritura → 1.
seg_read_only() {
  local seg="$1" first
  seg="${seg#"${seg%%[![:space:]]*}"}"
  [ -z "$seg" ] && return 0

  # Palabras de control: no ejecutan nada por sí solas. La cabecera `for X in
  # …` tampoco (sus sustituciones ya se validaron antes). `while`/`until`/`if`
  # NO se descuelgan enteros: se les quita el prefijo y se clasifica lo que
  # ejecutan de verdad, para que un `while rm -rf / ; do` no se cuele.
  case "$seg" in
    do|done|then|else|elif|fi|esac|true|:) return 0 ;;
    for\ *\ in\ *) return 0 ;;
  esac
  seg="${seg#do }"; seg="${seg#then }"; seg="${seg#else }"
  seg="${seg#if }"; seg="${seg#elif }"; seg="${seg#while }"; seg="${seg#until }"

  first="${seg%% *}"

  # Prefijos de asignación (`TS=...`, `BASE=SUBST`): por sí solos no ejecutan
  # nada, así que se descuelgan para clasificar lo que venga detrás.
  # `X=1 rm -rf /` NO se cuela: tras quitar el prefijo queda `rm`, desconocido.
  while :; do
    case "$first" in
      [A-Za-z_]*=*) ;;
      *) break ;;
    esac
    case "$seg" in
      *' '*) seg="${seg#* }"; seg="${seg#"${seg%%[![:space:]]*}"}" ;;
      *) return 0 ;;   # el segmento era solo la asignación
    esac
    [ -z "$seg" ] && return 0
    first="${seg%% *}"
  done

  seg="$(strip_sudo "$seg")"
  first="${seg%% *}"

  case "$first" in
    cd|pwd|ls|cat|head|tail|grep|egrep|fgrep|stat|file|wc|du|df|free|uptime|ps|date|echo|printf|uname|hostname|id|whoami|which|command|type|test|'['|true|:|sleep|tr|uniq|cut|jq|diff|comm|getent|basename|dirname|realpath|md5sum|sha1sum|sha256sum|dig|host|nslookup|zcat|zgrep|gunzip)
      # zcat/zgrep/gunzip solo aparecen leyendo los backups de clima.db.
      return 0 ;;
    sed)
      # -i/--in-place edita el archivo; `s///w file` y `w file` también escriben.
      printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-[[:alnum:]]*i|--in-place)([[:space:]]|$|\.)' && return 1
      printf '%s' "$seg" | grep -qE '/w[[:space:]]' && return 1
      return 0 ;;
    awk|gawk|mawk)
      printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-[[:alnum:]]*i|--in-place|inplace)([[:space:]]|$)' && return 1
      printf '%s' "$seg" | grep -qE '(system\(|close\(|print[^;}]*>|printf[^;}]*>)' && return 1
      return 0 ;;
    find)
      case "$seg" in *' -exec'* | *' -ok'* | *' -delete'* | *' -fprint'* | *' -fls'*) return 1 ;; esac
      return 0 ;;
    sort)
      case "$seg" in *' -o'* | *' --output'*) return 1 ;; esac
      return 0 ;;
    curl)
      printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-X[[:alnum:]]*|--request|-d[^[:alpha:]]?([[:space:]]|$|[@=[:alnum:]])|--data[^[:space:]]*|-F|--form|-T|--upload-file|-o|-O|--output|--remote-name|-c|--cookie-jar|--trace|-K|--config|--etag-save)' && return 1
      # -D/--dump-header solo escribe si el destino no es stdout (`-`).
      printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-D|--dump-header)([[:space:]]|$)' \
        && { printf '%s' "$seg" | grep -qE '(^|[[:space:]])(-D|--dump-header)[[:space:]]+-([[:space:]]|$)' || return 1; }
      return 0 ;;
    docker|podman)
      # Subcomandos que solo leen. `exec`, `run`, `rm`, `stop`, `cp`, `build`,
      # `system`, `volume` y compañía NO están: ejecutan o destruyen.
      # Los flags globales de `docker compose` (--env-file, -f, -p…) van ANTES
      # del subcomando y se enumeran uno por uno: aceptar cualquier token
      # intermedio dejaría pasar un `docker compose run --rm x ps`.
      printf '%s' "$seg" | grep -qE '^(docker|podman)[[:space:]]+(ps|images|info|version|top|port|stats|events|inspect|logs|diff|history|(image|volume|network|context)[[:space:]]+(ls|inspect))([[:space:]]|$)' && return 0
      printf '%s' "$seg" | grep -qE '^(docker|podman)[[:space:]]+compose([[:space:]]+(--env-file|--file|-f|--project-name|-p|--profile|--project-directory)[[:space:]]+[^[:space:]]+)*[[:space:]]+(ps|logs|config|top|version|images|events|port)([[:space:]]|$)' && return 0
      return 1 ;;
    git)
      # Solo subcomandos de lectura: `-c`, `--upload-pack`, `--receive-pack` y
      # `--exec-path` ejecutan comandos arbitrarios.
      printf '%s' "$seg" | grep -qE '(^|[[:space:]])(--upload-pack|--receive-pack|--exec-path|-c|sshCommand|GIT_SSH[[:alnum:]_]*)([=[:space:]]|$)' && return 1
      printf '%s' "$seg" | grep -qE '^git([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(status|log|show|diff|fetch|rev-parse|rev-list|ls-tree|ls-files|cat-file|describe|shortlog|blame|cherry|worktree[[:space:]]+list)([[:space:]]|$)' || return 1
      return 0 ;;
    gh)
      # gh habla con GitHub, no con este servidor. Excepción: disparar un
      # workflow o pegarle a la API sí puede deployar desde Actions.
      printf '%s' "$seg" | grep -qE '^gh[[:space:]]+(workflow|run|api|secret|release|repo)([[:space:]]|$)' && return 1
      return 0 ;;
    *)
      return 1 ;;
  esac
}

# Fast-path de solo lectura: los diagnósticos no piden confirmación. Allowlist
# fail-closed — verbo desconocido, redirección a archivo o sustitución con algo
# que escribe siguen preguntando.
is_read_only() {
  local cmd="$1" depth="${2:-0}" norm seg inner
  [ "$depth" -gt 4 ] && return 1

  # Sustitución de procesos de escritura: siempre escribe, no se negocia.
  case "$cmd" in *'>('*) return 1 ;; esac

  # sed y awk escriben sin usar la redirección del shell y su script va entre
  # comillas, invisible tras el placeholder QARG: se chequean sobre el crudo.
  printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])sed([[:space:]]+-[[:alnum:]]*i|[[:space:]]+--in-place)' && return 1
  printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])sed[^;&|]*/w[[:space:]]' && return 1
  printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_-])[gm]?awk([[:space:]]+-[[:alnum:]]*i|[[:space:]]+--in-place|[^;&|]*(system\(|close\(|print[^;}]*>|printf[^;}]*>))' && return 1

  # Sustitución de comandos: se valida el contenido recursivamente y se
  # reemplaza por un placeholder (de adentro hacia afuera).
  while inner=$(primera_subst "$cmd"); [ -n "$inner" ]; do
    is_read_only "${inner:2:${#inner}-3}" "$((depth + 1))" || return 1
    cmd=${cmd//"$inner"/SUBST}
  done
  while inner=$(printf '%s' "$cmd" | grep -oP '`[^`]*`' 2>/dev/null | head -1); [ -n "$inner" ]; do
    is_read_only "${inner:1:${#inner}-2}" "$((depth + 1))" || return 1
    cmd=${cmd//"$inner"/SUBST}
  done
  while inner=$(printf '%s' "$cmd" | grep -oP '<\([^()]*\)' 2>/dev/null | head -1); [ -n "$inner" ]; do
    is_read_only "${inner:2:${#inner}-3}" "$((depth + 1))" || return 1
    cmd=${cmd//"$inner"/SUBST}
  done
  case "$cmd" in *'$('* | *'`'* | *'<('*) return 1 ;; esac

  # Argumentos entre comillas → placeholder, para que un `grep -E "a|b"` no
  # parta segmentos falsos ni dispare el chequeo de `>`.
  norm=$(printf '%s' "$cmd" | sed -E 's/"[^"]*"/QARG/g; s/'\''[^'\'']*'\''/QARG/g')

  # Comentarios: bash descarta desde `#` hasta el fin de línea, así que el hook
  # también. Va DESPUÉS de QARG para no cortar un `#` dentro de un argumento.
  norm=$(printf '%s' "$norm" | sed -E 's/(^|[[:space:]])#.*$//')

  # Redirecciones: stderr y /dev/null se toleran; cualquier otra `>` escribe.
  norm=$(printf '%s' "$norm" | sed -E 's/[0-9]*>&[0-9]+//g; s/[0-9]*>>?[[:space:]]*\/dev\/null//g; s/-o[[:space:]]+\/dev\/null//g')
  case "$norm" in *'>'*) return 1 ;; esac

  while IFS= read -r seg; do
    seg_read_only "$seg" || return 1
  done <<EOF
$(printf '%s' "$norm" | tr '|&;' '\n\n\n')
EOF
  return 0
}

# El fast-path de solo lectura solo tiene sentido para lo que toca prod: si el
# comando está fuera de alcance, se salta directo a los destructivos globales
# (más abajo) para no pagar este análisis en CADA comando de la sesión.
[ "$TOCA_PROD" = "1" ] && is_read_only "$CMD" && exit 0

# ---------------------------------------------------------------------------
# Destructivos globales (van ANTES del corte por alcance)
# ---------------------------------------------------------------------------
# Es justamente el comando que no nombra prod el que hoy se colaba.
if MOTIVO_GLOBAL="$(destructivo_global "$CMD")"; then
  ask "DESTRUCTIVO GLOBAL: $MOTIVO_GLOBAL. No toca solo Vigia: afecta a toda la maquina (aca conviven Vigia, los dos ERP y el chatbot). Si de verdad es lo que quieres, confirma; si no, cancela."
fi

# Fuera del alcance de producción de este proyecto: no hay nada más que decidir.
[ "$TOCA_PROD" = "1" ] || exit 0

# ---------------------------------------------------------------------------
# Sesión interactiva: confirmación explícita antes de tocar prod
# ---------------------------------------------------------------------------
ask "El comando toca PRODUCCIÓN de Vigía (/opt/vigia o los contenedores clima-web/clima-ingesta/clima-push) y no es de solo lectura. El deploy normal es \`bash deploy/deploy.sh\`, que respalda y valida con smoke test. ¿Confirmas?"
