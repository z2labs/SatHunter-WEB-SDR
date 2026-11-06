; SatHunter for Windows, one installer:
;  - the WinUSB driver for RTL2832U sticks (RTL-SDR Blog V3 / V4, 0BDA:2838 and 0BDA:2832), with
;    libwdi's wdi-simple (the engine of Zadig, LGPL-3.0), as driver\rtlsdr-driver.iss does;
;  - SatHunter Bridge, started with Windows, so SatHunter Web SDR works in Firefox too.
;
; Build: ISCC sathunter-setup.iss /DWdiSimple=path\to\wdi-simple.exe /DBridgeExe=path\to\sathunter-bridge.exe
;        (see .github/workflows/bridge.yml)

#ifndef WdiSimple
  #define WdiSimple "wdi-simple.exe"
#endif
#ifndef BridgeExe
  #define BridgeExe "sathunter-bridge.exe"
#endif
#ifndef AppVer
  #define AppVer "1.0.0"
#endif

[Setup]
AppId={{3E9A7C52-8B14-4D6F-A0C3-5F2E91B7D4A8}
AppName=SatHunter
AppVersion={#AppVer}
AppVerName=SatHunter {#AppVer} (RTL-SDR driver and SatHunter Bridge)
AppPublisher=Z2Labs
AppPublisherURL=https://github.com/z2labs/SatHunter-WEB-SDR
DefaultDirName={autopf}\SatHunter Bridge
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputDir=Output
OutputBaseFilename=SatHunter-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
MinVersion=6.1
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\..\..\driver\driver-license.txt
UninstallDisplayName=SatHunter Bridge
CloseApplications=no

[Messages]
WelcomeLabel1=SatHunter for Windows
WelcomeLabel2=This sets up the computer for SatHunter Web SDR, in any browser (Chrome, Edge or Firefox):%n%n- the USB driver for RTL-SDR sticks (RTL-SDR Blog V3, V4 and the usual RTL2832U dongles), instead of Zadig;%n- SatHunter Bridge, a small background program that starts with Windows.%n%nYou may plug the RTL-SDR in now (recommended), or later. Nothing else on the computer changes.
FinishedLabel=SatHunter is ready.%n%nIf the RTL-SDR was plugged in, unplug it and plug it in again. Then open SatHunter Web SDR in any browser and press "RTL-SDR".

[Files]
Source: "{#WdiSimple}"; DestDir: "{tmp}"; DestName: "wdi-simple.exe"; Flags: deleteafterinstall
Source: "{#BridgeExe}"; DestDir: "{app}"; DestName: "sathunter-bridge.exe"; Flags: ignoreversion; BeforeInstall: StopBridge

[Registry]
Root: HKLM; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "SatHunter Bridge"; ValueData: """{app}\sathunter-bridge.exe"""; Flags: uninsdeletevalue

[Run]
; interface 0 of the composite sticks (radio + IR receiver), then the plain device ids
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR (Bulk-In, Interface 0)"" -m ""Realtek"" -v 0x0bda -p 0x2838 -i 0 -t 0 -s -o 60000"; StatusMsg: "Installing the RTL-SDR driver (0BDA:2838, RTL-SDR Blog V3 / V4)…"; Flags: runhidden waituntilterminated
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR"" -m ""Realtek"" -v 0x0bda -p 0x2838 -t 0 -s -o 60000"; StatusMsg: "Installing the RTL-SDR driver (0BDA:2838)…"; Flags: runhidden waituntilterminated
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR (Bulk-In, Interface 0)"" -m ""Realtek"" -v 0x0bda -p 0x2832 -i 0 -t 0 -s -o 60000"; StatusMsg: "Installing the RTL-SDR driver (0BDA:2832)…"; Flags: runhidden waituntilterminated
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR"" -m ""Realtek"" -v 0x0bda -p 0x2832 -t 0 -s -o 60000"; StatusMsg: "Installing the RTL-SDR driver (0BDA:2832)…"; Flags: runhidden waituntilterminated
; start the bridge now, as the signed-in user (it also starts with Windows from now on)
Filename: "{app}\sathunter-bridge.exe"; StatusMsg: "Starting SatHunter Bridge…"; Flags: nowait runasoriginaluser

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM sathunter-bridge.exe"; Flags: runhidden; RunOnceId: "StopBridge"

[Code]
procedure StopBridge();
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM sathunter-bridge.exe', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;
