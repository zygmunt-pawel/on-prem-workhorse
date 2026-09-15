#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  diskutil list external physical

  ALLOW_ERASE_USB=yes \
  CONFIRM_USB_DEVICE=/dev/diskN \
  ./deploy/autoinstall/write-usb-macos.sh AUTOINSTALL.iso /dev/diskN

Writes an existing autoinstall ISO to one whole external USB device on macOS.
The selected device is erased completely. Partitions such as /dev/diskN1 are
rejected. The script also rejects internal disks and /dev/disk0.
EOF
}

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 2
fi

if [[ $(uname -s) != Darwin ]]; then
  echo "This writer is deliberately limited to macOS." >&2
  exit 1
fi

image=$1
device=$2

[[ -f "$image" ]] || { echo "Image not found: $image" >&2; exit 1; }
[[ "$device" =~ ^/dev/disk[1-9][0-9]*$ ]] || {
  echo "Expected a whole disk such as /dev/disk4 (never a partition or disk0)." >&2
  exit 2
}
[[ ${ALLOW_ERASE_USB:-} == yes ]] || {
  echo "Refusing to erase a device without ALLOW_ERASE_USB=yes" >&2
  exit 2
}
[[ ${CONFIRM_USB_DEVICE:-} == "$device" ]] || {
  echo "Set CONFIRM_USB_DEVICE exactly to $device after checking diskutil output." >&2
  exit 2
}

for command_name in diskutil dd shasum stat sync; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

info_plist=$(mktemp "${TMPDIR:-/tmp}/usb-device-info.XXXXXX")
cleanup() {
  rm -f "$info_plist"
}
trap cleanup EXIT

diskutil info -plist "$device" > "$info_plist" || {
  echo "diskutil cannot inspect $device" >&2
  exit 1
}

plist_value() {
  /usr/bin/plutil -extract "$1" raw -o - "$info_plist" 2>/dev/null || true
}

whole=$(plist_value Whole)
internal=$(plist_value Internal)
protocol=$(plist_value BusProtocol)
media_name=$(plist_value MediaName)
total_size=$(plist_value TotalSize)
identifier=$(plist_value DeviceIdentifier)

[[ "$whole" == true && "/dev/$identifier" == "$device" ]] || {
  echo "Refusing to write: $device is not the selected whole disk." >&2
  exit 1
}
[[ "$internal" == false ]] || {
  echo "Refusing to write: $device is reported as an internal disk." >&2
  exit 1
}
if [[ "$protocol" != USB && ${ALLOW_NON_USB_EXTERNAL:-} != yes ]]; then
  echo "Refusing to write: $device uses '$protocol', not USB." >&2
  echo "For a deliberately selected external non-USB device, also set ALLOW_NON_USB_EXTERNAL=yes." >&2
  exit 1
fi

image_sha256=$(shasum -a 256 "$image" | awk '{print $1}')
image_size=$(stat -f '%z' "$image")
if [[ "$total_size" =~ ^[0-9]+$ ]] && (( image_size > total_size )); then
  echo "Image has $image_size bytes but $device holds only $total_size bytes." >&2
  exit 1
fi
raw_device="/dev/r${device#/dev/}"

cat <<EOF
About to erase and overwrite:
  device:   $device
  media:    ${media_name:-unknown}
  protocol: ${protocol:-unknown}
  bytes:    ${total_size:-unknown}
  image:    $image
  img bytes: $image_size
  SHA-256:  $image_sha256
EOF

sudo -v
diskutil unmountDisk "$device"
echo "Writing the image. On macOS, press Ctrl-T to display dd progress."
sudo dd if="$image" of="$raw_device" bs=4m
sync
diskutil eject "$device"

echo "USB image written and ejected successfully."
echo "Insert it into the target while powered off, boot from USB once, and remove it after the target powers off."
