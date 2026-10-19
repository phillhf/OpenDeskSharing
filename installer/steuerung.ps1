<#
  OpenDeskSharing – Server starten, beenden und Status anzeigen
  Wird über "OpenDeskSharing starten.bat" bzw. "OpenDeskSharing beenden.bat" im Installationsordner
  oder über das Startmenü aufgerufen. Liegt in <Installationsordner>\setup.
#>
[CmdletBinding()]
param(
    [ValidateSet("Start", "Stop", "Status")]
    [string]$Aktion = "Start",
    [switch]$KeinBrowser
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$cfgFile = Join-Path $root "install.json"

function Write-Ok([string]$m) { Write-Host "    [OK] $m" -ForegroundColor Green }
function Write-Warn([string]$m) { Write-Host "    [!]  $m" -ForegroundColor Yellow }
function Write-Fail([string]$m) { Write-Host "    [FEHLER] $m" -ForegroundColor Red }
function Write-Info([string]$m) { Write-Host "    $m" }

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

function Show-LogTail {
    $log = Join-Path $root "logs\server.log"
    if (Test-Path $log) {
        Write-Info ""
        Write-Info "Letzte Einträge aus $log :"
        Get-Content $log -Tail 15 -Encoding UTF8 | ForEach-Object { Write-Host "      $_" -ForegroundColor DarkGray }
    }
}

$exitCode = 0
try {
    if (-not (Test-Path $cfgFile)) { throw "install.json nicht gefunden – liegt dieses Skript im Ordner setup der Installation?" }
    $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $instance = if ($cfg.instance) { [string]$cfg.instance } else { "OpenDeskSharing" }
    $scheme = if ($cfg.https) { "https" } else { "http" }
    $url = "$($scheme)://localhost:$($cfg.port)/"
    $netUrl = "$($scheme)://$([Net.Dns]::GetHostName()):$($cfg.port)/"

    Write-Host ""
    Write-Host "  ============================================" -ForegroundColor White
    Write-Host "   OpenDeskSharing - $(@{ Start = 'Server starten'; Stop = 'Server beenden'; Status = 'Status' }[$Aktion])" -ForegroundColor White
    Write-Host "  ============================================" -ForegroundColor White
    Write-Info "Installationsordner: $root"
    $task = Get-ScheduledTask -TaskName $instance -ErrorAction SilentlyContinue
    if (-not $task) { throw "Die Windows-Aufgabe '$instance' fehlt. Bitte das Installationspaket erneut mit Installieren.bat einspielen (Daten bleiben erhalten)." }

    switch ($Aktion) {
        "Status" {
            $v = Get-Version $cfg
            if ($v) { Write-Ok "Server läuft (Version $v): $url" }
            else { Write-Warn "Server antwortet nicht." }
        }
        "Stop" {
            Stop-ScheduledTask -TaskName $instance -ErrorAction SilentlyContinue
            for ($i = 0; $i -lt 20 -and @(Get-ServerProcesses).Count; $i++) {
                if ($i -eq 6) { Get-ServerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue } }
                Start-Sleep -Milliseconds 500
            }
            if (@(Get-ServerProcesses).Count) { throw "Der Server ließ sich nicht beenden." }
            Write-Ok "Server beendet – wieder starten mit 'OpenDeskSharing starten.bat'"
        }
        "Start" {
            if ($task.State -eq "Disabled") { Enable-ScheduledTask -TaskName $instance | Out-Null }
            $v = Get-Version $cfg
            if ($v) {
                Write-Ok "OpenDeskSharing läuft bereits (Version $v)"
            } else {
                Write-Info "Server wird gestartet ..."
                Stop-ScheduledTask -TaskName $instance -ErrorAction SilentlyContinue
                Get-ServerProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
                $busy = Get-NetTCPConnection -LocalPort $cfg.port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
                if ($busy) {
                    $pn = (Get-Process -Id $busy.OwningProcess -ErrorAction SilentlyContinue).ProcessName
                    throw "Port $($cfg.port) ist durch ein anderes Programm belegt ($pn, PID $($busy.OwningProcess))."
                }
                Start-ScheduledTask -TaskName $instance
                for ($i = 0; $i -lt 40 -and -not $v; $i++) { Start-Sleep -Seconds 1; $v = Get-Version $cfg }
                if (-not $v) { Show-LogTail; throw "Der Server antwortet nach 40 Sekunden noch nicht." }
                Write-Ok "OpenDeskSharing $v läuft"
            }
            Write-Info ""
            Write-Host "      Auf diesem Rechner:  $url" -ForegroundColor Green
            if ($cfg.host -ne "127.0.0.1") { Write-Host "      Im Netzwerk:         $netUrl" -ForegroundColor Green }
            Write-Info ""
            Write-Info "Der Server läuft im Hintergrund weiter, auch wenn dieses Fenster geschlossen wird."
            if (-not $KeinBrowser) { Start-Process $url }
        }
    }
}
catch {
    Write-Fail $_.Exception.Message
    $exitCode = 1
}
exit $exitCode
