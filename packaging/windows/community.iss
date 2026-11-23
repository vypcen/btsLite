[Setup]
AppId={{C100B776-13D3-4C78-9C10-E9D6CF3CB108}
AppName=BlackCat Testing Community
AppVersion={#ProductVersion}
AppPublisher=BlackCatSoftware
AppPublisherURL=https://blackcatsoftware.ru/
DefaultDirName={autopf}\BlackCat Testing Community
DefaultGroupName=BlackCat Testing Community
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\packages
OutputBaseFilename=BlackCat-Testing-Community-{#ProductVersion}-win-x64-Setup
Compression=lzma2/fast
SolidCompression=yes
UninstallDisplayName=BlackCat Testing Community

[Files]
Source: "manage.ps1"; Flags: dontcopy
Source: "..\..\dist\*"; DestDir: "{app}\app"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\..\windows-payload\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "community-service.xml"; DestDir: "{app}"; Flags: ignoreversion
Source: "manage.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\BlackCat Testing Community"; Filename: "http://localhost:3002/"
Name: "{group}\Installation guide"; Filename: "{app}\app\docs\NATIVE_INSTALL.md"

[Run]
Filename: "http://localhost:3002/"; Description: "Open BlackCat Testing Community"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\manage.ps1"" -Action Remove -InstallDir ""{app}"""; Flags: runhidden waituntilterminated

[Code]
function Manage(Action, ScriptPath: String): Boolean;
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + ScriptPath + '" -Action ' + Action +
    ' -InstallDir "' + ExpandConstant('{app}') + '"';
  ResultCode := 0;
  Result := Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := Result and (ResultCode = 0);
  if not Result then Log('Community ' + Action + ' failed with exit code ' + IntToStr(ResultCode));
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  ExtractTemporaryFile('manage.ps1');
  Result := '';
  if not Manage('Stop', ExpandConstant('{tmp}\manage.ps1')) then
    Result := 'Could not stop the existing Community services.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not Manage('Install', ExpandConstant('{app}\manage.ps1')) then
    RaiseException('Community could not start. See ProgramData\BlackCatTestingCommunity\logs.');
end;
