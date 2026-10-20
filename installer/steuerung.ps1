<#
  OpenDeskSharing – Server starten, beenden und Status anzeigen
  Liegt in <Installationsordner>\setup. Aufruf über die Verknüpfungen "OpenDeskSharing" bzw.
  "OpenDeskSharing beenden" (Desktop, Startmenü, Installationsordner) – dann mit -Gui:
  kein Konsolenfenster, Rückmeldung als Windows-Fenster, Administratorrechte werden nur bei Bedarf angefordert.
#>
[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Status")]
    [string]$Aktion = "Start",
    [switch]$KeinBrowser,
    [switch]$Gui
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cfgFile = Join-Path $root "install.json"

function Write-Ok([string]$m) { if (-not $Gui) { Write-Host "    [OK] $m" -ForegroundColor Green } }
function Write-Warn([string]$m) { if (-not $Gui) { Write-Host "    [!]  $m" -ForegroundColor Yellow } }
function Write-Info([string]$m) { if (-not $Gui) { Write-Host "    $m" } }

if ($Gui) {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()
}
function Show-Message([string]$Text, [string]$Icon = "Information") {
    if ($Gui) { [void][System.Windows.Forms.MessageBox]::Show($Text, "OpenDeskSharing", "OK", $Icon) }
    else { Write-Host "    $Text" -ForegroundColor $(if ($Icon -eq "Error") { "Red" } else { "Green" }) }
}

# Funktionsprüfung über https://127.0.0.1 – dort wird das eigene Zertifikat ohne Prüfung akzeptiert
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

function Get-Version($Cfg) {
    $scheme = if ($Cfg.https) { "https" } else { "http" }
    try { return [string](Invoke-RestMethod -Uri "$($scheme)://127.0.0.1:$($Cfg.port)/api/version" -TimeoutSec 3 -UseBasicParsing).version }
    catch { return $null }
}

function Get-ServerProcesses {
    $pat = (Join-Path $root "app\server.py").ToLower()
    Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($pat) }
}

function Get-LogTail {
    $log = Join-Path $root "logs\server.log"
    if (Test-Path $log) { return "`n`nLetzte Einträge aus $log :`n" + ((Get-Content $log -Tail 12 -Encoding UTF8) -join "`n") }
    return ""
}

function Test-Admin {
    ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Startet dieses Skript mit Administratorrechten neu (Windows fragt nach) – ohne Konsolenfenster
function Restart-Elevated {
    $a = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" -Aktion $Aktion"
    if ($Gui) { $a += " -Gui" }
    if ($KeinBrowser) { $a += " -KeinBrowser" }
    try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList $a }
    catch { Show-Message "Ohne Administratorrechte kann OpenDeskSharing nicht gestartet oder beendet werden." "Warning" }
    exit 0
}

# Kleines Fenster "wird gestartet …" mit Laufbalken, während auf den Server gewartet wird
$script:waitForm = $null
function Show-Wait([string]$Text) {
    if (-not $Gui) { Write-Info $Text; return }
    $f = New-Object System.Windows.Forms.Form
    $f.Text = "OpenDeskSharing"; $f.Width = 380; $f.Height = 140; $f.StartPosition = "CenterScreen"
    $f.FormBorderStyle = "FixedDialog"; $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.TopMost = $true
    $ico = Join-Path $PSScriptRoot "app.ico"
    if (Test-Path $ico) { $f.Icon = New-Object System.Drawing.Icon $ico }
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Text; $l.Left = 20; $l.Top = 18; $l.Width = 330; $l.Font = New-Object System.Drawing.Font("Segoe UI", 10)
    $p = New-Object System.Windows.Forms.ProgressBar
    $p.Style = "Marquee"; $p.MarqueeAnimationSpeed = 30; $p.Left = 20; $p.Top = 52; $p.Width = 325; $p.Height = 18
    $f.Controls.AddRange(@($l, $p)); $f.Show(); [System.Windows.Forms.Application]::DoEvents()
    $script:waitForm = $f
}
function Wait-Tick([int]$Ms) {
    $end = [DateTime]::Now.AddMilliseconds($Ms)
    while ([DateTime]::Now -lt $end) { if ($script:waitForm) { [System.Windows.Forms.Application]::DoEvents() }; Start-Sleep -Milliseconds 50 }
}
function Close-Wait { if ($script:waitForm) { $script:waitForm.Close(); $script:waitForm = $null } }

