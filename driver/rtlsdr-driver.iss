; SatHunter RTL-SDR driver: one click instead of Zadig.
; Installs the WinUSB driver for RTL2832U dongles (RTL-SDR Blog V3 / V4 and the usual DVB-T sticks,
; USB 0BDA:2838 and 0BDA:2832) with libwdi's wdi-simple (the engine of Zadig, LGPL-3.0).
; Works whether the dongle is plugged in or not; for composite sticks it takes interface 0 (the
; radio), like choosing "Bulk-In, Interface (Interface 0)" in Zadig.
;
; Build: ISCC rtlsdr-driver.iss /DWdiSimple=path\to\wdi-simple.exe  (see .github/workflows/driver.yml)

#ifndef WdiSimple
  #define WdiSimple "wdi-simple.exe"
#endif
#ifndef AppVer
  #define AppVer "1.0"
#endif

[Setup]
AppId={{6B4F3C1E-5A2D-4C8E-9C7A-2B1D5E8F0A11}
AppName=SatHunter RTL-SDR driver
AppVersion={#AppVer}
AppVerName=SatHunter RTL-SDR driver {#AppVer}
AppPublisher=Z2Labs
AppPublisherURL=https://github.com/z2labs/SatHunter-WEB-SDR
DefaultDirName={tmp}\sathunter-rtlsdr-driver
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=admin
DisableWelcomePage=no
DisableReadyPage=no
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir=Output
OutputBaseFilename=SatHunter-RTL-SDR-Driver
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
MinVersion=6.1
ArchitecturesAllowed=x86compatible x64compatible arm64
LicenseFile=driver-license.txt

[Messages]
WelcomeLabel1=RTL-SDR driver for SatHunter
WelcomeLabel2=This installs the USB driver that lets SatHunter (in Chrome or Edge, or the desktop app) use an RTL-SDR stick: RTL-SDR Blog V3, V4 and the usual RTL2832U dongles.%n%nYou may plug the RTL-SDR in now (recommended), or later.%n%nIt replaces the Windows TV-stick driver for these sticks only. Nothing else on the computer changes.
ReadyLabel1=Ready to install the RTL-SDR driver.
FinishedLabel=The RTL-SDR driver is installed.%n%nIf the RTL-SDR was plugged in, unplug it and plug it in again. Then open SatHunter Web in Chrome or Edge and press "Connect RTL-SDR".

[Files]
Source: "{#WdiSimple}"; DestDir: "{tmp}"; DestName: "wdi-simple.exe"; Flags: deleteafterinstall

[Run]
; interface 0 of the composite sticks (radio + IR receiver), then the plain device ids
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR (Bulk-In, Interface 0)"" -m ""Realtek"" -v 0x0bda -p 0x2838 -i 0 -t 0 -s -o 60000"; StatusMsg: "Installing the driver for 0BDA:2838 (RTL-SDR Blog V3 / V4)…"; Flags: runhidden waituntilterminated
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR"" -m ""Realtek"" -v 0x0bda -p 0x2838 -t 0 -s -o 60000"; StatusMsg: "Installing the driver for 0BDA:2838…"; Flags: runhidden waituntilterminated
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR (Bulk-In, Interface 0)"" -m ""Realtek"" -v 0x0bda -p 0x2832 -i 0 -t 0 -s -o 60000"; StatusMsg: "Installing the driver for 0BDA:2832…"; Flags: runhidden waituntilterminated
Filename: "{tmp}\wdi-simple.exe"; Parameters: "-n ""RTL2832U SDR"" -m ""Realtek"" -v 0x0bda -p 0x2832 -t 0 -s -o 60000"; StatusMsg: "Installing the driver for 0BDA:2832…"; Flags: runhidden waituntilterminated
