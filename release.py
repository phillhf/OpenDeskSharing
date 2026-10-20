#!/usr/bin/env python3
"""
Veröffentlicht die aktuelle Version auf GitHub (phillhf/OpenDeskSharing):
  1. python build.py          -> dist/OpenDeskSharing-<Version>.zip (+ .sha256)
  2. python release.py        -> Git-Tag v<Version>, GitHub-Release mit Paket, Prüfsumme und Änderungen aus CHANGELOG.md

Voraussetzung: GitHub CLI (gh) angemeldet, Änderungen committet und gepusht.
Installierte Server finden die Version danach unter Einstellungen > System > „Nach Updates suchen“.
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = "phillhf/OpenDeskSharing"


def main():
    version = open(os.path.join(HERE, "src", "VERSION"), encoding="utf-8").read().strip()
    zip_path = os.path.join(HERE, "dist", f"OpenDeskSharing-{version}.zip")
    sha_path = zip_path + ".sha256"
    exe_path = os.path.join(HERE, "dist", f"OpenDeskSharing-Setup-{version}.exe")
    for p in (zip_path, sha_path, exe_path, exe_path + ".sha256"):
        if not os.path.exists(p):
            sys.exit(f"{p} fehlt – zuerst python build.py ausführen.")
    log = open(os.path.join(HERE, "src", "CHANGELOG.md"), encoding="utf-8").read()
    m = re.search(rf"^## {re.escape(version)}\b.*?$(.*?)(?=^## |\Z)", log, re.S | re.M)
    notes = (m.group(1).strip() if m else "") + (
        "\n\n---\n**Installation/Update:** `OpenDeskSharing-Setup-" + version + ".exe` herunterladen und starten – "
        "oder in OpenDeskSharing unter Einstellungen → System „Nach Updates suchen“. "
        "Ohne grafische Oberfläche: `OpenDeskSharing-" + version + ".zip` entpacken und `Installieren.bat` ausführen.")
    if subprocess.run(["git", "status", "--porcelain"], cwd=HERE, capture_output=True, text=True).stdout.strip():
        sys.exit("Es gibt nicht committete Änderungen – bitte zuerst committen und pushen.")
    subprocess.run(["gh", "release", "create", f"v{version}", exe_path, exe_path + ".sha256", zip_path, sha_path, "--repo", REPO,
                    "--title", f"OpenDeskSharing {version}", "--notes", notes, "--target", "main"], cwd=HERE, check=True)
    print(f"Veröffentlicht: https://github.com/{REPO}/releases/tag/v{version}")


if __name__ == "__main__":
    main()
