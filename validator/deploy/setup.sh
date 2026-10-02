#!/bin/sh
# Prepare a fresh Raspberry Pi OS Lite (Bookworm, 64-bit) for the validator.
# Run as root on the Pi, from a copy of the repository at /opt/bhada:
#
#   sudo sh /opt/bhada/validator/deploy/setup.sh
#
# It does not partition the card or turn on the read-only root: both are one-way
# enough that they are listed at the end for a person to do deliberately.
set -eu

[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)

echo "== packages"
apt-get update
apt-get install -y ca-certificates curl i2c-tools fonts-noto-core fonts-dejavu-core
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== the clock is the DS3231, not the last time written to disk"
apt-get purge -y fake-hwclock || true
# Debian's udev helper skips setting the clock from the RTC when systemd is
# running; on a Pi the RTC driver is a module, so nothing else would.
if [ -f /lib/udev/hwclock-set ]; then
  sed -i 's|^if \[ -e /run/systemd/system \] ; then|if false ; then|' /lib/udev/hwclock-set
fi

echo "== serial console off, so the UART is the PN532's"
CMDLINE=/boot/firmware/cmdline.txt
[ -f "$CMDLINE" ] && sed -i 's/console=serial0,[0-9]* //' "$CMDLINE"
systemctl disable --now serial-getty@ttyS0.service 2>/dev/null || true
systemctl disable --now serial-getty@ttyAMA0.service 2>/dev/null || true

echo "== user and directories"
id bhada >/dev/null 2>&1 || useradd --system --home /var/lib/bhada --shell /usr/sbin/nologin bhada
mkdir -p /var/lib/bhada /etc/bhada
chown bhada:bhada /var/lib/bhada
[ -f /etc/bhada/validator.env ] || cp "$HERE/validator.env" /etc/bhada/validator.env

echo "== dependencies"
cd "$ROOT"
npm ci --no-audit --no-fund

echo "== services"
cp "$HERE/bhada-validator.service" "$HERE/bhada-rtc-sync.service" "$HERE/bhada-rtc-sync.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable bhada-validator.service bhada-rtc-sync.timer

if ! grep -q 'i2c-rtc,ds3231' /boot/firmware/config.txt; then
  echo "== config.txt"
  cat "$HERE/config.txt" >> /boot/firmware/config.txt
fi

cat <<'NEXT'

Done. Before the first reboot:

  1. Set the DS3231 once, from a network-synced clock:
       sudo hwclock --systohc --utc     (after the reboot that loads the RTC)
  2. Edit /etc/bhada/validator.env for this door.
  3. Reboot. `journalctl -u bhada-validator -f` should end with "ready:".

Then, to make the card survive power cuts (validator/README.md, "Power cuts"):

  4. Give /var/lib/bhada its own ext4 partition, mounted with
     noatime,commit=1,data=journal in /etc/fstab.
  5. Turn on the read-only root: sudo raspi-config nonint enable_overlayfs
     (and sudo raspi-config nonint enable_bootro). /var/lib/bhada stays
     writable because it is a separate mount. Updates then need the overlay
     turned off, a reboot, the update, and the overlay back on.
NEXT
