@echo off
setlocal
title OpenDeskSharing - Installation / Update
cd /d "%~dp0"

if not exist "%~dp0setup\install.ps1" (
  echo.
  echo  Die Installationsdateien wurden nicht gefunden.
  echo  Bitte die ZIP-Datei zuerst vollstaendig ENTPACKEN
  echo  und dann Installieren.bat im entpackten Ordner starten.
  echo.
  pause
  exit /b 1
)

rem Administratorrechte anfordern, falls noetig
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Administratorrechte werden angefordert ...
  echo  Bitte die folgende Windows-Abfrage mit "Ja" bestaetigen.
  echo  Die Installation laeuft danach in einem NEUEN Fenster weiter.
  echo.
  if "%~1"=="" (
    powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
  ) else (
    powershell -NoProfile -Command "try { Start-Process -FilePath '%~f0' -ArgumentList '%*' -Verb RunAs -ErrorAction Stop } catch { exit 1 }"
  )
  if errorlevel 1 (
    echo  Die Administratorrechte wurden nicht erteilt - die Installation wurde abgebrochen.
    echo.
    pause
    exit /b 1
  )
  timeout /t 4 >nul
  exit /b
)

rem Modulpfade einer evtl. aufrufenden PowerShell 7 nicht an Windows PowerShell 5.1 vererben
set "PSModulePath="
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup\install.ps1" %*
set RC=%ERRORLEVEL%
echo.
pause
exit /b %RC%
