#!/bin/sh
# SatHunter Bridge for Linux distributions without .deb packages (Fedora, Arch, ...):
#   sudo ./install.sh
# Installs /usr/local/bin/sathunter-bridge, the udev rules, and a systemd service that starts it
# at boot. Undo: sudo ./install.sh --remove
set -e
here=$(cd "$(dirname "$0")" && pwd)
if [ "$(id -u)" != 0 ]; then echo "run it as root: sudo $0 $*"; exit 1; fi
unit=/etc/systemd/system/sathunter-bridge.service
if [ "$1" = --remove ]; then
  systemctl disable --now sathunter-bridge.service 2>/dev/null || true
  rm -f "$unit" /usr/local/bin/sathunter-bridge /etc/udev/rules.d/60-sathunter-bridge.rules /etc/modprobe.d/sathunter-bridge-rtlsdr.conf
  udevadm control --reload-rules || true; systemctl daemon-reload || true
  echo "SatHunter Bridge removed"; exit 0
fi
install -m 755 "$here/sathunter-bridge" /usr/local/bin/sathunter-bridge
/usr/local/bin/sathunter-bridge --setup
# dialout is Debian's name; other distributions use uucp or nothing (the udev rule covers it)
sed -e 's#/usr/bin/#/usr/local/bin/#' -e '/^SupplementaryGroups/d' "$here/sathunter-bridge.service" > "$unit"
systemctl daemon-reload
systemctl enable --now sathunter-bridge.service
echo "SatHunter Bridge installed and running: open SatHunter Web SDR in any browser"
