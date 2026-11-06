#!/bin/sh
# build-deb.sh <binary> <deb arch: amd64|arm64> <version> <out dir>
set -e
bin=$1; arch=$2; ver=$3; out=$4
here=$(cd "$(dirname "$0")" && pwd)
root=$(mktemp -d)
chmod 755 "$root"
mkdir -p "$root/DEBIAN" "$root/usr/bin" "$root/lib/systemd/system" "$root/usr/share/doc/sathunter-bridge"
install -m 755 "$bin" "$root/usr/bin/sathunter-bridge"
install -m 644 "$here/sathunter-bridge.service" "$root/lib/systemd/system/"
for s in postinst prerm postrm; do install -m 755 "$here/$s" "$root/DEBIAN/$s"; done
install -m 644 "$here/../../../LICENSE" "$root/usr/share/doc/sathunter-bridge/copyright"
cat > "$root/DEBIAN/control" <<CTRL
Package: sathunter-bridge
Version: $ver
Architecture: $arch
Maintainer: Zoltan Doczi <zoltan.doczi@gmail.com>
Section: hamradio
Priority: optional
Homepage: https://github.com/z2labs/SatHunter-WEB-SDR
Description: RTL-SDR and ESP32-S3 SDR access for SatHunter Web SDR in any browser
 A small background service on 127.0.0.1 that lets the SatHunter Web SDR page use an RTL-SDR
 (Blog V3 / V4) and an ESP32-S3 SDR from any browser, Firefox included, with no udev or
 driver setup by hand: it installs the udev rules, keeps the DVB-T TV driver off RTL-SDR sticks,
 and starts at boot.
CTRL
mkdir -p "$out"
dpkg-deb --root-owner-group -Zxz --build "$root" "$out/sathunter-bridge_${ver}_${arch}.deb"
rm -rf "$root"
