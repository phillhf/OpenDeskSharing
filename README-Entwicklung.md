# OpenDeskSharing – Entwicklung und Versionen

Dieser Ordner enthält den Quellcode. Die produktive Installation (Standard `C:\Tools\OpenDeskSharing`)
wird **nie direkt bearbeitet**, sondern nur über Pakete aktualisiert.

```
src\            Quellcode der Anwendung (server.py, static\, VERSION, CHANGELOG.md)
installer\      Installations-/Update-Skripte (install.ps1, uninstall.ps1, Installieren.bat, LIESMICH.txt)
build.py        erzeugt das Paket
dist\           fertige Pakete: OpenDeskSharing-<Version>.zip (+ .sha256)
```

## Neue Version erstellen
1. Änderungen in `src\` vornehmen
2. `src\VERSION` erhöhen (1.0.0 → 1.0.1 Fehlerbehebung, → 1.1.0 neue Funktionen, → 2.0.0 große Umstellung)
3. Eintrag in `src\CHANGELOG.md`
4. `python build.py` → `dist\OpenDeskSharing-<Version>.zip` und `dist\OpenDeskSharing-Setup-<Version>.exe`
   (das Setup braucht Inno Setup 6 auf dem Entwicklungsrechner; Skript: `installer\OpenDeskSharing.iss`)
5. Committen und pushen, dann `python release.py` → GitHub-Release `v<Version>` mit Paket, Prüfsumme und
   den Änderungen aus `CHANGELOG.md`. Installierte Server finden die Version unter
   Einstellungen → System → „Nach Updates suchen“.

Das Build-Skript prüft vorher die Syntax von Python und JavaScript, bricht bei bereits vorhandener
Versionsnummer ab (Versionen sind unveränderlich) und schreibt für jede Datei eine SHA-256-Prüfsumme
in `manifest.json`, die der Installer vor dem Einspielen kontrolliert.

## Paket für Rechner ohne Internet
Python-Installer (python-3.x.y-amd64.exe von python.org) mit ins Paket legen:
`python build.py --python C:\Pfad\python-3.12.10-amd64.exe --force`

## Datenbank-Änderungen
Neue Spalten/Tabellen werden beim Serverstart automatisch ergänzt (`MIGRATIONS` bzw. `SCHEMA` in server.py).
Änderungen immer nur **hinzufügend** gestalten, damit die automatische Rückkehr zur Vorversion funktioniert.
