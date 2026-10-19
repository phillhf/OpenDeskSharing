# OpenDeskSharing – lokales Desk-Sharing- & Raumbuchungstool

Arbeitsplatz- und Raumbuchung (ähnlich Deskly), die **vollständig offline** auf einem eigenen Rechner/Server läuft.
Keine Cloud, keine externen Bibliotheken, keine CDNs, kein Tracking – alle Daten bleiben in einer lokalen SQLite-Datei.

## Funktionen

- **Benutzerverwaltung** mit Rollen (Benutzer / Administrator), Passwort-Zwang bei Erstanmeldung, Konten sperren
- **Gebäude → Etagen → Räume → Arbeitsplätze**
- **Grafischer Raumplan-Editor**: Grundriss-Bild (PNG/JPG) hinterlegen, Räume als Rechtecke einzeichnen,
  Arbeitsplätze per Klick setzen oder automatisch im Raster anlegen, per Drag & Drop verschieben/Größe ändern
- **Raumtypen**: Arbeitsraum (Plätze einzeln buchbar), Besprechungsraum (als Ganzes buchbar), Sonstiges (nicht buchbar)
- **Buchen direkt im Raumplan**: Farbige Belegungsanzeige (frei / teilweise / belegt / meine), Zeitfenster frei wählbar
  (ganztags, vormittags, nachmittags, beliebig), Tagesleiste mit Belegung, Serienbuchung Mo–Fr
- Admins können für andere Personen buchen und alle Buchungen einsehen/stornieren, CSV-Export
- Regeln: max. Tage im Voraus, buchbare Uhrzeiten, ein Platz pro Person gleichzeitig
- **Ausstattungsmerkmale** (z. B. 2 Monitore, Dockingstation, TV, Videokonferenz): Katalog unter *Einstellungen*,
  Zuordnung per Häkchen im Raumplan-Editor, Filter beim Buchen (Raum-Merkmale gelten auch für die Plätze darin)
- **Check-in / Check-out**: „Ich bin da“ (ab 15 Min. vor Beginn) und „Ich bin nicht mehr da“ – beim Auschecken
  endet die Buchung sofort und der Platz/Raum ist wieder frei. Wer nicht kommt, kann eine laufende Buchung „Freigeben“.
  Laufende Buchungen können nicht mehr storniert werden, damit die genutzte Zeit in der Auswertung erhalten bleibt.
- **Auswertungen** (nur Räume/Plätze, keine Personen) – getrennt für **Arbeitsplätze** und **Besprechungsräume**:
  Auslastung und belegte Stunden, Verlauf je Tag/Woche/Monat/Jahr, Tagesprofil, Wochentage, Spitzenzeiten-Heatmap,
  gleichzeitige Belegung (wie viele Räume/Plätze gleichzeitig), Vollbelegung, automatische Einschätzung
  („reicht die Anzahl?“), Check-in-Quote, nicht wahrgenommene und vorzeitig freigegebene Buchungen,
  Grundlage wählbar: *gebucht* oder *tatsächlich genutzt*, Stunden-Matrix, CSV-Export

## Datenschutz (DSGVO)

- Speicherung nur lokal in `data/opendesksharing.db`; keine Verbindung ins Internet
- Passwörter mit PBKDF2-SHA256 (240.000 Iterationen) gehasht, Sitzungs-Cookie `HttpOnly` + `SameSite=Strict`
- Login-Sperre nach 5 Fehlversuchen (5 Minuten)
- **Namensanzeige nur mit Einwilligung**: Bei jeder Buchung kann die Person anhaken, ob ihr Name am Platz/Raum
  für andere sichtbar ist – standardmäßig **nicht** angehakt (sonst sehen andere nur „belegt“). Nachträglich
  änderbar unter „Meine Buchungen“. Administratoren sehen die Namen zur Verwaltung.
- **Aufbewahrung**: Buchungen werden **nicht automatisch gelöscht** (Entscheidung des Betreibers; die Aufbewahrung
  sollte im Verzeichnis der Verarbeitungstätigkeiten dokumentiert werden)
- **Auskunftsrecht**: jede Person kann unter „Profil“ alle eigenen Daten als JSON exportieren
- **Löschung**: Benutzer löschen entfernt seine Buchungen; für die Auswertung bleibt nur eine anonyme
  Nutzungsangabe (Platz/Raum, Datum, Uhrzeit – ohne Person und Notiz) erhalten
- Keine Zugriffsprotokolle mit IP-Adressen (nur mit `--verbose`)
- Strikte Content-Security-Policy, keine Drittanbieter-Inhalte

## Installation und Updates

Installation und Updates laufen über das Paket `OpenDeskSharing-<Version>.zip`:
entpacken, `Installieren.bat` doppelklicken – Details siehe `LIESMICH.txt` im Paket.
Das Installationsprogramm prüft die Voraussetzungen (Python ab 3.9), richtet den Server als
Hintergrunddienst ein (Start mit „OpenDeskSharing starten.bat“, kein automatischer Start mit Windows)
und sichert vor jedem Update Programm und Datenbank.

Danach im Browser: **https://localhost:8080** bzw. im Netzwerk `https://<Servername>:8080` (HTTPS, Zertifikat wird automatisch erzeugt – siehe LIESMICH.txt).
Bei der Erstinstallation zeigt das Installationsprogramm Benutzername (`admin`) und Startpasswort an.

### Server manuell starten (Entwicklung/Test)

```
python server.py --port 8080 --data D:\ODS\data --log D:\ODS\logs\server.log
python server.py --host 127.0.0.1      nur auf diesem Rechner erreichbar
python server.py --https                HTTPS, Zertifikat automatisch (in <data>	ls)
python server.py --cert c.pem --key k.pem   HTTPS mit eigenem Zertifikat (PEM)
python server.py --version             Version anzeigen
```

Mit `--https` bzw. `--cert` antwortet derselbe Port auf unverschlüsselte Anfragen mit einer Umleitung auf https://.

## Einrichtung in 5 Schritten

1. Als `admin` anmelden und eigenes Passwort setzen
2. **Standorte & Pläne** → Gebäude anlegen → Etage hinzufügen
3. **Raumplan bearbeiten**: Grundriss laden, Räume zeichnen, Typ festlegen, Plätze setzen → Speichern
4. **Benutzer** anlegen (Startpasswort wird angezeigt; Benutzer muss es beim ersten Login ändern)
5. Fertig – Mitarbeitende buchen unter **Buchen** direkt im Plan

## Datensicherung

Vor jedem Update sichert das Installationsprogramm automatisch nach `backup\`. Für eine regelmäßige
Sicherung den Ordner `data\` sichern (am besten bei gestopptem Server, `Neustarten.bat` startet ihn wieder).

## Dateien

```
server.py          Server + API (Python-Standardbibliothek)
static/index.html  Oberfläche
static/app.js      Anwendungslogik inkl. Raumplan-Editor
static/style.css   Gestaltung
VERSION            Versionsnummer
CHANGELOG.md       Änderungsprotokoll
```
