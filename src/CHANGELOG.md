# Änderungsprotokoll

## 1.7.0 – 20.10.2026
- **Grafisches Setup** `OpenDeskSharing-Setup-<Version>.exe` (Windows-Installationsassistent statt Konsolenfenster):
  erkennt eine vorhandene Installation und aktualisiert sie, Port mit Prüfung auf belegte Ports (zeigt das
  blockierende Programm), Optionen als Häkchen (Firewall, Verknüpfungen, Zertifikat, Python bei Bedarf automatisch),
  Fortschrittsanzeige, Abschlussseite mit Adresse und Erstanmeldung. Deinstallation über „Apps / Programme und Features“
  mit Rückfrage, ob die Daten gelöscht werden sollen. Stille Installation: `/VERYSILENT` (übernimmt Ordner, Port, Optionen)
- **Verknüpfung „OpenDeskSharing“** (Desktop, Startmenü): startet den Server bei Bedarf und öffnet den Browser –
  ohne Konsolenfenster, mit Fortschrittsfenster; Administratorrechte werden nur angefragt, wenn der Server erst
  gestartet werden muss. „OpenDeskSharing beenden“ entsprechend. Ersetzt die .bat-Dateien
- Eigenes Programmsymbol
- Schutz: Das Installationsprogramm überschreibt niemals einen Ordner, der zu einer anderen Installation gehört
- Das Paket als ZIP mit `Installieren.bat` gibt es weiterhin (z. B. für Server ohne grafische Oberfläche)

## 1.6.0 – 19.10.2026
- **Updates von GitHub:** Unter Einstellungen → System „Nach Updates suchen“ zeigt die neueste Version mit ihren
  Änderungen; „Version … installieren“ lädt das Paket von github.com/phillhf/OpenDeskSharing, prüft die SHA-256-Prüfsumme
  und spielt es mit dem Installationsprogramm ein (Sicherung vorher, automatische Rückkehr bei Fehlern).
  GitHub wird nur bei diesen Klicks kontaktiert – sonst bleibt OpenDeskSharing offline

## 1.5.2 – 02.10.2026
- **Smartphone-Ansicht:**
  - „Meine Buchungen“ und „Alle Buchungen“ als Karten untereinander – „Ich bin da“, „Freigeben“ und „Plan“ direkt erreichbar
  - Kopfzeile einzeilig zum seitlichen Wischen statt drei Zeilen Menü
  - Raumplan wird nicht mehr unlesbar klein verkleinert – Plätze sind antippbar, im Plan seitlich wischen
  - Dialoge als Fenster am unteren Bildschirmrand, größere Tippflächen, Eingabefelder ohne automatisches Hineinzoomen (iPhone)
  - kompaktere Wochenansicht, Kennzahlen der Auswertung zweispaltig, Hinweis im Raumplan-Editor (für den PC gedacht)
- Am PC bleibt die Darstellung unverändert

## 1.5.1 – 01.10.2026
- **Kein automatischer Start mehr mit Windows** – der Server wird mit „OpenDeskSharing starten.bat“ gestartet.
  Wer einen Autostart möchte, legt in der Aufgabenplanung bei der Aufgabe „OpenDeskSharing“ selbst einen Trigger an;
  selbst angelegte Trigger bleiben bei späteren Updates erhalten
- **„OpenDeskSharing starten.bat“** im Installationsordner (ersetzt Neustarten.bat): startet den Server, wartet,
  bis er antwortet, zeigt die Adresse an und öffnet den Browser; läuft er schon, wird nur der Browser geöffnet.
  Bei Problemen werden die letzten Protokolleinträge angezeigt
- **„OpenDeskSharing beenden.bat“** beendet den Server
- **Startmenü-Ordner „OpenDeskSharing“**: öffnen, Server starten, Server beenden, deinstallieren

## 1.5.0 – 25.09.2026
- **Benutzergruppen** (Benutzer → Gruppen): Gruppen anlegen, Mitglieder zuordnen (in der Gruppe oder beim Benutzer),
  ein Benutzer kann in mehreren Gruppen sein. Übersicht, wo eine Gruppe Buchungsrechte hat
- **Buchungsrechte je Gebäude, Etage und Raum:** festlegen, welche Gruppen dort buchen dürfen. Es gilt die nächste Ebene
  mit einer Festlegung (Raum vor Etage vor Gebäude), Arbeitsplätze erben vom Raum, ohne Festlegung darf jeder buchen.
  Administratoren dürfen immer buchen. Gebäude/Etage unter „Standorte & Pläne“, Raum im Raumplan-Editor
- Gesperrte Räume und Plätze bleiben im Plan **sichtbar, aber ausgegraut mit 🔒** und dem Hinweis, für wen sie buchbar
  sind; auch in Wochenansicht, Favoriten und Vorschlägen berücksichtigt. Der Server prüft das Recht bei jeder Buchung
