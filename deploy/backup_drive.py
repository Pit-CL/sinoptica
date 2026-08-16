#!/usr/bin/env python3
"""Copia offsite del backup semanal de Vigía a Google Drive.

Sube a la carpeta "vigia-backups" del Drive de la cuenta configurada en el
`.env` de prod (se reutiliza un OAuth ya existente, autorizado explícitamente,
en vez de crear uno nuevo para Vigía).

Solo librería estándar (regla del repo, ver CLAUDE.md): la subida usa el
protocolo resumable de Drive API v3 sobre urllib, streameando el archivo
desde disco (nunca lo carga entero en memoria — el tar semanal puede pesar
más de 1 GB).

Uso:
    python3 deploy/backup_drive.py <ruta-al-tar>

Variables de entorno (vía /opt/vigia/.env):
    GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN — si falta
    cualquiera, el script no hace nada y sale con éxito (patrón "dormido",
    igual que combustible.py): la copia offsite es un plus, no puede tumbar
    el backup local si aún no está configurada.
    SLACK_BOT_TOKEN, SLACK_CHANNEL_ID — opcional, aviso a Slack (bot
    Heraldo) si la subida falla. SLACK_WEBHOOK_URL queda como fallback de
    transición mientras el bot no esté invitado al canal.

El access_token SIEMPRE va en el header Authorization, nunca en la URL, y
los mensajes de error solo reportan el código HTTP — nunca el cuerpo crudo
de la respuesta ni la URL de la petición (evita filtrar tokens en logs).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable"
FILES_URL = "https://www.googleapis.com/drive/v3/files"
FOLDER_NAME = "vigia-backups"
KEEP_REMOTE = 8


def _slack_alert(mensaje: str) -> None:
    """Manda `mensaje` a Slack: bot Heraldo (chat.postMessage) si hay
    SLACK_BOT_TOKEN; si falla (ej. canal sin invitar) o no hay token,
    reintenta por el webhook. Todo best-effort, nunca tumba el script."""
    token = os.environ.get("SLACK_BOT_TOKEN", "")
    if token and _slack_alert_bot(mensaje, token):
        return
    _slack_alert_webhook(mensaje)


def _gchat_alert(mensaje: str) -> None:
    """Doble envío a Google Chat, espacio `alertas` (migración 2026-08-16).
    No reemplaza el aviso a Slack ni depende de que ese haya funcionado.
    Best-effort igual que su par: una copia offsite que falla ya es bastante
    problema como para que además el aviso tumbe el script."""
    webhook = os.environ.get("GCHAT_WEBHOOK_ALERTAS", "")
    if not webhook:
        return
    body = json.dumps({"text": f"[VIGIA] {mensaje}"}).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=body, method="POST",
        headers={"Content-Type": "application/json; charset=UTF-8"})
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass
    except Exception:
        pass  # nunca propaga la URL del webhook: lleva `key` y `token`


def _slack_alert_bot(mensaje: str, token: str) -> bool:
    channel = os.environ.get("SLACK_CHANNEL_ID", "") or "C0BH5SFQHFX"
    body = json.dumps({"channel": channel, "text": mensaje}).encode("utf-8")
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            data = json.loads(res.read())
            return bool(data.get("ok"))
    except Exception:
        return False


def _slack_alert_webhook(mensaje: str) -> None:
    webhook = os.environ.get("SLACK_WEBHOOK_URL", "")
    if not webhook:
        return
    body = json.dumps({"text": mensaje}).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=body, method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15):
            pass
    except Exception:
        pass  # el aviso es best-effort, nunca debe tumbar el script


def fail(mensaje: str) -> "int":
    print(f"ERROR: {mensaje}", file=sys.stderr)
    _slack_alert(f"🔴 Vigía: copia offsite a Google Drive falló: {mensaje}")
    _gchat_alert(f"🔴 copia offsite a Google Drive falló: {mensaje}")
    return 1


def get_access_token(client_id: str, client_secret: str, refresh_token: str) -> str:
    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }).encode("utf-8")
    req = urllib.request.Request(TOKEN_URL, data=body, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            data = json.loads(res.read())
    except urllib.error.HTTPError as err:
        raise RuntimeError(f"refresh de token falló: HTTP {err.code}")
    except Exception:
        raise RuntimeError("refresh de token falló: error de red")
    token = data.get("access_token")
    if not token:
        raise RuntimeError("refresh de token no devolvió access_token")
    return token


def _api_request(url: str, access_token: str, method: str = "GET",
                  data: bytes | None = None, extra_headers: dict | None = None):
    headers = {"Authorization": f"Bearer {access_token}"}
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.status, res.read()
    except urllib.error.HTTPError as err:
        err.read()  # drenar el cuerpo, nunca se imprime (puede traer detalle sensible)
        return err.code, b""


def ensure_folder(access_token: str) -> str:
    query = (f"name = '{FOLDER_NAME}' and "
             "mimeType = 'application/vnd.google-apps.folder' and trashed = false")
    url = f"{FILES_URL}?{urllib.parse.urlencode({'q': query, 'fields': 'files(id)'})}"
    status, body = _api_request(url, access_token)
    if status != 200:
        raise RuntimeError(f"búsqueda de carpeta '{FOLDER_NAME}' falló: HTTP {status}")
    files = json.loads(body).get("files", [])
    if files:
        return files[0]["id"]

    meta = json.dumps({
        "name": FOLDER_NAME,
        "mimeType": "application/vnd.google-apps.folder",
    }).encode("utf-8")
    status, body = _api_request(
        f"{FILES_URL}?fields=id", access_token, method="POST", data=meta,
        extra_headers={"Content-Type": "application/json"})
    if status not in (200, 201):
        raise RuntimeError(f"creación de carpeta '{FOLDER_NAME}' falló: HTTP {status}")
    return json.loads(body)["id"]


def upload_file(access_token: str, folder_id: str, file_path: Path) -> dict:
    size = file_path.stat().st_size
    meta = json.dumps({"name": file_path.name, "parents": [folder_id]}).encode("utf-8")
    init_req = urllib.request.Request(
        UPLOAD_URL, data=meta, method="POST",
        headers={
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "application/gzip",
            "X-Upload-Content-Length": str(size),
        })
    try:
        with urllib.request.urlopen(init_req, timeout=30) as res:
            session_url = res.headers.get("Location")
    except urllib.error.HTTPError as err:
        err.read()
        raise RuntimeError(f"inicio de subida resumable falló: HTTP {err.code}")
    if not session_url:
        raise RuntimeError("Drive no devolvió Location para la subida resumable")

    # PUT streameado: pasar el file handle como data hace que http.client lo
    # lea en bloques en vez de cargarlo entero en memoria (Content-Length
    # explícito porque un file object no tiene __len__).
    with open(file_path, "rb") as fh:
        put_req = urllib.request.Request(
            session_url, data=fh, method="PUT",
            headers={"Content-Type": "application/gzip", "Content-Length": str(size)})
        try:
            with urllib.request.urlopen(put_req, timeout=3600) as res:
                return json.loads(res.read())
        except urllib.error.HTTPError as err:
            err.read()
            raise RuntimeError(f"subida del archivo falló: HTTP {err.code}")


def list_folder(access_token: str, folder_id: str) -> list:
    query = f"'{folder_id}' in parents and trashed = false"
    params = {
        "q": query,
        "fields": "files(id,name,createdTime,size)",
        "orderBy": "createdTime desc",
        "pageSize": "100",
    }
    url = f"{FILES_URL}?{urllib.parse.urlencode(params)}"
    status, body = _api_request(url, access_token)
    if status != 200:
        raise RuntimeError(f"listado de carpeta falló: HTTP {status}")
    return json.loads(body).get("files", [])


def rotate(access_token: str, folder_id: str) -> None:
    files = list_folder(access_token, folder_id)
    for viejo in files[KEEP_REMOTE:]:
        print(f"    borrando remoto: {viejo['name']}")
        _api_request(f"{FILES_URL}/{viejo['id']}", access_token, method="DELETE")


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: python3 deploy/backup_drive.py <ruta-al-tar>", file=sys.stderr)
        return 1
    client_id = os.environ.get("GDRIVE_CLIENT_ID", "")
    client_secret = os.environ.get("GDRIVE_CLIENT_SECRET", "")
    refresh_token = os.environ.get("GDRIVE_REFRESH_TOKEN", "")
    if not (client_id and client_secret and refresh_token):
        print("[backup_drive] faltan credenciales GDRIVE_*, nada que hacer (dormido)")
        return 0

    file_path = Path(sys.argv[1])
    if not file_path.is_file():
        return fail(f"no existe el archivo {file_path}")

    try:
        access_token = get_access_token(client_id, client_secret, refresh_token)
        folder_id = ensure_folder(access_token)
        print(f"==> Subiendo {file_path.name} ({file_path.stat().st_size / 1e6:.0f} MB) a Drive...")
        result = upload_file(access_token, folder_id, file_path)
        print(f"==> Subido: {result.get('name')} (id {result.get('id')})")
        rotate(access_token, folder_id)
        print("==> Rotación remota completa (conservar los últimos "
              f"{KEEP_REMOTE}).")
    except Exception as exc:
        return fail(str(exc))
    return 0


if __name__ == "__main__":
    sys.exit(main())
