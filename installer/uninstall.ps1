<#
  OpenDeskSharing – Deinstallation
  Entfernt Programm, Autostart, Firewall-Regel und Registrierung.
  Datenbank, Sicherungen und Protokolle bleiben erhalten, außer es wird -DeleteData angegeben
  bzw. die Rückfrage mit der Taste J beantwortet.
#>
[CmdletBinding()]
param(
    [switch]$DeleteData,
    [switch]$Unattended,
    [string]$Instance = "OpenDeskSharing"
)
$ErrorActionPreference = "Stop"
$RegKey = "HKLM:\SOFTWARE\$Instance"
$UninstKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\$Instance"
$MarkerFile = Join-Path (Join-Path $env:ProgramData "OpenDeskSharing") "$Instance.installdir.txt"

# ------------------------------------------------------------------ Eingaben (wie im Installationsprogramm)
function Read-Key([string]$Allowed, [string]$Default) {
    while ($true) {
        $c = $null
        try {
            $k = [Console]::ReadKey($true)
            if ($k.Key -eq "Enter") { $c = $Default } else { $c = ([string]$k.KeyChar).ToUpper() }
        } catch {
            $line = [string](Read-Host)
            $c = if ($line.Trim() -eq "") { $Default } else { $line.Trim().Substring(0, 1).ToUpper() }
        }
        if ($c -and $Allowed.Contains($c)) { return $c }
        Write-Host ""
        Write-Host ("      Bitte eine dieser Tasten drücken: " + (($Allowed.ToCharArray() | ForEach-Object { "[$_]" }) -join " ") + "  ") -ForegroundColor Yellow -NoNewline
    }
}

function Ask-YesNo([string]$Question, [bool]$Default, [string]$YesText = "Ja", [string]$NoText = "Nein") {
    if ($Unattended) { return $Default }
    Write-Host ""
    Write-Host "  ? " -ForegroundColor Magenta -NoNewline
    Write-Host $Question -ForegroundColor White
    Write-Host "      [J] $YesText    [N] $NoText    (Enter = $(if ($Default) { $YesText } else { $NoText }))  " -ForegroundColor Cyan -NoNewline
    $k = Read-Key "JN" $(if ($Default) { "J" } else { "N" })
    Write-Host "->  $(if ($k -eq 'J') { $YesText } else { $NoText })" -ForegroundColor Green
    return $k -eq "J"
}

$exitCode = 0
try {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $isAdmin) { throw "Bitte als Administrator ausführen." }

    # Installationsordner: dieses Skript liegt in <Installationsordner>\setup – sonst Registrierung bzw. Merkdatei
    $root = Split-Path -Parent $PSScriptRoot
    if (-not (Test-Path (Join-Path $root "install.json"))) {
        $reg = Get-ItemProperty -Path $RegKey -ErrorAction SilentlyContinue
        if ($reg -and $reg.InstallDir) { $root = $reg.InstallDir }
        elseif (Test-Path $MarkerFile) { $root = (Get-Content $MarkerFile -Raw -Encoding UTF8).Trim() }
    }
    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor White
    Write-Host "   OpenDeskSharing - Deinstallation" -ForegroundColor White
    Write-Host "  ============================================" -ForegroundColor White
    Write-Host "    Installationsordner: $root"
    if (-not $Unattended -and -not (Ask-YesNo "OpenDeskSharing wirklich deinstallieren?" $false "Ja, deinstallieren" "Nein, abbrechen")) {
        Write-Host "    Abgebrochen – es wurde nichts verändert."
        exit 0
    }
    $wipe = $DeleteData -or (Ask-YesNo "Auch Datenbank (alle Buchungen, Benutzer, Pläne), Sicherungen und Protokolle ENDGÜLTIG löschen?" $false "Ja, alles löschen" "Nein, Daten behalten")
    Write-Host ""

    # Server stoppen und Autostart entfernen
    if (Get-ScheduledTask -TaskName $Instance -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $Instance -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $Instance -Confirm:$false
    }
    $pat = (Join-Path $root "app\server.py").ToLower()
    Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($pat) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    Write-Host "    [OK] Server gestoppt, Autostart entfernt" -ForegroundColor Green

    Get-NetFirewallRule -Group $Instance -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
    # Eintrag des eigenen Stammzertifikats auf diesem Rechner entfernen (nur genau dieses, per Fingerabdruck)
    $ij = Join-Path $root "install.json"
    if (Test-Path $ij) {
        $tp = [string](Get-Content $ij -Raw -Encoding UTF8 | ConvertFrom-Json).caThumbprint
        if ($tp -match '^[0-9A-Fa-f]{40}$' -and (Test-Path "Cert:\LocalMachine\Root\$tp")) {
            Remove-Item "Cert:\LocalMachine\Root\$tp" -Force -ErrorAction SilentlyContinue
            Write-Host "    [OK] Stammzertifikat aus dem Zertifikatspeicher entfernt" -ForegroundColor Green
        }
    }
    Remove-Item $UninstKey, $RegKey -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $MarkerFile) { Remove-Item $MarkerFile -Force }
    $lnk = Join-Path ([Environment]::GetFolderPath("CommonDesktopDirectory")) "$Instance.url"
    if (Test-Path $lnk) { Remove-Item $lnk -Force }
    $menu = Join-Path ([Environment]::GetFolderPath("CommonPrograms")) $Instance
    if (Test-Path $menu) { Remove-Item $menu -Recurse -Force }
    Write-Host "    [OK] Firewall-Regel, Registrierung und Verknüpfung entfernt" -ForegroundColor Green

    foreach ($n in @("app", "app.new", "app.old", "install.json", "Deinstallieren.bat", "Neustarten.bat", "OpenDeskSharing starten.bat", "OpenDeskSharing beenden.bat", "OpenDeskSharing-Stammzertifikat.cer")) {
        $p = Join-Path $root $n
        if (Test-Path $p) { Remove-Item $p -Recurse -Force }
    }
    if ($wipe) {
        foreach ($n in @("data", "backup", "logs")) {
            $p = Join-Path $root $n
            if (Test-Path $p) { Remove-Item $p -Recurse -Force }
        }
        Write-Host "    [OK] Daten gelöscht" -ForegroundColor Green
    } else {
        Write-Host "    [OK] Programm entfernt. Datenbank und Sicherungen bleiben erhalten in: $root" -ForegroundColor Green
        Write-Host "         (Eine spätere Neuinstallation in denselben Ordner übernimmt die Daten automatisch.)"
    }
    # Den Ordner mit diesem Skript erst nach dem Beenden entfernen
    $setup = Join-Path $root "setup"
    $cleanup = "timeout /t 2 /nobreak >nul & rmdir /s /q `"$setup`"" + $(if ($wipe) { " & rmdir `"$root`"" } else { "" })
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c $cleanup" -WindowStyle Hidden
}
catch {
    Write-Host "    [FEHLER] $($_.Exception.Message)" -ForegroundColor Red
    $exitCode = 1
}
exit $exitCode
