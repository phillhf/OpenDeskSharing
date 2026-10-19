"""
OpenDeskSharing – Updates von GitHub.

Kontaktiert GitHub nur, wenn ein Administrator in den Einstellungen „Nach Updates suchen“ bzw.
„Jetzt installieren“ klickt – sonst bleibt OpenDeskSharing komplett offline.

Installieren: Paket der neuesten Version (Release-Anhang OpenDeskSharing-<Version>.zip) laden, gegen die
veröffentlichte SHA-256-Prüfsumme prüfen, entpacken und das mitgelieferte Installationsprogramm als eigene
Windows-Aufgabe (SYSTEM) starten. Das Installationsprogramm beendet den Server, sichert Programm und Datenbank,
spielt die neue Version ein und kehrt bei Problemen automatisch zur alten Version zurück.
"""
import hashlib
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
import urllib.request
import zipfile
from datetime import datetime

REPO = "phillhf/OpenDeskSharing"
API = f"https://api.github.com/repos/{REPO}/releases/latest"
MAX_SIZE = 50 * 1024 * 1024
LOCK = threading.Lock()


class UpdateError(Exception):
    pass


def _get(url, accept="application/vnd.github+json", limit=MAX_SIZE):
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "OpenDeskSharing-Updater"})
    try:
        with urllib.request.urlopen(req, timeout=30, context=ssl.create_default_context()) as r:
            data = r.read(limit + 1)
    except Exception as e:  # noqa: BLE001 – verständliche Meldung statt Stacktrace
        raise UpdateError(f"GitHub ist nicht erreichbar ({e.__class__.__name__}: {getattr(e, 'reason', e)}). "
                          "Hat der Server Internetzugang (ggf. Proxy/Firewall)?")
    if len(data) > limit:
        raise UpdateError("Die Datei von GitHub ist unerwartet groß – abgebrochen.")
    return data


def vtuple(v):
    m = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", (v or "").strip())
    return tuple(int(x) for x in m.groups()) if m else (0, 0, 0)


def install_root(base_dir):
    """Installationsordner (enthält install.json) – None, wenn nicht über das Installationsprogramm installiert."""
    root = os.path.dirname(base_dir)
    return root if os.path.isfile(os.path.join(root, "install.json")) else None


def latest():
    rel = json.loads(_get(API))
    ver = (rel.get("tag_name") or "").lstrip("v")
    if vtuple(ver) == (0, 0, 0):
        raise UpdateError("Auf GitHub wurde keine gültige Version gefunden.")
    assets = {a["name"]: a["browser_download_url"] for a in rel.get("assets", [])}
    name = f"OpenDeskSharing-{ver}.zip"
    return {"version": ver, "notes": rel.get("body") or "", "published": rel.get("published_at") or "",
            "page": rel.get("html_url") or f"https://github.com/{REPO}/releases",
            "zip": assets.get(name), "sha256": assets.get(name + ".sha256"), "name": name}


def check(current, base_dir):
    rel = latest()
    root = install_root(base_dir)
    reason = ""
    if sys.platform != "win32":
        reason = "Automatisches Installieren ist nur unter Windows möglich."
    elif not root:
        reason = "Dieser Server wurde nicht mit dem Installationsprogramm eingerichtet – bitte das Paket von GitHub laden und Installieren.bat ausführen."
    elif not (rel["zip"] and rel["sha256"]):
        reason = "Die Version auf GitHub enthält kein vollständiges Paket."
    return {"current": current, "latest": rel["version"], "newer": vtuple(rel["version"]) > vtuple(current),
            "notes": rel["notes"], "published": rel["published"], "page": rel["page"],
            "can_install": not reason, "reason": reason, "repo": REPO}


def _safe_extract(zf, dest):
    dest = os.path.realpath(dest)
    for m in zf.infolist():
        target = os.path.realpath(os.path.join(dest, m.filename))
        if not (target == dest or target.startswith(dest + os.sep)):
            raise UpdateError("Ungültiger Dateipfad im Paket – abgebrochen.")
    zf.extractall(dest)


