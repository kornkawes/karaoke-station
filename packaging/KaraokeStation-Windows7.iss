#ifndef StageDir
  #error StageDir is required
#endif
#ifndef ReleaseDir
  #error ReleaseDir is required
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

[Setup]
AppId={{8C5D031B-64E7-4F70-9894-8A3249E22C8A}
AppName=KaraokeStation
AppVersion={#AppVersion}
AppVerName=KaraokeStation {#AppVersion} (Windows 7)
AppPublisher=KaraokeStation
DefaultDirName={localappdata}\Programs\KaraokeStation
DefaultGroupName=KaraokeStation
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
MinVersion=6.1sp1
OnlyBelowVersion=10.0
OutputDir={#ReleaseDir}
OutputBaseFilename=KaraokeStation-Windows7-Setup
SetupIconFile={#StageDir}\KaraokeStation.ico
UninstallDisplayIcon={app}\KaraokeStation.exe
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName=KaraokeStation
VersionInfoDescription=KaraokeStation Windows 7 SP1 per-user installer

[Tasks]
Name: "desktopicon"; Description: "สร้างไอคอนบน Desktop"; GroupDescription: "ทางลัด:"; Flags: checkedonce
Name: "startup"; Description: "เปิด KaraokeStation เมื่อเข้าสู่ Windows"; GroupDescription: "เริ่มอัตโนมัติ:"; Flags: unchecked

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: files; Name: "{app}\app\server\index.js"

[Icons]
Name: "{group}\KaraokeStation"; Filename: "{app}\KaraokeStation.exe"; WorkingDir: "{app}"
Name: "{autodesktop}\KaraokeStation"; Filename: "{app}\KaraokeStation.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\KaraokeStation"; Filename: "{app}\KaraokeStation.exe"; WorkingDir: "{app}"; Tasks: startup

[Run]
Filename: "{app}\KaraokeStation.exe"; Description: "เปิด KaraokeStation"; Flags: nowait postinstall skipifsilent

[Code]
function IsDotNet45OrLater(): Boolean;
var
  Release: Cardinal;
  Key: String;
begin
  Key := 'SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full';
  Result := RegQueryDWordValue(HKLM32, Key, 'Release', Release) and
    (Release >= 378389);
  if (not Result) and IsWin64 then
    Result := RegQueryDWordValue(HKLM64, Key, 'Release', Release) and
      (Release >= 378389);
end;

function InitializeSetup(): Boolean;
begin
  Result := IsDotNet45OrLater();
  if not Result then
    MsgBox(
      'KaraokeStation ต้องใช้ Microsoft .NET Framework 4.5 หรือใหม่กว่า กรุณาติดตั้ง .NET Framework แล้วเปิดตัวติดตั้งอีกครั้ง',
      mbError,
      MB_OK);
end;

function StopInstalledStation(): Boolean;
var
  ResultCode: Integer;
  LauncherPath: String;
begin
  Result := True;
  LauncherPath := ExpandConstant('{app}\KaraokeStation.exe');
  if not FileExists(LauncherPath) then
    exit;
  if not Exec(LauncherPath, '--shutdown', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Result := False;
    exit;
  end;
  Result := ResultCode = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if not StopInstalledStation() then
    Result := 'ไม่สามารถหยุด KaraokeStation รุ่นเดิมได้ กรุณาปิดโปรแกรมแล้วลองอีกครั้ง'
  else
    Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopInstalledStation();
  if not Result then
    MsgBox(
      'ไม่สามารถหยุด KaraokeStation ได้ กรุณาปิดโปรแกรมแล้วลองถอนการติดตั้งอีกครั้ง',
      mbError,
      MB_OK);
end;
