<#
  OpenDeskSharing – Installation und Update

  Wird über "Installieren.bat" im entpackten Paket gestartet. Erkennt selbstständig, ob
  neu installiert, aktualisiert oder eine alte manuelle Installation übernommen wird.

  Parameter (optional):
    -InstallDir <Pfad>   Installationsordner (Standard: C:\Tools\OpenDeskSharing bzw. bestehende Installation)
    -Port <Zahl>         Port des Webservers (Standard: 8080 bzw. bisheriger Port)
    -BindHost <Adresse>  0.0.0.0 = im Netzwerk erreichbar (Standard), 127.0.0.1 = nur lokal
    -Unattended          ohne Rückfragen (Standardantworten)
    -Force               auch ältere Version einspielen (Downgrade)
    -AllowDownload       fehlendes Python ohne Rückfrage aus dem Internet laden (für -Unattended)
    -NoFirewall          keine Firewall-Regel anlegen
    -NoShortcut          keine Desktop-Verknüpfung anlegen
    -NoHttps             ohne Verschlüsselung (nur http://) – nicht empfohlen
    -TlsNames <Namen>    zusätzliche Namen fürs Zertifikat, z. B. ein DNS-Alias: "buchung.firma.local"
    -NoTrustCert         Stammzertifikat NICHT in den Zertifikatspeicher dieses Rechners eintragen
    -Instance <Name>     interner Name für Aufgabe/Registry/Firewall (Standard: OpenDeskSharing)
    -PredecessorName / -PredecessorDir
                         Vorgängerversion vor der Umbenennung, deren Daten übernommen werden können
                         (Standard: "Raumbuchung" in C:\Tools\Raumbuch)
#>
[CmdletBinding()]
param(
    [string]$InstallDir = "",
    [int]$Port = 0,
    [string]$BindHost = "",
    [switch]$Unattended,
    [switch]$Force,
    [switch]$AllowDownload,
    [switch]$NoFirewall,
    [switch]$NoShortcut,
    [switch]$NoHttps,
    [string]$TlsNames = "",
    [switch]$NoTrustCert,
    [string]$Instance = "OpenDeskSharing",
    [string]$PredecessorName = "Raumbuchung",
    [string]$PredecessorDir = "C:\Tools\Raumbuch"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$PkgRoot = Split-Path -Parent $PSScriptRoot
$DefaultDir = "C:\Tools\OpenDeskSharing"
$PythonMin = [version]"3.9"
$PythonDownloadVersion = "3.12.10"
$KeepBackups = 10
$Stamp = Get-Date -Format "yyyy-MM-dd_HHmmss"
$TempLog = Join-Path $env:TEMP "opendesksharing-install-$Stamp.log"
$RegKey = "HKLM:\SOFTWARE\$Instance"
$UninstKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$Instance"

# ------------------------------------------------------------------ Ausgabe-Helfer
function Write-Step($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Write-Ok($t)   { Write-Host "    [OK] $t" -ForegroundColor Green }
function Write-Info($t) { Write-Host "    $t" }
function Write-Warn($t) { Write-Host "    [!] $t" -ForegroundColor Yellow }
function Write-Fail($t) { Write-Host "    [FEHLER] $t" -ForegroundColor Red }

# ------------------------------------------------------------------ Eingaben
# Alle Fragen: mit "?" markiert, erlaubte Tasten werden immer angezeigt, ein Tastendruck genügt.
function Read-Key([string]$Allowed, [string]$Default) {
    while ($true) {
        $c = $null
        try {
            $k = [Console]::ReadKey($true)
            if ($k.Key -eq "Enter") { $c = $Default } else { $c = ([string]$k.KeyChar).ToUpper() }
        } catch {
            # kein echtes Konsolenfenster (z. B. umgeleitete Eingabe): zeilenweise lesen
            $line = [string](Read-Host)
            $c = if ($line.Trim() -eq "") { $Default } else { $line.Trim().Substring(0, 1).ToUpper() }
        }
        if ($c -and $Allowed.Contains($c)) { return $c }
        Write-Host ""
        Write-Host ("      Bitte eine dieser Tasten drücken: " + (($Allowed.ToCharArray() | ForEach-Object { "[$_]" }) -join " ")) -ForegroundColor Yellow -NoNewline
        Write-Host "  " -NoNewline
    }
}

function Write-Question([string]$Question) {
    Write-Host ""
    Write-Host "  ? " -ForegroundColor Magenta -NoNewline
    Write-Host $Question -ForegroundColor White
}

function Ask-YesNo([string]$Question, [bool]$Default = $true, [string]$YesText = "Ja", [string]$NoText = "Nein") {
    if ($Unattended) { return $Default }
    Write-Question $Question
    Write-Host "      [J] $YesText    [N] $NoText    (Enter = $(if ($Default) { $YesText } else { $NoText }))  " -ForegroundColor Cyan -NoNewline
    $k = Read-Key "JN" $(if ($Default) { "J" } else { "N" })
    Write-Host "->  $(if ($k -eq 'J') { $YesText } else { $NoText })" -ForegroundColor Green
    return $k -eq "J"
}

function Ask-Choice([string]$Question, $Options, [string]$Default) {
    # $Options: Liste von @(Taste, Text)
    if ($Unattended) { return $Default }
    Write-Question $Question
    foreach ($o in $Options) { Write-Host "      [$($o[0])] $($o[1])" }
    Write-Host "      Taste drücken (Enter = $Default)  " -ForegroundColor Cyan -NoNewline
    $k = Read-Key (($Options | ForEach-Object { $_[0] }) -join "") $Default
    Write-Host "->  [$k]" -ForegroundColor Green
    return $k
}

function Ask-Value([string]$Question, [string]$Default, [string]$Hint = "") {
    if ($Unattended) { return $Default }
    Write-Question $Question
    if ($Hint) { Write-Host "      $Hint" -ForegroundColor DarkGray }
    Write-Host "      Eingabe + Enter  (nur Enter = $Default):  " -ForegroundColor Cyan -NoNewline
    $a = ([string](Read-Host)).Trim()
    if ($a -eq "") { return $Default } else { return $a }
}

function Ask-Port([int]$Default) {
    while ($true) {
        $v = Ask-Value "Unter welchem Port soll OpenDeskSharing erreichbar sein?" "$Default" "Zahl zwischen 1024 und 65535 – ohne besonderen Grund einfach Enter drücken."
        if ($v -notmatch '^\d{1,5}$' -or [int]$v -lt 1024 -or [int]$v -gt 65535) {
            if ($Unattended) { throw "Ungültiger Port: $v" }
            Write-Warn "Bitte eine Zahl zwischen 1024 und 65535 eingeben."
            continue
        }
        $busy = Get-NetTCPConnection -LocalPort ([int]$v) -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($busy) {
            $pn = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            if ($Unattended) { throw "Port $v ist belegt ($pn) – bitte mit -Port einen anderen angeben." }
            Write-Warn "Port $v wird bereits von '$pn' benutzt – bitte einen anderen wählen (z. B. $(Get-FreePort ([int]$v + 10)))."
            continue
        }
        return [int]$v
    }
}

function Get-FreePort([int]$Start) {
    for ($p = $Start; $p -lt $Start + 200; $p++) {
        if (-not (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) { return $p }
    }
    return $Start
}

# ------------------------------------------------------------------ Installationsordner
function ConvertTo-CleanPath([string]$p) {
    # Leerzeichen, Anführungszeichen (z. B. aus "Als Pfad kopieren"), Umgebungsvariablen, / statt \
    $p = ([string]$p).Trim().Trim('"').Trim("'").Trim()
    $p = [Environment]::ExpandEnvironmentVariables($p).Replace("/", "\")
    if ($p.Length -gt 3) { $p = $p.TrimEnd("\") }
    if ($p -match '^[A-Za-z]:\\') { try { $p = [IO.Path]::GetFullPath($p) } catch { } }
    return $p
}

function Test-InstallDir([string]$p) {
    # Liefert eine verständliche Fehlermeldung oder $null
    if (-not $p) { return "Es wurde kein Ordner angegeben." }
    if ($p.StartsWith("\\")) { return "Netzwerkpfade werden nicht unterstützt – bitte einen Ordner auf einer lokalen Festplatte wählen (der Dienst läuft als SYSTEM)." }
    if ($p -match '^[A-Za-z]:\\?$') { return "Bitte nicht direkt ins Hauptverzeichnis $p installieren, sondern in einen Unterordner, z. B. $($p.Substring(0, 2))\Tools\OpenDeskSharing." }
    if ($p -notmatch '^[A-Za-z]:\\') { return "Bitte einen vollständigen Pfad mit Laufwerksbuchstaben angeben, z. B. D:\Programme\OpenDeskSharing." }
    if ($p.Substring(2) -match '[<>:"|?*]') { return "Der Pfad enthält ungültige Zeichen (< > : "" | ? *)." }
    $drv = New-Object IO.DriveInfo($p.Substring(0, 1))
    if (-not $drv.IsReady) { return "Das Laufwerk $($p.Substring(0, 2)) ist nicht vorhanden." }
    if ($drv.DriveType -ne "Fixed") { return "Das Laufwerk $($p.Substring(0, 2)) ist keine lokale Festplatte ($($drv.DriveType)) – bitte ein lokales Laufwerk wählen." }
    foreach ($bad in @($env:windir, (Join-Path $env:SystemDrive "Users"))) {
        if ($p -like "$bad*") { return "Unter $bad kann nicht installiert werden – bitte z. B. C:\Tools\OpenDeskSharing verwenden." }
    }
    if ($p.Length -gt 150) { return "Der Pfad ist zu lang (max. 150 Zeichen)." }
    if ((Test-Path -LiteralPath $p) -and -not (Test-Path -LiteralPath $p -PathType Container)) { return "$p ist eine Datei, kein Ordner." }
    return $null
}

function Select-FolderDialog([bool]$AppendLeaf = $true) {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
        $dlg.Description = if ($AppendLeaf) { "Übergeordneten Ordner wählen (z. B. C:\Tools). Darin wird der Unterordner 'OpenDeskSharing' angelegt." } else { "Ordner der vorhandenen OpenDeskSharing-Installation wählen (enthält install.json)." }
        $dlg.ShowNewFolderButton = $true
        $dlg.SelectedPath = if (Test-Path "C:\Tools") { "C:\Tools" } else { "C:\" }
        # unsichtbares Hilfsfenster, damit der Dialog vor dem Konsolenfenster erscheint
        $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; StartPosition = "Manual"; Location = (New-Object System.Drawing.Point(-3000, -3000)); Size = (New-Object System.Drawing.Size(1, 1)) }
        $owner.Show(); $owner.Activate()
        Write-Info "Auswahlfenster ist geöffnet ..."
        $r = $dlg.ShowDialog($owner)
        $owner.Close(); $owner.Dispose()
        if ($r -ne [System.Windows.Forms.DialogResult]::OK -or -not $dlg.SelectedPath) { Write-Info "Keine Auswahl getroffen."; return $null }
        $p = $dlg.SelectedPath
        if ($AppendLeaf -and (Split-Path $p -Leaf) -ne "OpenDeskSharing") { $p = Join-Path $p "OpenDeskSharing" }
        return $p
    } catch {
        Write-Warn "Das Auswahlfenster ist hier nicht verfügbar – bitte den Pfad eintippen."
        return Read-PathInput (-not $AppendLeaf)
    }
}

function Read-PathInput([bool]$Existing = $false) {
    Write-Question $(if ($Existing) { "Ordner der vorhandenen Installation eintippen" } else { "Installationsordner eintippen" })
    Write-Host $(if ($Existing) { "      Beispiel: C:\Tools\OpenDeskSharing   (der Ordner mit app\ und data\; Anführungszeichen sind egal)" } else { "      Beispiel: D:\Programme\OpenDeskSharing   (wird bei Bedarf angelegt; Anführungszeichen sind egal)" }) -ForegroundColor DarkGray
    Write-Host "      Eingabe + Enter  (nur Enter = zurück zur Auswahl):  " -ForegroundColor Cyan -NoNewline
    return ([string](Read-Host)).Trim()
}

function Ask-InstallDir([string]$Suggested) {
    if ($Unattended) {
        $err = Test-InstallDir $Suggested
        if ($err) { throw $err }
        return $Suggested
    }
    while ($true) {
        $c = Ask-Choice "Wo soll OpenDeskSharing installiert werden?" @(
            @("1", "Vorschlag übernehmen:  $Suggested"),
            @("2", "Ordner im Windows-Auswahlfenster suchen"),
            @("3", "Pfad selbst eintippen")) "1"
        $raw = switch ($c) { "1" { $Suggested } "2" { Select-FolderDialog } "3" { Read-PathInput } }
        if (-not $raw) { continue }
        $p = ConvertTo-CleanPath $raw
        $err = Test-InstallDir $p
        if ($err) { Write-Warn $err; continue }
        if (Test-Path (Join-Path $p "data\*.db")) {
            Write-Ok "Der Ordner enthält Daten einer früheren Installation – sie werden übernommen."
        } elseif (Test-Path -LiteralPath $p) {
            $items = @(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue)
            if ($items.Count -gt 0 -and -not (Test-Path (Join-Path $p "install.json"))) {
                Write-Warn "Der Ordner $p existiert bereits und ist nicht leer ($($items.Count) Einträge)."
                if (-not (Ask-YesNo "Trotzdem in diesen Ordner installieren? (vorhandene Dateien bleiben unangetastet)" $false)) { continue }
            }
        }
        Write-Ok "Installationsordner: $p$(if (-not (Test-Path -LiteralPath $p)) { '   (wird neu angelegt)' })"
        return $p
    }
}

# ------------------------------------------------------------------ vorhandene Installation finden
$MarkerDir = Join-Path $env:ProgramData "OpenDeskSharing"
$MarkerFile = Join-Path $MarkerDir "$Instance.installdir.txt"

function Save-Marker([string]$Dir) {
    New-Item -ItemType Directory -Force -Path $MarkerDir | Out-Null
    Set-Content -Path $MarkerFile -Value $Dir -Encoding UTF8
}

function Find-Installation {
    # Reihenfolge: -InstallDir, Registrierung, Merkdatei in ProgramData, Aufgabenplanung, Standardordner
    $cands = New-Object System.Collections.Generic.List[object]
    if ($InstallDir) {
        # ausdrücklich angegebener Ordner: nur dort nachsehen
        $cands.Add(@((ConvertTo-CleanPath $InstallDir), "Parameter -InstallDir"))
    } else {
        $reg = Get-ItemProperty -Path $RegKey -ErrorAction SilentlyContinue
        if ($reg -and $reg.InstallDir) { $cands.Add(@($reg.InstallDir, "Windows-Registrierung (HKLM\SOFTWARE\$Instance)")) }
        if (Test-Path $MarkerFile) { $cands.Add(@((Get-Content $MarkerFile -Raw -Encoding UTF8).Trim(), "Merkdatei $MarkerFile")) }
        $t = Get-ScheduledTask -TaskName $Instance -ErrorAction SilentlyContinue
        if ($t -and $t.Actions[0].WorkingDirectory) { $cands.Add(@((Split-Path -Parent $t.Actions[0].WorkingDirectory), "Windows-Aufgabenplanung (Aufgabe '$Instance')")) }
        $cands.Add(@($DefaultDir, "Standardordner"))
    }
    $script:StaleRefs = @()
    foreach ($c in $cands) {
        $d = $c[0]
        if (-not $d) { continue }
        # Merkstelle zeigt auf einen Ordner ohne Installation -> vermutlich verschoben/umbenannt/gelöscht
        $remembered = $c[1] -notin @("Standardordner", "Parameter -InstallDir")
        if ($remembered -and -not (Test-Path (Join-Path $d "install.json")) -and -not (Test-Path (Join-Path $d "server.py"))) {
            $script:StaleRefs += [pscustomobject]@{ Dir = $d; Source = $c[1] }
            continue
        }
        if (Test-Path (Join-Path $d "install.json")) {
            $j = Get-Content (Join-Path $d "install.json") -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.instance -and $j.instance -ne $Instance) { continue }  # gehört zu einer anderen Installation
            return [pscustomobject]@{ Dir = [IO.Path]::GetFullPath($d); Source = $c[1]; Kind = "installed"; Version = $j.version }
        }
        if (Test-Path (Join-Path $d "server.py")) {
            return [pscustomobject]@{ Dir = [IO.Path]::GetFullPath($d); Source = $c[1]; Kind = "legacy"; Version = "ältere, manuell gestartete Version" }
        }
    }
    return $null
}

function Select-ExistingInstallation {
    # Fragt so lange nach dem Ordner einer vorhandenen Installation, bis einer mit install.json gewählt wird
    while ($true) {
        $c = Ask-Choice "Wo befindet sich die Installation, die aktualisiert werden soll?" @(
            @("1", "Ordner im Windows-Auswahlfenster suchen"),
            @("2", "Pfad selbst eintippen"),
            @("A", "Abbrechen (es wird nichts verändert)")) "1"
        if ($c -eq "A") { throw "Abgebrochen – es wurde nichts verändert." }
        $raw = if ($c -eq "1") { Select-FolderDialog $false } else { Read-PathInput $true }
        if (-not $raw) { continue }
        $p = ConvertTo-CleanPath $raw
        if (Test-Path (Join-Path $p "install.json")) {
            $j = Get-Content (Join-Path $p "install.json") -Raw -Encoding UTF8 | ConvertFrom-Json
            Write-Ok "Installation in $p (Version $($j.version))"
            return [pscustomobject]@{ Dir = [IO.Path]::GetFullPath($p); Source = "manuell ausgewählt"; Kind = "installed"; Version = $j.version }
        }
        Write-Warn "In $p liegt keine OpenDeskSharing-Installation (install.json fehlt). Bitte den Ordner wählen, der app\ und data\ enthält."
    }
}

# ------------------------------------------------------------------ Python
function Test-PythonExe([string]$Exe) {
    # Liefert die Version, wenn Python alle benötigten Module hat, sonst $null
    try {
        $code = "import sys, sqlite3, ssl, json, http.server, hashlib; print('%d.%d.%d' % sys.version_info[:3])"
        $out = & $Exe -c $code 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -match '^\d+\.\d+\.\d+$') { return [version]$out.Trim() }
    } catch { }
    return $null
}

function Find-Python([string]$Preferred) {
    $cands = New-Object System.Collections.Generic.List[string]
    if ($Preferred) { $cands.Add($Preferred) }
    foreach ($hive in @("HKLM:\SOFTWARE\Python\PythonCore", "HKLM:\SOFTWARE\WOW6432Node\Python\PythonCore")) {
        if (Test-Path $hive) {
            foreach ($k in Get-ChildItem $hive) {
                $ip = Get-ItemProperty -Path (Join-Path $k.PSPath "InstallPath") -ErrorAction SilentlyContinue
                if ($ip) {
                    if ($ip.ExecutablePath) { $cands.Add($ip.ExecutablePath) }
                    elseif ($ip.'(default)') { $cands.Add((Join-Path $ip.'(default)' "python.exe")) }
                }
            }
        }
    }
    foreach ($c in Get-Command python.exe -All -ErrorAction SilentlyContinue) { $cands.Add($c.Source) }
    foreach ($p in @("C:\Python3*\python.exe", "C:\Program Files\Python3*\python.exe")) {
        foreach ($f in Get-ChildItem $p -ErrorAction SilentlyContinue) { $cands.Add($f.FullName) }
    }
    $best = $null
    foreach ($exe in ($cands | Select-Object -Unique)) {
        if (-not $exe -or -not (Test-Path $exe)) { continue }
        # Store-Platzhalter und Benutzerprofile ausschließen: der Dienst läuft als SYSTEM
        if ($exe -match "WindowsApps" -or $exe -match "\\Users\\") { continue }
        $v = Test-PythonExe $exe
        if ($v -and $v -ge $PythonMin) {
            if (-not $best -or $v -gt $best.Version) { $best = [pscustomobject]@{ Exe = (Resolve-Path $exe).Path; Version = $v } }
        }
    }
    return $best
}

function Get-PythonChoice {
    # 1 = herunterladen, 2 = manuell, 3 = abbrechen
    if ($AllowDownload) { return "1" }
    if ($Unattended) { return "3" }
    return Ask-Choice "Python fehlt. Wie soll es installiert werden?" @(
        @("1", "Automatisch: Python $PythonDownloadVersion von python.org herunterladen (ca. 26 MB) und installieren"),
        @("2", "Manuell: Ich installiere Python selbst - danach geht es hier weiter"),
        @("3", "Abbrechen")) "1"
}

function Wait-ManualPython {
    Write-Host ""
    Write-Host "    So installieren Sie Python manuell:" -ForegroundColor White
    Write-Info "  1. https://www.python.org/downloads/windows/ öffnen und den 'Windows installer (64-bit)'"
    Write-Info "     einer Version ab $PythonMin herunterladen (z. B. $PythonDownloadVersion)."
    Write-Info "  2. Installer starten, 'Customize installation' wählen, auf der zweiten Seite"
    Write-Info "     'Install Python for all users' anhaken und installieren."
    Write-Info "     WICHTIG: OpenDeskSharing läuft als Systemdienst und braucht eine Installation für"
    Write-Info "     alle Benutzer (z. B. C:\Program Files\Python312), nicht im eigenen Benutzerprofil."
    Write-Info "  3. Danach hier mit der Taste [W] weitermachen."
    if (Ask-YesNo "Download-Seite von Python jetzt im Browser öffnen?" $true) { Start-Process "https://www.python.org/downloads/windows/" }
    $k = Ask-Choice "Python installiert?" @(
        @("W", "Weiter: Python ist installiert - jetzt erneut prüfen"),
        @("A", "Abbrechen")) "W"
    if ($k -eq "A") { throw "Abgebrochen. Nach der Python-Installation einfach Installieren.bat erneut starten." }
}

function Install-Python {
    # Eine Python-Installationsdatei im Paket (setup\python) wird ohne Rückfrage verwendet
    $offline = Get-ChildItem (Join-Path $PkgRoot "setup\python\python-*.exe") -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | Select-Object -First 1
    if ($offline) {
        $exe = $offline.FullName
        Write-Info "Verwende Python-Installationsdatei aus dem Paket: $($offline.Name)"
    } else {
        switch (Get-PythonChoice) {
            "2" { Wait-ManualPython; return }
            "3" { throw "Abgebrochen – Python $PythonMin oder neuer wird benötigt. Nach der Installation von Python Installieren.bat erneut starten." }
        }
        $url = "https://www.python.org/ftp/python/$PythonDownloadVersion/python-$PythonDownloadVersion-amd64.exe"
        $exe = Join-Path $env:TEMP "python-$PythonDownloadVersion-amd64.exe"
        Write-Info "Lade $url ..."
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        try { Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing }
        catch { throw "Download fehlgeschlagen ($($_.Exception.Message)). Ohne Internetzugang bitte Option [2] (manuell) wählen." }
    }
    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne "Valid" -or $sig.SignerCertificate.Subject -notmatch "Python Software Foundation") {
        throw "Die Python-Installationsdatei ist nicht gültig von der Python Software Foundation signiert – Abbruch."
    }
    Write-Ok "Signatur der Python Software Foundation geprüft"
    Write-Info "Installiere Python für alle Benutzer (dauert 1-2 Minuten) ..."
    $pyArgs = @("/quiet", "InstallAllUsers=1", "PrependPath=1", "Include_test=0", "Include_doc=0", "Include_tcltk=0", "Shortcuts=0")
    $p = Start-Process -FilePath $exe -ArgumentList $pyArgs -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "Python-Installation fehlgeschlagen (Rückgabewert $($p.ExitCode))." }
}

# ------------------------------------------------------------------ Dienst (geplante Aufgabe)
function Get-ServerProcesses([string]$Root) {
    $pat = (Join-Path $Root "app\server.py")
    Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($pat.ToLower()) }
}

function Stop-Server([string]$Root) {
    $t = Get-ScheduledTask -TaskName $Instance -ErrorAction SilentlyContinue
    if ($t) { Stop-ScheduledTask -TaskName $Instance -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 20; $i++) {
        $procs = @(Get-ServerProcesses $Root)
        if ($procs.Count -eq 0) { return }
        if ($i -eq 10) { $procs | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
        Start-Sleep -Milliseconds 500
    }
    if (@(Get-ServerProcesses $Root).Count -gt 0) { throw "Der laufende Server konnte nicht beendet werden." }
}

function Get-ManualPort([string]$Dir) {
    # Port eines manuell gestarteten Servers (python server.py --port N) – nur wenn eindeutig, sonst 0
    $lcands = @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "server\.py" -and $_.CommandLine -match "--port\s+\d+" })
    $inDir = @($lcands | Where-Object { $_.CommandLine.ToLower().Contains($Dir.ToLower()) })
    $pick = if ($inDir.Count -eq 1) { $inDir[0] } elseif ($lcands.Count -eq 1) { $lcands[0] } else { $null }
    if ($pick -and $pick.CommandLine -match "--port\s+(\d+)") { return [int]$Matches[1] }
    return 0
}

