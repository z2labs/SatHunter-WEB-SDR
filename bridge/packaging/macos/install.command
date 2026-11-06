#!/bin/sh
# SatHunter Bridge for macOS: double-click to install (or run it in Terminal).
# Copies the bridge to ~/Library/Application Support/SatHunter and starts it at every login.
# Chrome and Edge on a Mac need nothing; this is for Firefox and Safari.
# Undo: ./install.command --remove
set -e
here=$(cd "$(dirname "$0")" && pwd)
dir="$HOME/Library/Application Support/SatHunter"
plist="$HOME/Library/LaunchAgents/io.z2labs.sathunter-bridge.plist"
launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
if [ "$1" = --remove ]; then rm -f "$plist" "$dir/sathunter-bridge"; echo "SatHunter Bridge removed"; exit 0; fi
mkdir -p "$dir" "$HOME/Library/LaunchAgents"
cp "$here/sathunter-bridge" "$dir/sathunter-bridge"
chmod 755 "$dir/sathunter-bridge"
xattr -d com.apple.quarantine "$dir/sathunter-bridge" 2>/dev/null || true
cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>io.z2labs.sathunter-bridge</string>
  <key>ProgramArguments</key><array><string>$dir/sathunter-bridge</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "SatHunter Bridge is installed and running. Open SatHunter Web SDR in any browser."