$exitCode = 0
try {
    if (-not (Test-Path $cfgFile)) { throw "install.json nicht gefunden – liegt dieses Skript im Ordner setup der Installation?" }
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $instance = if ($cfg.instance) { [string]$cfg.instance } else { "OpenDeskSharing" }
    $scheme = if ($cfg.https) { "https" } else { "http" }
    $url = "$($scheme)://localhost:$($cfg.port)/"
    $netUrl = "$($scheme)://$([Net.Dns]::GetHostName()):$($cfg.port)/"
    if (-not $Gui) {
        Write-Host ""
        Write-Host "   OpenDeskSharing - $(@{ Start = 'Server starten'; Stop = 'Server beenden'; Status = 'Status' }[$Aktion])" -ForegroundColor White
        Write-Info "Installationsordner: $root"
    }

    # Läuft er schon? Dann reicht der Browser – ohne Administratorrechte
    if ($Aktion -eq "Start") {
        $v = Get-Version $cfg
        if ($v) {
            Write-Ok "OpenDeskSharing läuft bereits (Version $v): $url"
            if (-not $KeinBrowser) { Start-Process $url }
            exit 0
        }
    }
    if ($Aktion -eq "Status") {
        $v = Get-Version $cfg
        if ($v) { Show-Message "OpenDeskSharing läuft (Version $v).`n`n$url" } else { Show-Message "OpenDeskSharing läuft nicht." "Warning" }
        exit 0
    }
    if (-not (Test-Admin)) { if ($Gui) { Restart-Elevated } else { throw "Bitte als Administrator ausführen." } }

    $task = Get-ScheduledTask -TaskName $instance -ErrorAction SilentlyContinue
    if (-not $task) { throw "Die Windows-Aufgabe '$instance' fehlt. Bitte OpenDeskSharing erneut installieren (Daten bleiben erhalten)." }

    if ($Aktion -eq "Stop") {
        Show-Wait "OpenDeskSharing wird beendet …"
        Stop-ScheduledTask -TaskName $instance -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt 20 -and @(Get-ServerProcesses).Count; $i++) {
            if ($i -eq 6) { Get-ServerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
            Wait-Tick 500
        }
        Close-Wait
        if (@(Get-ServerProcesses).Count) { throw "Der Server ließ sich nicht beenden." }
        Show-Message "OpenDeskSharing wurde beendet.`n`nWieder starten: Verknüpfung 'OpenDeskSharing' auf dem Desktop oder im Startmenü."
    } else {
        Show-Wait "OpenDeskSharing wird gestartet …"
        if ($task.State -eq "Disabled") { Enable-ScheduledTask -TaskName $instance | Out-Null }
        Stop-ScheduledTask -TaskName $instance -ErrorAction SilentlyContinue
        Get-ServerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        $busy = Get-NetTCPConnection -LocalPort $cfg.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($busy) {
            $pn = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
            throw "Port $($cfg.port) ist durch ein anderes Programm belegt ($pn, PID $($busy.OwningProcess)).`n`nBitte das andere Programm beenden oder OpenDeskSharing mit dem Setup auf einen anderen Port umstellen."
        }
        Start-ScheduledTask -TaskName $instance
        $v = $null
        for ($i = 0; $i -lt 40 -and -not $v; $i++) { Wait-Tick 1000; $v = Get-Version $cfg }
        Close-Wait
        if (-not $v) { throw "Der Server antwortet nach 40 Sekunden noch nicht.$(Get-LogTail)" }
        Write-Ok "OpenDeskSharing $v läuft"
        Write-Info "Auf diesem Rechner:  $url"
        if ($cfg.host -ne "127.0.0.1") { Write-Info "Im Netzwerk:         $netUrl" }
        if (-not $KeinBrowser) { Start-Process $url }
    }
}
catch {
    Close-Wait
    Show-Message $_.Exception.Message "Error"
    $exitCode = 1
}
exit $exitCode
