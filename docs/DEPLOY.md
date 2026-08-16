# Despliegue y operación

Vigía corre con tres contenedores (ver [`docker-compose.yml`](../docker-compose.yml)):

- **`web`** — nginx Alpine sirviendo `web/` como sitio estático, endurecido, escuchando solo en `127.0.0.1`.
- **`ingesta`** — Python + cron que archiva datos en `data/clima.db` y publica los 16 JSON que lee la PWA.
- **`push`** — servidor de suscripciones (`server.py`, foreground) + cron de envío (`send.py`, cada 5 min) para las notificaciones Web Push de emergencias mayores. Es la única dependencia externa del proyecto (`pywebpush`); todo lo demás es librería estándar de Python.

## Puesta en marcha

```bash
git clone <repo> && cd clima
cp .env.example .env        # opcional: DMC, FIRMS; obligatorio si vas a usar push
docker compose run --rm push python3 /app/push/genkeys.py   # solo la primera vez
# copia las dos líneas VAPID_PRIVATE_KEY / VAPID_PUBLIC_KEY que imprime al .env
docker compose up -d
```

Eso deja el sitio en `http://127.0.0.1:8100`. La ingesta corre su primer ciclo en el siguiente tick de cron; para forzarlo:

```bash
docker compose exec ingesta python3 /app/ingesta/run.py --all
```

Si no vas a usar notificaciones Web Push, `VAPID_PRIVATE_KEY` igual debe existir en `.env` (el compose lo exige con `:?`) — basta con generarlo una vez como arriba; el contenedor `push` puede quedar recibiendo suscripciones sin que nadie las use.

## Exposición segura (Cloudflare Tunnel)

El sitio se publica **sin abrir puertos** al exterior, vía [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/). En la configuración del túnel se enruta el hostname al servicio local:

```yaml
ingress:
  - hostname: clima.tu-dominio.cl
    service: http://localhost:8100
```

Cloudflare aporta el TLS y la CDN del borde; el origen nunca queda expuesto directamente a internet.

**Dominio canónico:** `vigia.cavara.cl`. El dominio anterior, `clima.cavara.cl`, sigue activo en paralelo (mismo ingress, mismo servicio) para no romper las PWAs ya instaladas — un redirect 301 no las actualiza porque el service worker y la CSP `connect-src 'self'` no siguen redirects entre orígenes. Su retiro queda para más adelante.

**Servidor:** repo y prod viven en la misma máquina (`/opt/vigia`); el deploy es local con `bash deploy/deploy.sh`, sin ssh de por medio. nginx escucha en `127.0.0.1:${VIGIA_HTTP_PORT:-8100}` — el puerto 8100 por defecto está libre en este VPS. El Cloudflare Tunnel de este VPS es compartido: el mismo túnel enruta `vigia.cavara.cl`/`clima.cavara.cl` (a `http://localhost:8100`) además de otros sitios del mismo VPS; su configuración vive en `/etc/cloudflared/config.yml`, no en este repo. Reiniciar `cloudflared` corta esos otros sitios por unos segundos — evita hacerlo salvo que sea necesario.

**Backup:** `deploy/backup.sh` corre por cron del host (domingo 04:30) y respalda `clima.db` (hot backup vía `sqlite3` stdlib, con `integrity_check`), `.env` y `watchdog_state.json` en `/home/rafael/Backups/vigia/vigia-YYYYMMDD.tar.gz` (chmod 600, conserva los últimos 8). Avisa al espacio `alertas` de Google Chat si falla (`GCHAT_WEBHOOK_ALERTAS`).

## Seguridad

- nginx **solo** en `127.0.0.1` — el único camino de entrada es el túnel.
- Imágenes con versión fija, `no-new-privileges`, código montado en **solo lectura**; la ingesta no expone puertos y solo escribe en `data/`.
- **CSP estricta** sin `unsafe-inline`: Chart.js, Leaflet y las fuentes están vendorizados (sin CDNs de terceros). Solo se permiten los tiles del mapa y las APIs de Open-Meteo.
- Secretos (token DMC, `FIRMS_MAP_KEY`, claves VAPID) solo en `.env`, con permisos `600`, **nunca** en el repo.

## Ciclo de ingesta

| Tarea | Frecuencia | Qué archiva |
|---|---|---|
| Observaciones + calidad del aire | cada hora | METAR (NOAA) + DMC → `estaciones.json`, SINCA → `aire.json` |
| Pronósticos | 2 veces al día | 6 modelos deterministas + ensamble (51 miembros) |
| Verificación + calibración | con cada corrida de observaciones/pronósticos | recomputa `verificacion.json` y recalcula bias → `bias.json` |
| Avisos meteorológicos propios | con cada corrida (sin red, barato) | mediana multi-modelo → `avisos.json` |
| Sismos (CSN + USGS) + estado de tsunami (PTWC) | cada 10 min | `sismos.json`, `tsunami.json` |
| Incendios (NASA FIRMS) + alertas (SENAPRED) | cada hora | `incendios.json`, `alertas.json` |
| Volcanes (RNVV SERNAGEOMIN) | 2 veces al día | `volcanes.json` |
| Marea, oleaje y temperatura del mar (Open-Meteo Marine) | 4 veces al día | `marea.json` |
| Infraestructura de emergencia (Chile Preparado) | 1 vez por semana (cuasi-estática) | `emergencia.json`, `tsunami_vias.json`, `tsunami_areas.json` |
| Catastro de remociones en masa (SENAPRED) | 1 vez por semana (cuasi-estática) | `remociones.json` |
| Cortes de luz SEC (best effort, requiere satélite en omen) | cada 15 min | `cortes.json` |
| Envío de Web Push (contenedor `push`) | cada 5 min | notifica sismos/alertas/volcanes/tsunami nuevos a los suscriptores |

