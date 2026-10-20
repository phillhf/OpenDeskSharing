; OpenDeskSharing – grafisches Setup (Inno Setup 6)
; Gebaut von build.py:  ISCC.exe /DAppVersion=x.y.z /DPkgDir=<entpacktes Paket> installer\OpenDeskSharing.iss
;
; Das Setup ist die Oberfläche; die eigentliche Arbeit (Python prüfen, Sicherung, Programm austauschen,
; Windows-Aufgabe, Firewall, HTTPS, automatische Rückkehr bei Fehlern) erledigt das bewährte setup\install.ps1,
; das unsichtbar im Hintergrund läuft.
; Stilles Update:  OpenDeskSharing-Setup-x.y.z.exe /VERYSILENT  (übernimmt Ordner, Port und Optionen)
; Weitere Parameter (z. B. für eine stille Neuinstallation): /DIR="D:\OpenDeskSharing" /PORT=8090
;   /NOFIREWALL=1 /NOSHORTCUTS=1 /NOCERT=1 /PYTHON=1 (Python bei Bedarf automatisch installieren)

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
; Nur für Tests: andere Instanz (eigene Windows-Aufgabe, eigener Ordner) – berührt keine echte Installation
#ifndef Instance
  #define Instance "OpenDeskSharing"
  #define AppGuid "8F3C2A61-5B7D-4E2A-9C41-0D6E2B7A3F15"
#endif
#ifndef PkgDir
  #define PkgDir "..\dist\_build\OpenDeskSharing-" + AppVersion
#endif

