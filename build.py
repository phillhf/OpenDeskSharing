#!/usr/bin/env python3
"""
Erzeugt ein Installations-/Update-Paket:  dist/OpenDeskSharing-<Version>.zip

  python build.py                         Version aus src/VERSION
  python build.py --python C:\\pfad\\python-3.12.10-amd64.exe
                                          Python-Installer ins Paket legen (für Rechner ohne Internet)
  python build.py --force                 vorhandenes Paket gleicher Version überschreiben
  python build.py --no-setup              ohne grafisches Setup (OpenDeskSharing-Setup-<Version>.exe)

Das Setup wird mit Inno Setup 6 erzeugt (ISCC.exe), sofern installiert.

Nur für Tests: --src, --version, --out
"""
import argparse
import hashlib
import json
import os
import py_compile
import re
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
APP_FILES = ["server.py", "odsad.py", "odstls.py", "odsupdate.py", "VERSION", "CHANGELOG.md", "README.md", "static"]


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def write_text(dst, text, bom=False, crlf=False):
    if crlf:
        text = text.replace("\r\n", "\n").replace("\n", "\r\n")
    with open(dst, "w", encoding="utf-8-sig" if bom else "utf-8", newline="") as f:
        f.write(text)


def main():
    ap = argparse.ArgumentParser(description="OpenDeskSharing-Paket bauen")
    ap.add_argument("--src", default=os.path.join(HERE, "src"))
    ap.add_argument("--version", help="Version überschreiben (nur für Tests)")
    ap.add_argument("--out", default=os.path.join(HERE, "dist"))
    ap.add_argument("--python", help="Python-Installationsdatei (python-*.exe) mit ins Paket legen")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--no-setup", action="store_true", help="kein grafisches Setup erzeugen")
    a = ap.parse_args()

    version = a.version or open(os.path.join(a.src, "VERSION"), encoding="utf-8").read().strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        sys.exit(f"Ungültige Version: {version!r} (erwartet z. B. 1.2.0)")
    name = f"OpenDeskSharing-{version}"
    zip_path = os.path.join(a.out, name + ".zip")
    if os.path.exists(zip_path) and not a.force:
        sys.exit(f"{zip_path} existiert bereits. Versionen sind unveränderlich – bitte src/VERSION erhöhen (oder --force).")

    # Prüfungen vor dem Bauen
    for f in ("server.py", "odsad.py", "odstls.py", "odsupdate.py"):
        py_compile.compile(os.path.join(a.src, f), doraise=True)
    node = shutil.which("node")
    if node:
        subprocess.run([node, "--check", os.path.join(a.src, "static", "app.js")], check=True)
    print(f"Syntaxprüfung ok{'' if node else ' (JavaScript nicht geprüft – node fehlt)'}")

    stage_root = os.path.join(a.out, "_build")
    stage = os.path.join(stage_root, name)
    shutil.rmtree(stage_root, ignore_errors=True)
    os.makedirs(os.path.join(stage, "app"))
    os.makedirs(os.path.join(stage, "setup"))

    # Programm
    for item in APP_FILES:
        src = os.path.join(a.src, item)
        dst = os.path.join(stage, "app", item)
        if os.path.isdir(src):
            shutil.copytree(src, dst, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(src, dst)
    if a.version:
        write_text(os.path.join(stage, "app", "VERSION"), version + "\n")

    # Installer: PowerShell-Skripte mit BOM (sonst falsche Umlaute in Windows PowerShell 5.1), Windows-Zeilenenden
    inst = os.path.join(HERE, "installer")
    for f in ("install.ps1", "uninstall.ps1", "steuerung.ps1"):
        if re.search("[“”„]", open(os.path.join(inst, f), encoding="utf-8").read()):
            sys.exit(f"{f}: typografische Anfuehrungszeichen sind in PowerShell Zeichenketten-Begrenzer - bitte durch ' ersetzen")
        write_text(os.path.join(stage, "setup", f), open(os.path.join(inst, f), encoding="utf-8").read(), bom=True, crlf=True)
    write_text(os.path.join(stage, "Installieren.bat"), open(os.path.join(inst, "Installieren.bat"), encoding="utf-8").read(), crlf=True)
    write_text(os.path.join(stage, "LIESMICH.txt"), open(os.path.join(inst, "LIESMICH.txt"), encoding="utf-8").read(), bom=True, crlf=True)
    shutil.copy2(os.path.join(inst, "app.ico"), os.path.join(stage, "setup", "app.ico"))
    if a.python:
        os.makedirs(os.path.join(stage, "setup", "python"))
        shutil.copy2(a.python, os.path.join(stage, "setup", "python", os.path.basename(a.python)))

    # Manifest mit Prüfsummen aller Dateien
    files = {}
    for dirpath, _, names in os.walk(stage):
        for n in names:
            full = os.path.join(dirpath, n)
            rel = os.path.relpath(full, stage).replace("/", "\\")
            files[rel] = sha256(full)
    manifest = {"name": "OpenDeskSharing", "version": version, "built": datetime.now().replace(microsecond=0).isoformat(),
                "python_min": "3.9", "files": dict(sorted(files.items()))}
    write_text(os.path.join(stage, "manifest.json"), json.dumps(manifest, indent=2, ensure_ascii=False))

    # ZIP
    os.makedirs(a.out, exist_ok=True)
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _, names in os.walk(stage):
            for n in sorted(names):
                full = os.path.join(dirpath, n)
                z.write(full, os.path.join(name, os.path.relpath(full, stage)))
    digest = sha256(zip_path)
    write_text(zip_path + ".sha256", f"{digest}  {os.path.basename(zip_path)}\n")
    print(f"Paket erstellt: {zip_path}  ({os.path.getsize(zip_path) // 1024} KB, {len(files)} Dateien)")
    print(f"SHA-256: {digest}")

    # Grafisches Setup (Inno Setup) aus demselben Paketinhalt
    if not a.no_setup:
        iscc = next((p for p in (os.path.expandvars(r"%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe"),
                                 os.path.expandvars(r"%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe"),
                                 os.path.expandvars(r"%ProgramFiles%\Inno Setup 6\ISCC.exe")) if os.path.exists(p)), None)
        if not iscc:
            print("Hinweis: Inno Setup 6 nicht gefunden – kein grafisches Setup erzeugt (winget install JRSoftware.InnoSetup).")
        else:
            out = os.path.abspath(a.out)
            subprocess.run([iscc, "/Qp", f"/DAppVersion={version}", f"/DPkgDir={stage}", f"/O{out}",
                            os.path.join(inst, "OpenDeskSharing.iss")], check=True)
            exe = os.path.join(out, f"OpenDeskSharing-Setup-{version}.exe")
            write_text(exe + ".sha256", f"{sha256(exe)}  {os.path.basename(exe)}\n")
            print(f"Setup erstellt: {exe}  ({os.path.getsize(exe) // 1024} KB)")
    shutil.rmtree(stage_root, ignore_errors=True)


if __name__ == "__main__":
    main()