- Bei Windows-Anmeldung kann eine Gruppe optional mit einer **AD-Gruppe verknüpft** werden – die Mitgliedschaft wird
  dann bei jeder Anmeldung aus dem AD übernommen (manuell zugeordnete Mitglieder bleiben)
- Profil zeigt die eigenen Gruppen; der DSGVO-Export enthält sie

## 1.4.2 – 25.09.2026
- **Bedarf melden („Nichts Passendes gefunden“):** Wer keinen passenden Platz oder Raum findet, kann melden, was
  gebraucht worden wäre – Art (Arbeitsplatz/Besprechungsraum), Datum, Uhrzeit, Gebäude, Ausstattung, Personenzahl
  und freier Text. Erreichbar im Vorschlagsdialog (bei keinem Treffer hervorgehoben) und unter „Schnell buchen“.
  Die Meldung wird **anonym** gespeichert (ohne Namen)
- Auswertungen: neue Karte **„Nicht erfüllter Bedarf“** je Arbeitsplätze/Besprechungsräume mit Anzahl, meistgefragter
  Ausstattung, gewünschter Gruppengröße (inkl. Hinweis, wenn größer als der größte Raum), Verteilung nach Uhrzeit
  und Wochentag sowie Liste aller Meldungen; Hinweis in der „Einschätzung“. Einzelne Meldungen können gelöscht werden

## 1.4.1 – 25.09.2026
- Startseite ist jetzt immer **„Meine Buchungen“** (auch nach der Anmeldung); der Menüpunkt steht an erster Stelle,
  mit Knopf **„+ Neue Buchung“** direkt zur Buchungsansicht

## 1.4.0 – 24.09.2026
- **Anmeldung mit Windows-Konto (Active Directory):** Mitarbeiter melden sich mit Windows-Benutzername und
  -Passwort an; Windows prüft das Passwort, OpenDeskSharing speichert es nicht. Einstellbar: Domäne,
  Gruppe mit Zugang, Gruppe der Administratoren (auch verschachtelte Gruppen). Benutzer werden beim ersten
  Anmelden automatisch angelegt, Anzeigename und Rolle bei jeder Anmeldung aus dem AD übernommen.
  Mit **„Anmeldung testen“** lassen sich die Einstellungen vorher prüfen, verständliche Meldungen
  (z. B. Konto gesperrt, Passwort abgelaufen, nicht in der Gruppe)
- Benutzerverwaltung: Anmeldeart je Benutzer (Windows-Konto oder eigenes Passwort), bestehende Benutzer
  lassen sich mit allen Buchungen auf Windows-Anmeldung umstellen; lokales „admin“ bleibt als Notzugang
- **HTTPS:** eigenes Stammzertifikat und Serverzertifikat werden automatisch erzeugt und erneuert (ohne
  Zusatzprogramme); http:// wird auf https:// umgeleitet, alte Lesezeichen funktionieren weiter;
  Stammzertifikat zum Verteilen per Gruppenrichtlinie (Installationsordner, Anmeldeseite, Einstellungen)
- Installation: HTTPS standardmäßig an, Stammzertifikat auf Rückfrage auf dem Server eintragen,
  neue Optionen -TlsNames und -NoHttps; Deinstallation entfernt den Zertifikatseintrag wieder

## 1.3.2 – 24.09.2026
- Installationsordner verschoben oder umbenannt: Das Paket erkennt, dass die gemerkte Installation nicht mehr
  am alten Ort liegt, zeigt den alten Pfad an und lässt den neuen Ort wählen. Das Update trägt den neuen Ordner
  in Autostart, Registrierung und Merkdatei ein (bisher wurde fälschlich eine Neuinstallation angeboten)

## 1.3.1 – 24.09.2026
Installationsprogramm überarbeitet:
- Alle Fragen sind mit **?** markiert und zeigen die Tasten an, z. B. **[J] Ja  [N] Nein  (Enter = Ja)**;
  ein Tastendruck genügt, falsche Tasten werden mit Hinweis ignoriert
- Installationsordner: Vorschlag übernehmen, **Windows-Auswahlfenster** oder Pfad eintippen; der Pfad wird bereinigt
  (Anführungszeichen, Leerzeichen) und geprüft (Laufwerk vorhanden, lokale Festplatte, kein Systemordner,
  Warnung bei nicht leerem Ordner)
- Port wird sofort auf Gültigkeit und Belegung geprüft, freier Port wird vorgeschlagen
- **Zusammenfassung vor dem Start** (Vorgang, Ordner „wird neu angelegt“, Adresse) mit „Jetzt starten?“
- Update: zeigt an, **wo** die Installation gefunden wurde und **woher** das bekannt ist
  (Registrierung, Merkdatei, Aufgabenplanung, Standardordner) und fragt nach; alternativ Ordner selbst wählen