[Setup]
AppId={{{#AppGuid}}
AppName=OpenDeskSharing
AppVersion={#AppVersion}
AppVerName=OpenDeskSharing {#AppVersion}
AppPublisher=OpenDeskSharing
AppPublisherURL=https://github.com/phillhf/OpenDeskSharing
AppSupportURL=https://github.com/phillhf/OpenDeskSharing
AppUpdatesURL=https://github.com/phillhf/OpenDeskSharing/releases
VersionInfoVersion={#AppVersion}
VersionInfoDescription=OpenDeskSharing Setup
DefaultDirName=C:\Tools\OpenDeskSharing
AppendDefaultDirName=no
DirExistsWarning=no
UsePreviousAppDir=no
DisableProgramGroupPage=yes
DisableWelcomePage=no
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=OpenDeskSharing-Setup-{#AppVersion}
SetupIconFile=app.ico
WizardImageFile=wizard-image.bmp,wizard-image-2x.bmp
WizardSmallImageFile=wizard-small.bmp,wizard-small-2x.bmp
WizardStyle=modern
WizardSizePercent=110
UninstallDisplayName=OpenDeskSharing
UninstallDisplayIcon={uninstallexe}
Compression=lzma2/max
SolidCompression=yes
CloseApplications=no
RestartApplications=no

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"

[Messages]
de.WelcomeLabel1=Willkommen bei OpenDeskSharing
de.FinishedHeadingLabel=OpenDeskSharing ist eingerichtet

[Files]
; Paket nur entpacken – install.ps1 kopiert es selbst an die richtige Stelle (mit Sicherung)
Source: "{#PkgDir}\*"; DestDir: "{tmp}\pkg"; Flags: recursesubdirs createallsubdirs ignoreversion
; für die Erkennung vor dem Assistenten
Source: "{#PkgDir}\setup\install.ps1"; Flags: dontcopy

[Icons]
Name: "{commonprograms}\{#Instance}\OpenDeskSharing deinstallieren"; Filename: "{uninstallexe}"; Check: WantShortcuts

[Run]
Filename: "{code:GetUrl}"; Description: "OpenDeskSharing jetzt im Browser öffnen"; Flags: postinstall shellexec nowait skipifsilent runasoriginaluser; Check: InstallOk

[Code]
var
  Found, Python, PyVersion, OldDir, OldVersion, OldPort, OldKind, Stale, Predecessor, PrevFirewall, PrevShortcuts, DetectError: String;
  PortPage: TInputQueryWizardPage;
  OptPage: TInputOptionWizardPage;
  ProgressPage: TOutputMarqueeProgressWizardPage;
  Ok: Boolean;
  LogFile, Login: String;
  OptFirewall, OptShortcuts, OptCert, OptPython: Integer;

function PowerShellExe(): String;
begin
  Result := ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe');
end;

function Value(const Lines: TArrayOfString; const Key: String): String;
var
  I: Integer;
  L: String;
begin
  Result := '';
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    L := Lines[I];
    if (Length(L) > 0) and (L[1] = #$FEFF) then L := Copy(L, 2, Length(L));
    if Pos(Key + '=', L) = 1 then
    begin
      Result := Trim(Copy(L, Length(Key) + 2, Length(L)));
      Exit;
    end;
  end;
end;

// Vor dem Assistenten: vorhandene Installation, Port, Optionen und Python erkennen (install.ps1 -Detect)
function InitializeSetup(): Boolean;
var
  Code: Integer;
  F: String;
  Lines: TArrayOfString;
begin
  Result := True;
  ExtractTemporaryFile('install.ps1');
  F := ExpandConstant('{tmp}\detect.txt');
  Exec(ExpandConstant('{cmd}'), '/S /C "set "PSModulePath=" & "' + PowerShellExe() + '" -NoProfile -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\install.ps1') + '" -Instance "{#Instance}" -Detect -DetectFile "' + F + '""', '', SW_HIDE, ewWaitUntilTerminated, Code);
  if LoadStringsFromFile(F, Lines) then
  begin
    Found := Value(Lines, 'found');
    OldDir := Value(Lines, 'dir');
    OldVersion := Value(Lines, 'version');
    OldKind := Value(Lines, 'kind');
    OldPort := Value(Lines, 'port');
    Stale := Value(Lines, 'stale');
    Predecessor := Value(Lines, 'predecessor');
    PrevFirewall := Value(Lines, 'firewall');
    PrevShortcuts := Value(Lines, 'shortcuts');
    Python := Value(Lines, 'python');
    PyVersion := Value(Lines, 'pyversion');
    DetectError := Value(Lines, 'error');
  end else
    DetectError := 'Die Erkennung konnte nicht ausgeführt werden.';
end;

function IsUpdate(): Boolean;
begin
  Result := Found = '1';
end;

procedure InitializeWizard;
var
  T: String;
begin
  if IsUpdate() then
  begin
    WizardForm.DirEdit.Text := OldDir;
    T := 'OpenDeskSharing ' + OldVersion + ' ist bereits installiert in' + #13#10 + OldDir + #13#10#13#10 +
      'Das Setup aktualisiert auf Version {#AppVersion}. Datenbank, Benutzer, Pläne und Buchungen bleiben erhalten – ' +
      'Programm und Datenbank werden vorher automatisch gesichert. Sollte etwas schiefgehen, wird die bisherige Version ' +
      'automatisch wiederhergestellt.';
  end else
  begin
    T := 'Dieses Setup installiert OpenDeskSharing {#AppVersion} – das lokale Buchungssystem für Arbeitsplätze und ' +
      'Besprechungsräume.' + #13#10#13#10 +
      'OpenDeskSharing läuft komplett auf diesem Rechner, ohne Cloud. Mitarbeiter buchen danach im Browser.';
    if Stale <> '' then
      T := T + #13#10#13#10 + 'Hinweis: Eine frühere Installation war in ' + Stale + ' – dieser Ordner existiert nicht mehr. ' +
        'Wurde er verschoben, im nächsten Schritt den neuen Ort auswählen; die Daten werden dort übernommen.';
    if Predecessor <> '' then
      T := T + #13#10#13#10 + 'Die Vorgängerversion "Raumbuchung" in ' + Predecessor + ' wurde gefunden – ihre Daten werden übernommen.';
  end;
  if DetectError <> '' then T := T + #13#10#13#10 + 'Hinweis: ' + DetectError;
  WizardForm.WelcomeLabel2.Caption := T;

  PortPage := CreateInputQueryPage(wpSelectDir, 'Netzwerk', 'Unter welchem Port soll OpenDeskSharing erreichbar sein?',
    'Mitarbeiter öffnen OpenDeskSharing danach im Browser unter https://' + GetComputerNameString() + ':<Port>' + #13#10 +
    'Ohne besonderen Grund den Vorschlag übernehmen.');
  PortPage.Add('Port (1024–65535):', False);
  if OldPort <> '' then PortPage.Values[0] := OldPort else PortPage.Values[0] := '8080';
  if ExpandConstant('{param:PORT|}') <> '' then PortPage.Values[0] := ExpandConstant('{param:PORT|}');

  OptPage := CreateInputOptionPage(PortPage.ID, 'Optionen', 'Was soll das Setup zusätzlich einrichten?', '', False, False);
  OptFirewall := OptPage.Add('Zugriff aus dem Netzwerk erlauben (Regel in der Windows-Firewall)');
  OptShortcuts := OptPage.Add('Verknüpfung "OpenDeskSharing" auf dem Desktop und im Startmenü');
  OptCert := OptPage.Add('Eigenes Zertifikat auf diesem Rechner als vertrauenswürdig eintragen (keine Browser-Warnung hier)');
  OptPage.Values[OptFirewall] := PrevFirewall <> '0';
  OptPage.Values[OptShortcuts] := PrevShortcuts <> '0';
  OptPage.Values[OptCert] := ExpandConstant('{param:NOCERT|0}') <> '1';
  if ExpandConstant('{param:NOFIREWALL|0}') = '1' then OptPage.Values[OptFirewall] := False;
  if ExpandConstant('{param:NOSHORTCUTS|0}') = '1' then OptPage.Values[OptShortcuts] := False;
  OptPython := -1;
  if Python = '' then
  begin
    OptPython := OptPage.Add('Python (wird benötigt, fehlt auf diesem Rechner) automatisch von python.org laden und installieren – ca. 26 MB');
    OptPage.Values[OptPython] := not WizardSilent() or (ExpandConstant('{param:PYTHON|0}') = '1');
  end;
  ProgressPage := CreateOutputMarqueeProgressPage('OpenDeskSharing wird eingerichtet', 'Bitte warten – das dauert meist weniger als eine Minute.');
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // Bei einem Update bleibt der Ordner – nur bei einer Neuinstallation fragen
  Result := (PageID = wpSelectDir) and IsUpdate();
end;

// Port belegt? Unser eigener Server (python) zählt bei einem Update nicht
function PortOwner(Port: Integer): String;
var
  Tmp, L, Pid: String;
  Lines, T: TArrayOfString;
  I, P, Code: Integer;
begin
  Result := '';
  Tmp := ExpandConstant('{tmp}\ports.txt');
  if not Exec(ExpandConstant('{cmd}'), '/C netstat -ano -p TCP > "' + Tmp + '"', '', SW_HIDE, ewWaitUntilTerminated, Code) then Exit;
  if not LoadStringsFromFile(Tmp, Lines) then Exit;
  for I := 0 to GetArrayLength(Lines) - 1 do
  begin
    L := Trim(Lines[I]);
    if (Pos(':' + IntToStr(Port) + ' ', L) > 0) and (Pos(' 0.0.0.0:0 ', L + ' ') + Pos(' [::]:0 ', L + ' ') + Pos('*:*', L) > 0) then
    begin
      // letzte Spalte = Prozess-ID
      P := Length(L);
      while (P > 0) and (L[P] <> ' ') do P := P - 1;
      Pid := Copy(L, P + 1, Length(L));
      if StrToIntDef(Pid, 0) = 0 then Continue;
      Tmp := ExpandConstant('{tmp}\proc.txt');
      Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "PID eq ' + Pid + '" /FO CSV /NH > "' + Tmp + '"', '', SW_HIDE, ewWaitUntilTerminated, Code);
      Result := 'PID ' + Pid;
      if LoadStringsFromFile(Tmp, T) and (GetArrayLength(T) > 0) and (Pos('"', T[0]) = 1) then
        Result := Copy(T[0], 2, Pos('",', T[0]) - 2) + ' (PID ' + Pid + ')';
      Exit;
    end;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Port: Integer;
  Owner, D: String;
  J: AnsiString;
begin
  Result := True;
  if CurPageID = wpSelectDir then
  begin
    D := WizardForm.DirEdit.Text;
    if (Copy(D, 1, 2) = '\\') or (Length(D) <= 3) then
    begin
      MsgBox('Bitte einen Unterordner auf einer lokalen Festplatte wählen, z. B. C:\Tools\OpenDeskSharing.', mbError, MB_OK);
      Result := False;
    end
    // Ordner einer anderen Installation (andere Instanz) nie überschreiben
    else if LoadStringFromFile(AddBackslash(D) + 'install.json', J) and (Pos('"instance"', J) > 0) and (Pos('"{#Instance}"', J) = 0) then
    begin
      MsgBox('In ' + D + ' liegt bereits eine andere OpenDeskSharing-Installation. Bitte einen anderen Ordner wählen.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if CurPageID = PortPage.ID then
  begin
    Port := StrToIntDef(Trim(PortPage.Values[0]), 0);
    if (Port < 1024) or (Port > 65535) then
    begin
      MsgBox('Bitte einen Port zwischen 1024 und 65535 eingeben.', mbError, MB_OK);
      Result := False;
      Exit;
    end;
    Owner := PortOwner(Port);
    if (Owner <> '') and (Pos('python', Lowercase(Owner)) = 1) and IsUpdate() and (IntToStr(Port) = OldPort) then Owner := '';
    if Owner <> '' then
    begin
      MsgBox('Port ' + IntToStr(Port) + ' wird bereits von einem anderen Programm verwendet: ' + Owner + '.' + #13#10#13#10 +
        'Bitte einen anderen Port wählen, z. B. ' + IntToStr(Port + 10) + '.', mbError, MB_OK);
      Result := False;
    end;
  end;
  if (CurPageID = OptPage.ID) and (OptPython >= 0) and not OptPage.Values[OptPython] then
  begin
    MsgBox('OpenDeskSharing benötigt Python (ab Version 3.9).' + #13#10#13#10 +
      'Entweder den Haken bei "Python automatisch ... installieren" setzen oder Python selbst von python.org installieren ' +
      '(dabei "Install for all users" wählen) und dieses Setup danach erneut starten.', mbInformation, MB_OK);
    Result := False;
  end;
end;

function YesNo(B: Boolean): String;
begin
  if B then Result := 'ja' else Result := 'nein';
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  if IsUpdate() then
    Result := 'Vorgang:' + NewLine + Space + 'Update von ' + OldVersion + ' auf {#AppVersion} (vorher automatische Sicherung)'
  else
    Result := 'Vorgang:' + NewLine + Space + 'Neuinstallation von OpenDeskSharing {#AppVersion}';
  Result := Result + NewLine + NewLine + 'Ordner:' + NewLine + Space + WizardForm.DirEdit.Text +
    NewLine + NewLine + 'Adresse:' + NewLine + Space + 'https://' + GetComputerNameString() + ':' + Trim(PortPage.Values[0]) +
    NewLine + NewLine + 'Optionen:' + NewLine +
    Space + 'Firewall-Regel: ' + YesNo(OptPage.Values[OptFirewall]) + NewLine +
    Space + 'Verknüpfungen: ' + YesNo(OptPage.Values[OptShortcuts]) + NewLine +
    Space + 'Zertifikat auf diesem Rechner vertrauen: ' + YesNo(OptPage.Values[OptCert]);
  if OptPython >= 0 then Result := Result + NewLine + Space + 'Python installieren: ' + YesNo(OptPage.Values[OptPython])
  else Result := Result + NewLine + NewLine + 'Python:' + NewLine + Space + PyVersion + ' (' + Python + ')';
end;

function GetUrl(Param: String): String;
begin
  Result := 'https://localhost:' + Trim(PortPage.Values[0]) + '/';
end;

function WantShortcuts(): Boolean;
begin
  Result := OptPage.Values[OptShortcuts];
end;

function InstallOk(): Boolean;
begin
  Result := Ok;
end;

function ReadFirstLine(const F: String): String;
var
  L: TArrayOfString;
begin
  Result := '';
  if LoadStringsFromFile(F, L) and (GetArrayLength(L) > 0) then Result := Trim(L[0]);
end;

function LogTail(const F: String; N: Integer): String;
var
  L: TArrayOfString;
  I, S: Integer;
begin
  Result := '';
  if not LoadStringsFromFile(F, L) then Exit;
  S := GetArrayLength(L) - N;
  if S < 0 then S := 0;
  for I := S to GetArrayLength(L) - 1 do Result := Result + L[I] + #13#10;
end;

// Nach dem Entpacken: install.ps1 unsichtbar ausführen und dabei den aktuellen Schritt anzeigen
procedure RunInstaller();
var
  Args, Done, Prog, Step, Line, Cred: String;
  Code, I: Integer;
  Lines: TArrayOfString;
begin
  LogFile := ExpandConstant('{tmp}\install-ausgabe.log');
  Done := ExpandConstant('{tmp}\fertig.txt');
  Prog := ExpandConstant('{tmp}\schritt.txt');
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{tmp}\pkg\setup\install.ps1') + '" -Unattended -NoUninstallEntry -Instance "{#Instance}"' +
    ' -InstallDir "' + WizardForm.DirEdit.Text + '" -Port ' + Trim(PortPage.Values[0]) + ' -ProgressFile "' + Prog + '"';
  if not OptPage.Values[OptFirewall] then Args := Args + ' -NoFirewall';
  if not OptPage.Values[OptShortcuts] then Args := Args + ' -NoShortcut';
  if not OptPage.Values[OptCert] then Args := Args + ' -NoTrustCert';
  if (OptPython >= 0) and OptPage.Values[OptPython] then Args := Args + ' -AllowDownload';

  ProgressPage.SetText('Wird vorbereitet …', '');
  ProgressPage.Show;
  try
    Exec(ExpandConstant('{cmd}'), '/V:ON /S /C "set "PSModulePath=" & "' + PowerShellExe() + '" ' + Args +
      ' > "' + LogFile + '" 2>&1 & echo !ERRORLEVEL!> "' + Done + '""', '', SW_HIDE, ewNoWait, Code);
    I := 0;
    while not FileExists(Done) and (I < 9000) do   // höchstens 15 Minuten (Python-Download eingeschlossen)
    begin
      ProgressPage.Animate;
      Sleep(100);
      I := I + 1;
      if I mod 5 = 0 then
      begin
        Step := ReadFirstLine(Prog);
        if Step <> '' then ProgressPage.SetText(Step + ' …', '');
      end;
    end;
    Sleep(300);
    Ok := ReadFirstLine(Done) = '0';
  finally
    ProgressPage.Hide;
  end;

  // Log in den Installationsordner kopieren (install.ps1 legt zusätzlich ein eigenes Protokoll in logs\ ab)
  ForceDirectories(WizardForm.DirEdit.Text + '\logs');
  FileCopy(LogFile, WizardForm.DirEdit.Text + '\logs\setup-ausgabe.log', False);

  // Zugangsdaten der Erstanmeldung aus der Ausgabe holen
  Cred := '';
  if LoadStringsFromFile(LogFile, Lines) then
    for I := 0 to GetArrayLength(Lines) - 1 do
    begin
      Line := Trim(Lines[I]);
      if (Pos('Benutzername:', Line) = 1) or (Pos('Passwort:', Line) = 1) then Cred := Cred + '    ' + Line + #13#10;
    end;
  Login := Cred;

  if not Ok then
    MsgBox('Die Einrichtung ist nicht vollständig gelungen.' + #13#10#13#10 + LogTail(LogFile, 12) + #13#10 +
      'Ein Update wurde dabei automatisch zurückgenommen – die bisherige Version läuft weiter.' + #13#10 +
      'Vollständiges Protokoll: ' + WizardForm.DirEdit.Text + '\logs\setup-ausgabe.log', mbError, MB_OK);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then RunInstaller();
end;

procedure CurPageChanged(CurPageID: Integer);
var
  T: String;
begin
  if CurPageID = wpFinished then
  begin
    if Ok then
    begin
      T := 'OpenDeskSharing {#AppVersion} läuft.' + #13#10#13#10 +
        'Auf diesem Rechner:' + #13#10 + '    https://localhost:' + Trim(PortPage.Values[0]) + #13#10 +
        'Im Netzwerk:' + #13#10 + '    https://' + GetComputerNameString() + ':' + Trim(PortPage.Values[0]);
      if Login <> '' then
        T := T + #13#10#13#10 + 'Erste Anmeldung (Passwort wird danach geändert):' + #13#10 + Login;
      if OptPage.Values[OptShortcuts] then
        T := T + #13#10 + 'Starten und Öffnen später über die Verknüpfung "OpenDeskSharing" auf dem Desktop oder im Startmenü.';
    end else
      T := 'Die Einrichtung ist nicht vollständig gelungen. Details stehen im Protokoll:' + #13#10 +
        WizardForm.DirEdit.Text + '\logs\setup-ausgabe.log';
    WizardForm.FinishedLabel.Caption := T;
    // Text kann länger sein als vorgesehen: Höhe anpassen und das Häkchen darunter setzen
    WizardForm.AdjustLabelHeight(WizardForm.FinishedLabel);
    WizardForm.RunList.Top := WizardForm.FinishedLabel.Top + WizardForm.FinishedLabel.Height + ScaleY(12);
  end;
end;

// ---- Deinstallation: install.ps1 hat Aufgabe, Firewall, Zertifikat usw. eingerichtet – uninstall.ps1 räumt das auf
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Args: String;
  Code: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;
  Args := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\setup\uninstall.ps1') + '" -Unattended -Instance "{#Instance}"';
  if not UninstallSilent() then
    if MsgBox('Sollen auch die Daten gelöscht werden?' + #13#10#13#10 +
      'Datenbank (alle Benutzer, Pläne und Buchungen), Sicherungen und Protokolle.' + #13#10 +
      'Bei "Nein" bleiben sie im Ordner ' + ExpandConstant('{app}') + ' erhalten – eine spätere Neuinstallation übernimmt sie.',
      mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      Args := Args + ' -DeleteData';
  Exec(PowerShellExe(), Args, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