function Stop-ManualServer([int]$P) {
    $lps = @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match "server\.py" })
    foreach ($lp in $lps) {
        $listen = Get-NetTCPConnection -OwningProcess $lp.ProcessId -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($listen -and $listen.LocalPort -eq $P) {
            if (-not (Ask-YesNo "Der alte, manuell gestartete Server (PID $($lp.ProcessId), Port $P) muss dafür beendet werden. Jetzt beenden?" $true "Ja, beenden" "Nein, abbrechen")) { throw "Abgebrochen – der alte Server muss dafür beendet werden." }
            Stop-Process -Id $lp.ProcessId -Force
            Start-Sleep -Seconds 2
            Write-Ok "Alter Server (Port $P) beendet"
        }
    }
}

function Find-Predecessor {
    # Vorgängerversion vor der Umbenennung: installiert (Aufgabe/Registry) oder manuell im Standardordner
    if ($Instance -eq $PredecessorName) { return $null }
    $dir = $null; $hasTask = $false
    $t = Get-ScheduledTask -TaskName $PredecessorName -ErrorAction SilentlyContinue
    if ($t -and $t.Actions[0].WorkingDirectory) { $dir = Split-Path -Parent $t.Actions[0].WorkingDirectory; $hasTask = $true }
    if (-not $dir) {
        $r = Get-ItemProperty -Path "HKLM:\SOFTWARE\$PredecessorName" -ErrorAction SilentlyContinue
        if ($r -and $r.InstallDir) { $dir = $r.InstallDir }
    }
    if (-not $dir -and ((Test-Path (Join-Path $PredecessorDir "install.json")) -or (Test-Path (Join-Path $PredecessorDir "server.py")))) { $dir = $PredecessorDir }
    if (-not $dir -or -not (Test-Path (Join-Path $dir "data"))) { return $null }
    $pi = [pscustomobject]@{ Dir = [IO.Path]::GetFullPath($dir.TrimEnd("\")); HasTask = $hasTask; Manual = $false; Port = 0; Host = "0.0.0.0" }
    $ij = Join-Path $pi.Dir "install.json"
    if (Test-Path $ij) {
        $j = Get-Content $ij -Raw -Encoding UTF8 | ConvertFrom-Json
        $pi.Port = [int]$j.port
        if ($j.host) { $pi.Host = $j.host }
    } elseif (Test-Path (Join-Path $pi.Dir "server.py")) {
        $pi.Manual = $true
        $pi.Port = Get-ManualPort $pi.Dir
    }
    return $pi
}

function Stop-Predecessor($Pred) {
    if ($Pred.HasTask) { Stop-ScheduledTask -TaskName $PredecessorName -ErrorAction SilentlyContinue }
    $pat = (Join-Path $Pred.Dir "app\server.py").ToLower()
    Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($pat) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($Pred.Manual -and $Pred.Port) { Stop-ManualServer $Pred.Port }
    Start-Sleep -Seconds 1
}

function Remove-Predecessor {
    # Nur Systemeinträge der alten Version entfernen – ihre Dateien bleiben als Sicherung liegen
    if (Get-ScheduledTask -TaskName $PredecessorName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $PredecessorName -Confirm:$false }
    Get-NetFirewallRule -Group $PredecessorName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    foreach ($k in @("HKLM:\SOFTWARE\$PredecessorName", "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$PredecessorName")) {
        if (Test-Path $k) { try { Remove-Item $k -Recurse -Force } catch { } }
    }
    $lnk = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "$PredecessorName.url"
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
}

function Register-ServerTask($Cfg) {
    $root = $Cfg.installDir
    $arg = "`"$root\app\server.py`" --host $($Cfg.host) --port $($Cfg.port) --data `"$root\data`" --log `"$root\logs\server.log`""
    if ($Cfg.https) { $arg += " --https" }
    if ($Cfg.tlsNames) { $arg += " --tls-names `"$($Cfg.tlsNames)`"" }
    $action = New-ScheduledTaskAction -Execute $Cfg.python -Argument $arg -WorkingDirectory "$root\app"
    # Kein automatischer Start: gestartet wird mit "OpenDeskSharing starten.bat". Wer einen Autostart möchte,
    # fügt der Aufgabe selbst einen Auslöser hinzu – solche Auslöser bleiben bei Updates erhalten.
    # (Bis 1.5.1 legte die Installation selbst einen Auslöser "Beim Start" an; der wird einmalig entfernt.)
    $trigger = @()
    $existing = Get-ScheduledTask -TaskName $Instance -ErrorAction SilentlyContinue
    if ($existing -and $Cfg.manualStart -and $Cfg.keepTriggers) { $trigger = @($existing.Triggers | Where-Object { $_ }) }
    $principal = New-ScheduledTaskPrincipal -UserId "S-1-5-18" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    $desc = "OpenDeskSharing Webserver (Port $($Cfg.port)). Start mit 'OpenDeskSharing starten.bat' im Installationsordner. Für einen automatischen Start hier unter 'Trigger' einen Auslöser hinzufügen."
    if ($trigger.Count) {
        Register-ScheduledTask -TaskName $Instance -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $desc -Force | Out-Null
    } else {
        Register-ScheduledTask -TaskName $Instance -Action $action -Principal $principal -Settings $settings -Description $desc -Force | Out-Null
    }
}

function Get-Scheme($Cfg) { if ($Cfg.https) { "https" } else { "http" } }

# Funktionsprüfung über https://127.0.0.1 – das Zertifikat ist dabei evtl. noch nicht eingetragen.
# Nur für 127.0.0.1 wird es ohne Prüfung akzeptiert; alle anderen Adressen werden normal geprüft.
if (-not ("OdsLocalCertPolicy" -as [type])) {
Add-Type -TypeDefinition @"
using System.Net;
using System.Security.Cryptography.X509Certificates;
public class OdsLocalCertPolicy : ICertificatePolicy {
    public bool CheckValidationResult(ServicePoint sp, X509Certificate c, WebRequest r, int problem) {
        return problem == 0 || r.RequestUri.Host == "127.0.0.1";
    }
}
"@
}
[Net.ServicePointManager]::CertificatePolicy = New-Object OdsLocalCertPolicy
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Wait-Health([int]$P, [string]$ExpectVersion, [int]$Seconds = 40, [string]$Scheme = "http") {
    $url = "$($Scheme)://127.0.0.1:$P/api/version"
    for ($i = 0; $i -lt $Seconds; $i++) {
        try {
            $r = Invoke-RestMethod -Uri $url -TimeoutSec 3 -UseBasicParsing
            if (-not $ExpectVersion -or $r.version -eq $ExpectVersion) { return $true }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Show-Diagnosis([string]$Root, [string]$Python) {
    # Fehlerausgaben des Python-Prozesses dürfen hier nicht als Abbruch gelten
    $ErrorActionPreference = "Continue"
    # 1. Lädt das Programm überhaupt? (findet Syntax-/Importfehler, die noch vor dem Log auftreten)
    $out = & $Python -X utf8 (Join-Path $Root "app\server.py") --version 2>&1 | ForEach-Object { "$_" } | Out-String
    if ($LASTEXITCODE -ne 0) {
        Write-Info "Das Programm lässt sich nicht laden:"
        $out.Trim() -split "`n" | Select-Object -Last 12 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
        return
    }
    # 2. sonst: Ende des Server-Logs
    $log = Join-Path $Root "logs\server.log"
    if (Test-Path $log) {
        Write-Info "Letzte Zeilen aus $log :"
        Get-Content $log -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }
}

# ------------------------------------------------------------------ Dateien
function Protect-Folder([string]$Path) {
    # Personenbezogene Daten: nur SYSTEM und Administratoren haben Zugriff
    & icacls $Path /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /Q | Out-Null
}

function Copy-Tree([string]$From, [string]$To) {
    New-Item -ItemType Directory -Force -Path $To | Out-Null
    Copy-Item -Path (Join-Path $From "*") -Destination $To -Recurse -Force
}

function Test-Package {
    $mf = Join-Path $PkgRoot "manifest.json"
    if (-not (Test-Path $mf)) { throw "manifest.json fehlt – das Paket ist unvollständig." }
    $m = Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json
    $bad = @()
    foreach ($p in $m.files.PSObject.Properties) {
        $f = Join-Path $PkgRoot $p.Name
        if (-not (Test-Path $f)) { $bad += "$($p.Name) (fehlt)"; continue }
        $hash = (Get-FileHash -Path $f -Algorithm SHA256).Hash.ToLower()
        if ($hash -ne $p.Value) { $bad += "$($p.Name) (verändert)" }
    }
    if ($bad.Count) { throw "Paket beschädigt: " + ($bad -join ", ") }
    Get-ChildItem $PkgRoot -Recurse -File | Unblock-File -ErrorAction SilentlyContinue
    return $m
}

function Write-Helpers([string]$Root) {
    $setup = Join-Path $Root "setup"
    New-Item -ItemType Directory -Force -Path $setup | Out-Null
    Copy-Item (Join-Path $PkgRoot "setup\uninstall.ps1") $setup -Force
    Copy-Item (Join-Path $PkgRoot "setup\steuerung.ps1") $setup -Force
    $elevate = "net session >nul 2>&1`r`nif errorlevel 1 (`r`n  powershell -NoProfile -Command `"Start-Process -FilePath '%~f0' -Verb RunAs`"`r`n  exit /b`r`n)`r`n"
    $uninst = "@echo off`r`n$elevate" + "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0setup\uninstall.ps1`" -Instance `"$Instance`"`r`npause`r`n"
    $ctl = { param($a) "@echo off`r`ntitle OpenDeskSharing`r`n$elevate" + "powershell -NoProfile -ExecutionPolicy Bypass -File `"%~dp0setup\steuerung.ps1`" -Aktion $a`r`necho.`r`npause`r`n" }
    [IO.File]::WriteAllText((Join-Path $Root "Deinstallieren.bat"), $uninst, [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $Root "OpenDeskSharing starten.bat"), (& $ctl "Start"), [Text.Encoding]::ASCII)
    [IO.File]::WriteAllText((Join-Path $Root "OpenDeskSharing beenden.bat"), (& $ctl "Stop"), [Text.Encoding]::ASCII)
    # bis 1.5.0: Neustarten.bat – ersetzt durch "OpenDeskSharing starten.bat"
    $old = Join-Path $Root "Neustarten.bat"
    if (Test-Path $old) { Remove-Item $old -Force }
}

function Remove-OldBackups([string]$Root) {
    $dirs = @(Get-ChildItem (Join-Path $Root "backup") -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending)
    if ($dirs.Count -gt $KeepBackups) { $dirs | Select-Object -Skip $KeepBackups | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }
}

# ------------------------------------------------------------------ Registrierung
function Register-Program($Cfg) {
    New-Item -Path $RegKey -Force | Out-Null
    Set-ItemProperty -Path $RegKey -Name InstallDir -Value $Cfg.installDir
    Set-ItemProperty -Path $RegKey -Name Version -Value $Cfg.version
    New-Item -Path $UninstKey -Force | Out-Null
    $size = [int]((Get-ChildItem (Join-Path $Cfg.installDir "app") -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
    $props = @{
        DisplayName     = "OpenDeskSharing"
        DisplayVersion  = $Cfg.version
        Publisher       = "OpenDeskSharing"
        InstallLocation = $Cfg.installDir
        UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$($Cfg.installDir)\setup\uninstall.ps1`" -Instance `"$Instance`""
        URLInfoAbout    = "$(Get-Scheme $Cfg)://localhost:$($Cfg.port)"
    }
    foreach ($k in $props.Keys) { Set-ItemProperty -Path $UninstKey -Name $k -Value $props[$k] }
    Set-ItemProperty -Path $UninstKey -Name NoModify -Value 1 -Type DWord
    Set-ItemProperty -Path $UninstKey -Name NoRepair -Value 1 -Type DWord
    Set-ItemProperty -Path $UninstKey -Name EstimatedSize -Value $size -Type DWord
}

function Set-Firewall($Cfg) {
    Get-NetFirewallRule -Group $Instance -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    if ($Cfg.host -eq "127.0.0.1") { return }
    New-NetFirewallRule -DisplayName "OpenDeskSharing (TCP $($Cfg.port))" -Group $Instance -Direction Inbound -Protocol TCP `
        -LocalPort $Cfg.port -Action Allow -Profile Domain, Private | Out-Null
}

function Set-Shortcut($Cfg) {
    $lnk = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "$Instance.url"
    "[InternetShortcut]`r`nURL=$(Get-Scheme $Cfg)://localhost:$($Cfg.port)/`r`n" | Set-Content -Path $lnk -Encoding ASCII
}

function Set-StartMenu($Cfg) {
    # Startmenü-Ordner für alle Benutzer: öffnen, starten, beenden, deinstallieren
    $dir = Join-Path ([Environment]::GetFolderPath("CommonPrograms")) $Instance
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    "[InternetShortcut]`r`nURL=$(Get-Scheme $Cfg)://localhost:$($Cfg.port)/`r`n" | Set-Content -Path (Join-Path $dir "OpenDeskSharing öffnen.url") -Encoding ASCII
    $sh = New-Object -ComObject WScript.Shell
    foreach ($e in @(@("Server starten", "OpenDeskSharing starten.bat"), @("Server beenden", "OpenDeskSharing beenden.bat"), @("Deinstallieren", "Deinstallieren.bat"))) {
        $l = $sh.CreateShortcut((Join-Path $dir "$($e[0]).lnk"))
        $l.TargetPath = Join-Path $Cfg.installDir $e[1]
        $l.WorkingDirectory = $Cfg.installDir
        $l.Save()
    }
}

function Set-CertTrust($Cfg) {
    # Stammzertifikat neben den Installationsordner legen (zum Verteilen per Gruppenrichtlinie)
    # und auf diesem Rechner als vertrauenswürdig eintragen, damit der Browser hier nicht warnt.
    $src = Join-Path $Cfg.installDir "data\tls\OpenDeskSharing-Stammzertifikat.cer"
    if (-not (Test-Path $src)) { Write-Warn "Stammzertifikat nicht gefunden ($src)"; return }
    $pub = Join-Path $Cfg.installDir "OpenDeskSharing-Stammzertifikat.cer"
    Copy-Item $src $pub -Force
    $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 -ArgumentList $pub
    $Cfg.caThumbprint = $cert.Thumbprint
    Write-Ok "Stammzertifikat zum Verteilen: $pub"
    if ($NoTrustCert) { return }
    if (Test-Path "Cert:\LocalMachine\Root\$($cert.Thumbprint)") { Write-Ok "Stammzertifikat ist auf diesem Rechner bereits vertrauenswürdig"; return }
    if (Ask-YesNo "Stammzertifikat auf DIESEM Rechner als vertrauenswürdig eintragen? (Dann zeigt der Browser hier keine Warnung.)" $true "Ja, eintragen" "Nein") {
        Import-Certificate -FilePath $pub -CertStoreLocation Cert:\LocalMachine\Root | Out-Null
        Write-Ok "Stammzertifikat auf diesem Rechner eingetragen"
    }
}

# ================================================================== Ablauf
try { Start-Transcript -Path $TempLog -Force | Out-Null } catch { }
$exitCode = 0
$root = $null
try {
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor White
    Write-Host "   OpenDeskSharing - Installation / Update" -ForegroundColor White
    Write-Host "  ============================================" -ForegroundColor White
    if (-not $Unattended) {
        Write-Host "   Bei jeder Frage (markiert mit ?) stehen die möglichen Tasten dabei," -ForegroundColor DarkGray
        Write-Host "   z. B. [J] Ja  [N] Nein. Ein Tastendruck genügt, Enter = Vorschlag." -ForegroundColor DarkGray
    }

    # --- Voraussetzungen: Rechte, Paket
    Write-Step "Voraussetzungen prüfen"
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { throw "Bitte als Administrator ausführen (Installieren.bat fragt automatisch nach)." }
    Write-Ok "Administratorrechte"
    Write-Ok "PowerShell $($PSVersionTable.PSVersion)"
    $manifest = Test-Package
    $newVersion = [string]$manifest.version
    Write-Ok "Paket vollständig und unverändert (Version $newVersion, $(@($manifest.files.PSObject.Properties).Count) Dateien geprüft)"

    # --- vorhandene Installation suchen (dann Update) – sonst Ordner für die Neuinstallation wählen
    Write-Step "Vorhandene Installation suchen"
    $found = Find-Installation
    if ($found) {
        Write-Info "Gefunden:"
        Write-Info "  Ordner:         $($found.Dir)"
        Write-Info "  Version:        $($found.Version)"
        Write-Info "  Gefunden über:  $($found.Source)"
        if (-not $InstallDir -and -not (Ask-YesNo "Ist das die richtige Installation? Sie wird dann aktualisiert (Daten bleiben erhalten)." $true "Ja, diese aktualisieren" "Nein, anderen Ordner angeben")) {
            $found = Select-ExistingInstallation
        }
        $root = $found.Dir
    } elseif ($script:StaleRefs.Count -gt 0) {
        # Es gab eine Installation, ihr Ordner ist aber nicht mehr da – verschoben, umbenannt oder gelöscht
        Write-Warn "Es gab bereits eine Installation, aber ihr Ordner existiert nicht mehr:"
        foreach ($r in ($script:StaleRefs | Sort-Object Dir -Unique)) { Write-Info "  $($r.Dir)   (laut $($r.Source))" }
        Write-Info "Wurde der Ordner verschoben oder umbenannt? Dann den neuen Ort angeben – das Update"
        Write-Info "trägt ihn anschließend in Autostart, Registrierung und Merkdatei ein."
        if ($Unattended) { throw "Der bisherige Installationsordner wurde nicht gefunden – bitte den neuen Ort mit -InstallDir angeben." }
        $c = Ask-Choice "Wie soll es weitergehen?" @(
            @("1", "Neuen Ort der Installation angeben (Daten bleiben erhalten, wird aktualisiert)"),
            @("2", "Neu installieren (leere Datenbank)"),
            @("A", "Abbrechen (es wird nichts verändert)")) "1"
        if ($c -eq "A") { throw "Abgebrochen – es wurde nichts verändert." }
        if ($c -eq "1") {
            $found = Select-ExistingInstallation
            $root = $found.Dir
        } else {
            $root = Ask-InstallDir $DefaultDir
        }
    } else {
        Write-Info "Keine vorhandene Installation gefunden – OpenDeskSharing wird neu installiert."
        if ($InstallDir) {
            $root = ConvertTo-CleanPath $InstallDir
            $err = Test-InstallDir $root
            if ($err) { throw $err }
        } else {
            $root = Ask-InstallDir $DefaultDir
        }
    }
    $cfgFile = Join-Path $root "install.json"
    $old = $null
    if (Test-Path $cfgFile) { $old = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json }
    $legacy = (-not $old) -and (Test-Path (Join-Path $root "server.py"))
    $mode = if ($old) { "update" } elseif ($legacy) { "legacy" } else { "install" }

    # Vorgängerversion "Raumbuchung" (vor der Umbenennung)?
    $pred = Find-Predecessor
    if ($pred -and $mode -eq "install" -and $pred.Dir -ne $root) {
        Write-Warn "Vorgängerversion '$PredecessorName' gefunden: $($pred.Dir)"
        if (Ask-YesNo "Deren Daten (Benutzer, Räume, Plätze, Buchungen) übernehmen?" $true "Ja, Daten übernehmen" "Nein, leer beginnen") { $mode = "migrate" }
    }
    $usePred = $pred -and ($mode -eq "migrate" -or $pred.Dir -eq $root)

    $cfg = [ordered]@{
        version     = $newVersion
        instance    = $Instance
        installDir  = $root
        host        = if ($BindHost) { $BindHost } elseif ($old) { $old.host } else { "0.0.0.0" }
        port        = if ($Port) { $Port } elseif ($old) { [int]$old.port } else { 8080 }
        python      = if ($old) { $old.python } else { "" }
        https       = if ($NoHttps) { $false } elseif ($old -and $null -ne $old.https) { [bool]$old.https } else { $true }
        manualStart = $true
        # Wahl bei der Installation merken, damit Updates (auch über die Weboberfläche) sie beibehalten
        firewall    = if ($NoFirewall) { $false } elseif ($old -and $null -ne $old.firewall) { [bool]$old.firewall } else { $true }
        shortcuts   = if ($NoShortcut) { $false } elseif ($old -and $null -ne $old.shortcuts) { [bool]$old.shortcuts } else { $true }
        keepTriggers = [bool]($old -and $old.manualStart)
        tlsNames    = if ($TlsNames) { $TlsNames } elseif ($old -and $old.tlsNames) { [string]$old.tlsNames } else { "" }
        caThumbprint = if ($old -and $old.caThumbprint) { [string]$old.caThumbprint } else { "" }
        installedAt = if ($old) { $old.installedAt } else { (Get-Date -Format s) }
        updatedAt   = (Get-Date -Format s)
    }

    switch ($mode) {
        "install" {
            if (-not $Port) { $cfg.port = Ask-Port (Get-FreePort 8080) }
        }
        "update" {
            $cur = [version]$old.version; $nv = [version]$newVersion
            if ($nv -lt $cur -and -not $Force) { throw "Das Paket (Version $newVersion) ist älter als die installierte Version $($old.version). Ein Downgrade ist nur mit Installieren.bat -Force möglich." }
            if ($nv -eq $cur -and -not (Ask-YesNo "Version $newVersion ist bereits installiert. Trotzdem neu einspielen (Reparatur)?" $false "Ja, neu einspielen" "Nein, abbrechen")) { throw "Abgebrochen – es wurde nichts verändert." }
        }
        "legacy" {
            Write-Warn "In $root wurde eine ältere, manuell gestartete Version gefunden (ohne Installation)."
            Write-Info "Sie wird in eine richtige Installation umgewandelt. Die Datenbank bleibt erhalten."
            if (-not $Port) {
                $lp = Get-ManualPort $root
                if (-not $lp -and $Unattended) { throw "Port der alten Version nicht eindeutig erkennbar – bitte mit -Port angeben." }
                $cfg.port = if ($lp) { $lp } else { [int](Ask-Value "Welchen Port nutzt die alte Version in $root?" "8080" "Steht in der Adresse, z. B. http://server:8080 -> 8080") }
            }
        }
        "migrate" {
            Write-Info "Neuinstallation nach $root mit Übernahme der Daten aus $($pred.Dir)."
            Write-Info "Der alte Ordner bleibt unverändert als zusätzliche Sicherung erhalten."
            if (-not $BindHost) { $cfg.host = $pred.Host }
            if (-not $Port) {
                if (-not $pred.Port -and $pred.Manual -and $Unattended) { throw "Port der Vorgängerversion nicht eindeutig erkennbar – bitte mit -Port angeben." }
                $cfg.port = if ($pred.Port) { $pred.Port } else { [int](Ask-Value "Welchen Port nutzt die Vorgängerversion in $($pred.Dir)?" "8080" "Steht in der Adresse, z. B. http://server:8080 -> 8080") }
            }
            if ($pred.Manual -and -not $pred.Port) { $pred.Port = $cfg.port }
        }
    }
    # --- Zusammenfassung vor dem Start
    $what = switch ($mode) {
        "install" { "Neuinstallation" }
        "update"  { if ($old.version -eq $newVersion) { "Reparatur: Version $newVersion neu einspielen (vorher automatische Sicherung)" } else { "Update von Version $($old.version) auf $newVersion (vorher automatische Sicherung)" } }
        "legacy"  { "Umwandlung der manuell gestarteten Version in eine Installation (Daten bleiben erhalten)" }
        "migrate" { "Neuinstallation mit Übernahme der Daten aus $($pred.Dir)" }
    }
    Write-Step "Zusammenfassung"
    Write-Info "Vorgang:             $what"
    Write-Info "Installationsordner: $root$(if (-not (Test-Path -LiteralPath $root)) { '   (wird neu angelegt)' })"
    Write-Info "Adresse:             $(Get-Scheme $cfg)://$([Net.Dns]::GetHostName()):$($cfg.port)$(if ($cfg.host -eq '127.0.0.1') { '   (nur auf diesem Rechner)' } else { '   (im Netzwerk erreichbar)' })"
    if ($cfg.https) {
        Write-Info "Verschlüsselung:     HTTPS mit eigenem Zertifikat (wird beim ersten Start erzeugt)"
        if ($old -and -not $old.https) { Write-Info "                     Neu! Alte Lesezeichen mit http:// werden automatisch umgeleitet." }
    } else {
        Write-Warn "Verschlüsselung:     AUS (-NoHttps) – Passwörter gehen unverschlüsselt durchs Netz"
    }
    Write-Info "Start:               mit 'OpenDeskSharing starten.bat' (kein automatischer Start mit Windows)"
    if (-not (Ask-YesNo "Jetzt starten?" $true "Ja, starten" "Nein, abbrechen")) { throw "Abgebrochen – es wurde nichts verändert." }

    # --- Speicherplatz
    $drive = Get-PSDrive -Name $root.Substring(0, 1) -ErrorAction SilentlyContinue
    if ($drive -and $drive.Free -lt 300MB) { throw "Zu wenig freier Speicher auf Laufwerk $($drive.Name): (mindestens 300 MB)." }
    Write-Ok "Speicherplatz ausreichend"

    # --- Python
    $py = Find-Python $cfg.python
    while (-not $py) {
        Write-Warn "Python $PythonMin oder neuer (für alle Benutzer installiert, mit allen Modulen) wurde nicht gefunden."
        Install-Python
        $py = Find-Python ""
    }
    $cfg.python = $py.Exe
    Write-Ok "Python $($py.Version) mit allen benötigten Modulen: $($py.Exe)"

    # --- laufenden Server beenden
    Write-Step "Laufenden Server beenden"
    if ($mode -eq "update") { Stop-Server $root; Write-Ok "Server gestoppt" }
    if ($mode -eq "legacy") { Stop-ManualServer $cfg.port }
    if ($usePred) { Stop-Predecessor $pred; Write-Ok "Vorgängerversion '$PredecessorName' gestoppt" }
    $busy = Get-NetTCPConnection -LocalPort $cfg.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($busy) {
        $pn = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
        throw "Port $($cfg.port) ist durch ein anderes Programm belegt ($pn, PID $($busy.OwningProcess)). Bitte anderen Port wählen: Installieren.bat -Port 8090"
    }
    Write-Ok "Port $($cfg.port) ist frei"

    # --- Sicherung
    foreach ($d in @("data", "logs", "backup")) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
    if ($mode -eq "migrate") {
        Write-Step "Daten übernehmen"
        if (Get-ChildItem (Join-Path $root "data") -Filter "*.db" -ErrorAction SilentlyContinue) {
            Write-Warn "In $root\data liegt bereits eine Datenbank – es wird nichts überschrieben."
        } else {
            Copy-Item (Join-Path $pred.Dir "data\*") (Join-Path $root "data") -Recurse -Force
            Write-Ok "Daten aus $($pred.Dir)\data übernommen (das Original bleibt dort erhalten)"
        }
    }
    $backupDir = $null
    if ($mode -notin @("install", "migrate")) {
        Write-Step "Sicherung anlegen"
        $label = if ($old) { "v$($old.version)" } else { "manuell" }
        $backupDir = Join-Path $root "backup\$Stamp`_$label"
        New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
        if ($mode -eq "update") {
            Copy-Tree (Join-Path $root "app") (Join-Path $backupDir "app")
            Copy-Item $cfgFile $backupDir
        } else {
            # alte, lose Programmdateien in die Sicherung verschieben (Datenordner bleibt)
            foreach ($n in @("server.py", "static", "start.bat", "start.sh", "README.md", "__pycache__")) {
                $p = Join-Path $root $n
                if (Test-Path $p) { Move-Item $p (Join-Path $backupDir $n) -Force }
            }
        }
        if (Test-Path (Join-Path $root "data\*")) { Copy-Tree (Join-Path $root "data") (Join-Path $backupDir "data") }
        Protect-Folder $backupDir
        Write-Ok "Programm und Datenbank gesichert: $backupDir"
    }

    # --- Programm austauschen
    Write-Step "Programm installieren"
    $appDir = Join-Path $root "app"; $appNew = Join-Path $root "app.new"; $appOld = Join-Path $root "app.old"
    foreach ($p in @($appNew, $appOld)) { if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
    Copy-Tree (Join-Path $PkgRoot "app") $appNew
    if (Test-Path $appDir) { Rename-Item $appDir "app.old" }
    Rename-Item $appNew "app"
    Write-Helpers $root
    Protect-Folder (Join-Path $root "data")
    Protect-Folder (Join-Path $root "backup")
    Protect-Folder (Join-Path $root "logs")  # enthält beim ersten Start das Admin-Passwort
    ($cfg | ConvertTo-Json) | Set-Content -Path $cfgFile -Encoding UTF8
    Write-Ok "Version $newVersion nach $appDir kopiert"

    # --- Dienst, Firewall, Registrierung
    Write-Step "System einrichten"
    Register-ServerTask $cfg
    Write-Ok "Windows-Aufgabe '$Instance' eingerichtet (läuft als SYSTEM, $(if ($cfg.keepTriggers -and @((Get-ScheduledTask -TaskName $Instance).Triggers | Where-Object { $_ }).Count) { 'selbst angelegte Trigger übernommen' } else { 'kein automatischer Start' }))"
    if ($cfg.firewall) { Set-Firewall $cfg; Write-Ok "Firewall-Regel für Port $($cfg.port) (Domäne/Privat)" }
    try { Register-Program $cfg; Write-Ok "Eingetragen unter 'Programme und Features'" }
    catch { Write-Warn "Eintrag unter 'Programme und Features' nicht möglich ($($_.Exception.Message)) – Deinstallation über Deinstallieren.bat im Installationsordner." }
    if ($cfg.shortcuts) {
        Set-Shortcut $cfg; Write-Ok "Desktop-Verknüpfung '$Instance' für alle Benutzer"
        try { Set-StartMenu $cfg; Write-Ok "Startmenü-Ordner '$Instance' (öffnen, Server starten/beenden, deinstallieren)" }
        catch { Write-Warn "Startmenü-Einträge nicht möglich: $($_.Exception.Message)" }
    }

    # --- Starten und prüfen
    Write-Step "Server starten und prüfen"
    Start-ScheduledTask -TaskName $Instance
    if (Wait-Health $cfg.port $newVersion 40 (Get-Scheme $cfg)) {
        Write-Ok "OpenDeskSharing $newVersion läuft$(if ($cfg.https) { ' (HTTPS)' })"
        if ($cfg.https) {
            try { Set-CertTrust $cfg } catch { Write-Warn "Stammzertifikat: $($_.Exception.Message)" }
            ($cfg | ConvertTo-Json) | Set-Content -Path $cfgFile -Encoding UTF8
        }
        Save-Marker $root  # damit spätere Updates den Ordner auch ohne Registrierung finden
        if (Test-Path $appOld) { Remove-Item $appOld -Recurse -Force }
        Remove-OldBackups $root
        if ($usePred) {
            Remove-Predecessor
            Write-Ok "Alte Version '$PredecessorName' abgemeldet (Autostart, Firewall-Regel, Verknüpfung entfernt)"
        }
    } else {
        Write-Fail "Die neue Version antwortet nicht."
        try { Show-Diagnosis $root $cfg.python } catch { Write-Warn "Diagnose nicht möglich: $($_.Exception.Message)" }
        if ($mode -eq "update" -and (Test-Path $appOld)) {
            Write-Step "Automatische Rückkehr zur Version $($old.version)"
            Stop-Server $root
            Remove-Item $appDir -Recurse -Force
            Rename-Item $appOld "app"
            if (Test-Path (Join-Path $backupDir "data")) {
                Remove-Item (Join-Path $root "data\*") -Recurse -Force -ErrorAction SilentlyContinue
                Copy-Item (Join-Path $backupDir "data\*") (Join-Path $root "data") -Recurse -Force
            }
            Copy-Item (Join-Path $backupDir "install.json") $cfgFile -Force
            $oldCfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
            Register-ServerTask $oldCfg
            try { Register-Program $oldCfg } catch { }
            Start-ScheduledTask -TaskName $Instance
            if (Wait-Health $oldCfg.port $oldCfg.version 40 (Get-Scheme $oldCfg)) { Write-Ok "Version $($oldCfg.version) läuft wieder – es ist nichts verloren gegangen." }
            else { Write-Fail "Auch die alte Version startet nicht. Sicherung liegt in $backupDir" }
        }
        elseif ($mode -eq "legacy") {
            Write-Step "Alten Zustand wiederherstellen"
            Stop-Server $root
            Unregister-ScheduledTask -TaskName $Instance -Confirm:$false -ErrorAction SilentlyContinue
            Get-NetFirewallRule -Group $Instance -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
            Remove-Item $UninstKey, $RegKey -Recurse -Force -ErrorAction SilentlyContinue
            foreach ($p in @($appDir, $cfgFile, (Join-Path $root "setup"), (Join-Path $root "Deinstallieren.bat"), (Join-Path $root "OpenDeskSharing starten.bat"), (Join-Path $root "OpenDeskSharing beenden.bat"))) {
                if (Test-Path $p) { Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue }
            }
            foreach ($n in @("server.py", "static", "start.bat", "start.sh", "README.md")) {
                $p = Join-Path $backupDir $n
                if (Test-Path $p) { Move-Item $p (Join-Path $root $n) -Force }
            }
            Write-Ok "Alte Dateien zurückgelegt – der alte Server kann wieder mit start.bat gestartet werden."
        }
        elseif ($mode -eq "migrate") {
            Write-Step "Vorgängerversion wieder aktivieren"
            Stop-Server $root
            Unregister-ScheduledTask -TaskName $Instance -Confirm:$false -ErrorAction SilentlyContinue
            Get-NetFirewallRule -Group $Instance -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
            if ($pred.HasTask) {
                Start-ScheduledTask -TaskName $PredecessorName
                Write-Ok "Die alte Version '$PredecessorName' läuft wieder."
            } else {
                Write-Warn "Bitte die alte Version wieder mit start.bat in $($pred.Dir) starten – ihre Daten sind unverändert."
            }
        }
        throw "Update/Installation fehlgeschlagen. Details: $TempLog"
    }

    # --- Abschluss
    Write-Step "Fertig"
    $hostName = [Net.Dns]::GetHostName()
    Write-Host ""
    Write-Host "    OpenDeskSharing $newVersion ist bereit:" -ForegroundColor Green
    $sch = Get-Scheme $cfg
    Write-Host "      Auf diesem Rechner:  $($sch)://localhost:$($cfg.port)" -ForegroundColor Green
    if ($cfg.host -ne "127.0.0.1") { Write-Host "      Im Netzwerk:         $($sch)://$($hostName):$($cfg.port)" -ForegroundColor Green }
    if ($cfg.https -and $cfg.host -ne "127.0.0.1") {
        Write-Info ""
        Write-Info "Damit die Browser an den Arbeitsplätzen keine Zertifikatswarnung zeigen, das Stammzertifikat"
        Write-Info "  $root\OpenDeskSharing-Stammzertifikat.cer"
        Write-Info "per Gruppenrichtlinie als 'Vertrauenswürdige Stammzertifizierungsstelle' verteilen (siehe LIESMICH.txt)."
    }
    Write-Info ""
    Write-Info "Installationsordner:  $root"
    Write-Info "  app\     Programm (wird bei Updates ersetzt)"
    Write-Info "  data\    Datenbank (bleibt bei Updates erhalten)"
    Write-Info "  backup\  automatische Sicherungen vor jedem Update (die letzten $KeepBackups)"
    Write-Info "  logs\    Protokolle"
    Write-Info ""
    Write-Info "Server starten:  'OpenDeskSharing starten.bat' im Installationsordner"
    Write-Info "                 oder Startmenü > $Instance > Server starten"
    Write-Info "Server beenden:  'OpenDeskSharing beenden.bat' bzw. Startmenü > $Instance > Server beenden"
    if ($usePred -and $pred.Dir -ne $root) {
        Write-Info ""
        Write-Info "Der alte Ordner $($pred.Dir) wird nicht mehr benötigt. Nach einer Kontrolle,"
        Write-Info "ob alle Daten angekommen sind, kann er gelöscht werden."
    }
    $first = Join-Path $root "data\ERSTANMELDUNG.txt"
    if (Test-Path $first) {
        Write-Host ""
        Write-Host "    Erstanmeldung:" -ForegroundColor Yellow
        Get-Content $first -Encoding UTF8 | Where-Object { $_ -match "Benutzername|Passwort:" } | ForEach-Object { Write-Host "      $_" -ForegroundColor Yellow }
    }
    if (-not $Unattended -and (Ask-YesNo "OpenDeskSharing jetzt im Browser öffnen?" $true "Ja, öffnen" "Nein")) { Start-Process "$(Get-Scheme $cfg)://localhost:$($cfg.port)/" }
}
catch {
    Write-Host ""
    Write-Fail $_.Exception.Message
    $exitCode = 1
}
finally {
    try { Stop-Transcript | Out-Null } catch { }
    if ($root -and (Test-Path (Join-Path $root "logs"))) {
        Copy-Item $TempLog (Join-Path $root "logs\install_$Stamp.log") -ErrorAction SilentlyContinue
    }
}
exit $exitCode
