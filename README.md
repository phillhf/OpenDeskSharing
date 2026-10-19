# OpenDeskSharing

Lokales, datenschutzkonformes Buchungssystem für **Arbeitsplätze und Besprechungsräume** – Buchen direkt im Raumplan.
Läuft komplett auf einem eigenen Windows-Server im Haus, ohne Cloud-Dienste, ohne Tracking, ohne externe Abhängigkeiten
(nur Python-Standardbibliothek).

## Funktionen

- Gebäude, Etagen und Raumpläne (eigener Grundriss als Bild, Räume und Plätze im Editor einzeichnen)
- Buchen im Plan, Wochenansicht, Serienbuchungen, Favoriten, Vorschlag freier Plätze nach Ausstattung
- Check-in „Ich bin da“ / „Ich bin nicht mehr da“ (gibt den Platz vorzeitig frei)
- Benutzergruppen und Buchungsrechte je Gebäude, Etage und Raum
- Anmeldung mit eigenem Passwort oder Windows-/Active-Directory-Konto
- Auswertungen ohne Personenbezug: Auslastung, Spitzenzeiten, gemeldeter Bedarf („nichts Passendes gefunden“)
- Gesetzliche Feiertage je Bundesland automatisch, Schließtage
- HTTPS mit automatisch erzeugtem Zertifikat
- Smartphone-tauglich

## Installation

1. Unter [Releases](https://github.com/phillhf/OpenDeskSharing/releases) die neueste `OpenDeskSharing-<Version>.zip` herunterladen.
2. ZIP entpacken und `Installieren.bat` starten (fragt nach Administratorrechten).
3. Das Installationsprogramm prüft die Voraussetzungen (Python ab 3.9 – auf Wunsch wird es installiert),
   richtet den Server ein und zeigt Adresse und Erstanmeldung an.

Gestartet wird der Server mit `OpenDeskSharing starten.bat` im Installationsordner bzw. über das Startmenü.
Details: [installer/LIESMICH.txt](installer/LIESMICH.txt)

## Updates

In OpenDeskSharing unter **Einstellungen → System → „Nach Updates suchen“**. GitHub wird nur bei diesem Klick
kontaktiert. Das Update prüft die Prüfsumme, sichert Programm und Datenbank und kehrt bei Problemen automatisch
zur bisherigen Version zurück. Ohne Internetzugang: neues Paket herunterladen und `Installieren.bat` ausführen.

## Entwicklung

Siehe [README-Entwicklung.md](README-Entwicklung.md) – `python build.py` erzeugt das Paket,
`python release.py` veröffentlicht es als GitHub-Release.