Definición en [`deploy/crontab`](../deploy/crontab) y [`push/crontab`](../push/crontab).

## Satélite omen (fuentes que bloquean IPs de datacenter)

SEC (cortes de luz) y MINSAL (farmacias de turno) responden solo desde IPs
residenciales chilenas: fallan desde este VPS (IP de datacenter) y
funcionan desde `omen` (verificado). `ingesta/cortes.py` en el VPS **no
fetchea la red**: solo lee `data/incoming/sec.json`, subido por scp desde
`satelite/fetch_cl.py` corriendo en cron en omen. Instalación completa,
generación de la clave ssh dedicada (restringida por `command=` a solo scp
sobre `incoming/`) y la crontab de omen: [`satelite/README.md`](../satelite/README.md).

Degradación aceptada: si omen cae, `cortes.json` deja de refrescarse y
queda marcado `"stale": true` con el último dato bueno — el resto de Vigía
no se afecta. `deploy/smoke.py` avisa (no bloquea el deploy) si `cortes.json`
lleva más de 24 h sin actualizarse o si el archivo todavía no existe (antes
de instalar el satélite por primera vez).

## Actualizar

```bash
bash deploy/deploy.sh          # despliega origin/main
bash deploy/deploy.sh <ref>    # despliega un ref específico (rama, tag, commit)
```

El script hace, en orden: `git archive` del ref a un export temporal → verifica que el export tenga `docker-compose.yml`, `deploy/nginx.conf`, `web/app.js` y que `index.html`/`sw.js` compartan el mismo `?v=N` → `rsync --delete` local del export a `/opt/vigia/` → `docker compose up -d && docker compose restart web` (directo, sin ssh: el destino es este mismo VPS) → smoke test (ver abajo). Si cualquier verificación o el smoke test falla, el script sale con código 1 y no queda en un estado a medias silencioso.

> **Importante:** si cambiaste `app.js` o `app.css`, sube el sufijo `?v=N` en `index.html` (y en `sw.js`). Cloudflare cachea JS/CSS por extensión; sin el bump seguiría sirviendo la versión anterior. Los JSON de datos y `sw.js` se sirven con `no-cache` para evitar justamente eso. El propio `deploy.sh` corta el deploy si detecta esta desincronización.

Referencia — el rsync manual que hace `deploy.sh` por debajo (útil si necesitas subir sin el script; es local, no por ssh):

```bash
rsync -a --delete \
  --exclude data/ --exclude .git/ --exclude .env --exclude .claude/ \
  --exclude 'web/status.json' --exclude 'web/verificacion.json' --exclude 'web/estaciones.json' \
  --exclude 'web/aire.json' --exclude 'web/bias.json' --exclude 'web/avisos.json' \
  --exclude 'web/sismos.json' --exclude 'web/incendios.json' --exclude 'web/alertas.json' \
  --exclude 'web/volcanes.json' --exclude 'web/emergencia.json' --exclude 'web/remociones.json' \
  --exclude 'web/tsunami_vias.json' --exclude 'web/tsunami_areas.json' \
  --exclude 'web/marea.json' --exclude 'web/tsunami.json' \
  ./ /opt/vigia/
cd /opt/vigia && docker compose restart web
```

> Los dieciséis JSON de arriba se excluyen porque son **generados**: en dev la ingesta los escribe en `web/` (defaults de `ingesta/config.py`); en prod van a `/data` (envs del compose) y nginx los sirve por `alias`. Antes de correr el `rsync --delete`, verifica que la ruta de destino sea la correcta — `--delete` borra en el servidor cualquier archivo que no exista en el origen.

### Smoke test

Dos scripts en `deploy/`, pensados para atrapar justo los bugs que un deploy manual dejó pasar (mapa en blanco por CSP incompleta, geolocalización bloqueada por Permissions-Policy, capas restauradas vacías, `?v=N` desincronizado):

- **`smoke.py`** — solo librería estándar de Python, puede correr en el propio servidor. Verifica que `index.html`/`sw.js` compartan versión, que la CSP y el Permissions-Policy tengan los hosts/permisos correctos, que `sismos.json`/`estaciones.json` estén frescos y que `emergencia.html` responda.
- **`smoke_browser.py`** — requiere Playwright, corre en la máquina de desarrollo (`~/.venvs/playwright/bin/python`). Abre un Chromium headless real: recarga la página bajo el service worker y confirma que los tiles del mapa cargan, activa la capa satelital y espera sus tiles, simula un permiso de geolocalización y prueba el botón de punto de encuentro más cercano, y falla si aparece cualquier error de JavaScript.

`deploy.sh` corre ambos automáticamente al final; `smoke_browser.py` se omite si no encuentra el intérprete de Playwright.

## Verificar estado

```bash
# últimas corridas de ingesta
docker compose exec ingesta python3 -c "import sqlite3; \
  [print(r) for r in sqlite3.connect('/data/clima.db').execute( \
  'SELECT run_at,kind,ok,rows FROM ingest_log ORDER BY rowid DESC LIMIT 8')]"

# tamaño del archivo histórico
docker compose exec ingesta sh -c 'du -h /data/clima.db'
```

El footer de la propia app muestra en vivo cuántos pronósticos y observaciones lleva acumulados el archivo.