- Zusätzliche Merkdatei `C:\ProgramData\OpenDeskSharing\OpenDeskSharing.installdir.txt`, damit Updates den Ordner
  auch ohne Registrierung finden
- Deinstallation mit denselben klaren Tastenabfragen

## 1.3.0 – 24.09.2026
- **Gesetzliche Feiertage automatisch:** einmal das Bundesland wählen (Standard in den Einstellungen,
  abweichend je Gebäude unter „Standorte & Pläne“) – die Feiertage gelten dann für jedes Jahr automatisch,
  kein jährliches Eintragen mehr
- Vorschau der Feiertage der nächsten 12 Monate; einzelne Feiertage lassen sich **ausnehmen**
  (z. B. bei geänderter Rechtslage) und wieder aktivieren
- Manuelle Einträge nur noch als Rückfallebene: Schließtage/Betriebsurlaub und zusätzliche Feiertage
- Früher per Knopf eingetragene gesetzliche Feiertage werden beim Update automatisch entfernt (keine Doppelten)

## 1.2.0 – 24.09.2026
- **Schnell buchen & Favoriten:** Plätze und Räume im Buchungsdialog mit ☆ merken; auf der Buchen-Seite
  zeigt „Schnell buchen“ die Favoriten mit Status und bucht Plätze mit einem Klick
- **Freien Platz vorschlagen:** sucht passende freie Plätze (gewünschte Ausstattung, Gebäude) –
  Favoriten und häufig genutzte Plätze zuerst, direkt buchbar
- **Wochenansicht:** Umschalter „Raumplan | Woche“; alle Plätze und Räume einer Etage für Mo–Fr,
  beliebige freie Felder anklicken (auch „ganze Woche“) und gemeinsam buchen
- **Feiertage & Schließtage:** gesetzliche Feiertage je Bundesland offline berechnet und per Knopf eingetragen,
  eigene Schließtage/Betriebsurlaub, optional je Gebäude; keine Buchungen an diesen Tagen, Hinweis im Plan,
  in der Auswertung nicht als buchbare Tage gezählt
- **Teilnehmerzahl bei Raumbuchungen** (Pflichtangabe, geprüft gegen die Kapazität); Auswertung:
  Ø Teilnehmer, Sitzplatz-Auslastung, Gruppengrößen, Hinweise auf zu große oder zu kleine Räume

## 1.1.0 – 24.09.2026
- **Neuer Name: OpenDeskSharing** (vorher „Raumbuchung“): Oberfläche, Paket, Dienst,
  Standardordner `C:\Tools\OpenDeskSharing`, Datenbank `opendesksharing.db`
- Übernahme der Vorgängerversion „Raumbuchung“ (manuell gestartet oder installiert):
  Daten werden auf Rückfrage übernommen, der alte Server gestoppt und abgemeldet, der alte Ordner bleibt
  als Sicherung erhalten. Die alte Datenbankdatei wird beim Start automatisch umbenannt.
- Fehlt Python, fragt die Installation: automatisch herunterladen, manuell installieren
  (mit Anleitung, danach wird erneut geprüft) oder abbrechen
- Nach dem Update ist eine erneute Anmeldung nötig (neuer Sitzungs-Cookie)

## 1.0.0 – 24.09.2026
Erste Version als installierbares Paket.

- Installation mit Prüfung der Voraussetzungen (Python inkl. Module, Port, Administratorrechte);
  fehlendes Python wird automatisch installiert
- Betrieb im Hintergrund: startet automatisch mit Windows, ohne Anmeldung, Neustart nach Absturz
- Updates per Paket mit automatischer Sicherung von Programm und Datenbank und automatischer
  Rückkehr zur alten Version, falls die neue nicht startet
- Eintrag unter „Programme und Features“, Deinstallation (Daten bleiben erhalten)
- Logdatei `logs\server.log`, Versionsanzeige unter Einstellungen → System

Enthaltener Funktionsumfang:
- Benutzer, Gebäude, Etagen, Räume, Arbeitsplätze, grafischer Raumplan-Editor mit Grundriss
- Buchen im Raumplan, Serienbuchungen, Ausstattungsmerkmale mit Filter
- Name am Platz/Raum nur mit Häkchen der buchenden Person
- Check-in „Ich bin da“ / Check-out „Ich bin nicht mehr da“, Freigeben laufender Buchungen
- Auswertungen für Arbeitsplätze und Besprechungsräume (Auslastung, Spitzenzeiten, gleichzeitige Belegung,
  Check-in-Quote), CSV-Export