def install(current, base_dir, log=print):
    """Lädt, prüft und startet das Update. Kehrt sofort zurück; der Server wird kurz darauf vom Installationsprogramm beendet."""
    if not LOCK.acquire(blocking=False):
        raise UpdateError("Es läuft bereits ein Update.")
    try:
        info = check(current, base_dir)
        if not info["newer"]:
            raise UpdateError(f"Version {current} ist bereits aktuell.")
        if not info["can_install"]:
            raise UpdateError(info["reason"])
        rel = latest()
        root = install_root(base_dir)
        with open(os.path.join(root, "install.json"), encoding="utf-8-sig") as f:
            instance = json.load(f).get("instance") or "OpenDeskSharing"
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", instance):
            raise UpdateError("Ungültiger Instanzname in install.json")

        upd = os.path.join(root, "updates")
        shutil.rmtree(upd, ignore_errors=True)
        os.makedirs(upd, exist_ok=True)
        log(f"Update: lade {rel['name']} von GitHub …")
        data = _get(rel["zip"], accept="application/octet-stream")
        expected = _get(rel["sha256"], accept="application/octet-stream", limit=4096).decode("ascii", "replace").split()[0].lower()
        actual = hashlib.sha256(data).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", expected) or actual != expected:
            raise UpdateError("Die Prüfsumme des heruntergeladenen Pakets stimmt nicht – das Update wurde NICHT installiert.")
        zpath = os.path.join(upd, rel["name"])
        with open(zpath, "wb") as f:
            f.write(data)
        with zipfile.ZipFile(zpath) as zf:
            _safe_extract(zf, upd)
        script = os.path.join(upd, f"OpenDeskSharing-{rel['version']}", "setup", "install.ps1")
        if not os.path.isfile(script):
            raise UpdateError("Im Paket fehlt das Installationsprogramm.")

        # Das Installationsprogramm läuft als eigene Windows-Aufgabe weiter, auch wenn dieser Server beendet wird
        stamp = datetime.now().strftime("%Y-%m-%d_%H%M%S")
        task = f"{instance}-Update"
        cmd = os.path.join(upd, "update.cmd")
        with open(cmd, "w", encoding="ascii", errors="replace", newline="\r\n") as f:
            f.write("@echo off\n"
                    "chcp 65001 >nul\n"
                    'set "PSModulePath="\n'
                    f'powershell -NoProfile -ExecutionPolicy Bypass -File "{script}" -Unattended -InstallDir "{root}" '
                    f'-Instance "{instance}" > "{os.path.join(root, "logs", "update_" + stamp + ".log")}" 2>&1\n'
                    f'schtasks /Delete /TN "{task}" /F >nul 2>&1\n')
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        r = subprocess.run(["schtasks", "/Create", "/TN", task, "/TR", f'"{cmd}"', "/SC", "ONCE", "/ST", "00:00",
                            "/RU", "SYSTEM", "/RL", "HIGHEST", "/F"], capture_output=True, encoding="oem", errors="replace", creationflags=flags)
        if r.returncode != 0:
            raise UpdateError("Die Update-Aufgabe konnte nicht angelegt werden: " + (r.stderr or r.stdout).strip())
        r = subprocess.run(["schtasks", "/Run", "/TN", task], capture_output=True, encoding="oem", errors="replace", creationflags=flags)
        if r.returncode != 0:
            raise UpdateError("Die Update-Aufgabe konnte nicht gestartet werden: " + (r.stderr or r.stdout).strip())
        log(f"Update: Installation von Version {rel['version']} gestartet (Protokoll logs\\update_{stamp}.log)")
        return {"ok": True, "version": rel["version"], "log": f"logs\\update_{stamp}.log"}
    finally:
        LOCK.release()
