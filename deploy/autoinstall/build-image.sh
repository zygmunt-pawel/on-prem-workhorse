#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  cat <<'EOF'
Usage:
  ALLOW_ERASE_LARGEST_DISK=yes \
  SSH_PUBLIC_KEY_FILE=/absolute/path/to/id_ed25519.pub \
  ./deploy/autoinstall/build-image.sh INPUT.iso OUTPUT.iso

Builds a reusable Ubuntu 26.04.1 Server autoinstall image.
This script creates an image only; it never writes to a block device.
EOF
}

if [[ $# -ne 2 ]]; then
  usage >&2
  exit 2
fi

if [[ ${ALLOW_ERASE_LARGEST_DISK:-} != yes ]]; then
  echo "Refusing to build a destructive installer without ALLOW_ERASE_LARGEST_DISK=yes" >&2
  exit 2
fi

input_iso=$1
output_iso=$2
public_key_file=${SSH_PUBLIC_KEY_FILE:-}
expected_sha256=cc8a95cde20f6ced61a322420de00f10cc3c90ced545daa46cb9c1a117f1d927

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for command_name in awk openssl sed shasum xorriso; do
  command -v "$command_name" >/dev/null || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

[[ -f "$input_iso" ]] || { echo "Input ISO not found: $input_iso" >&2; exit 1; }
[[ -n "$public_key_file" && -f "$public_key_file" ]] || {
  echo "Set SSH_PUBLIC_KEY_FILE to an existing public key" >&2
  exit 1
}
[[ ! -e "$output_iso" ]] || {
  echo "Output already exists; refusing to overwrite: $output_iso" >&2
  exit 1
}

actual_sha256="$(shasum -a 256 "$input_iso" | awk '{print $1}')"
[[ "$actual_sha256" == "$expected_sha256" ]] || {
  echo "Unexpected Ubuntu ISO checksum: $actual_sha256" >&2
  exit 1
}

public_key="$(tr -d '\r\n' < "$public_key_file")"
case "$public_key" in
  ssh-ed25519\ *|sk-ssh-ed25519@openssh.com\ *) ;;
  *) echo "Expected an Ed25519 SSH public key" >&2; exit 1 ;;
esac

temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/ubuntu-server-autoinstall.XXXXXX")"
cleanup() {
  rm -rf "$temporary_dir"
}
trap cleanup EXIT

discarded_password="$(openssl rand -base64 48)"
password_hash="$(openssl passwd -6 "$discarded_password")"
unset discarded_password

escape_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

escaped_password_hash="$(escape_replacement "$password_hash")"
escaped_public_key="$(escape_replacement "$public_key")"

sed \
  -e "s|__PASSWORD_HASH__|$escaped_password_hash|" \
  -e "s|__SSH_PUBLIC_KEY__|$escaped_public_key|" \
  "$script_dir/autoinstall.yaml.template" \
  > "$temporary_dir/autoinstall.yaml"

xorriso -osirrox on -indev "$input_iso" \
  -extract /md5sum.txt "$temporary_dir/original-md5sum.txt" \
  >/dev/null 2>&1

md5_file() {
  if command -v md5sum >/dev/null; then
    md5sum "$1" | awk '{print $1}'
  else
    openssl dgst -md5 -r "$1" | awk '{print $1}'
  fi
}

grub_md5="$(md5_file "$script_dir/grub.cfg")"
autoinstall_md5="$(md5_file "$temporary_dir/autoinstall.yaml")"
awk '$2 != "./boot/grub/grub.cfg" && $2 != "./autoinstall.yaml"' \
  "$temporary_dir/original-md5sum.txt" \
  > "$temporary_dir/md5sum.txt"
printf '%s  %s\n' \
  "$grub_md5" ./boot/grub/grub.cfg \
  "$autoinstall_md5" ./autoinstall.yaml \
  >> "$temporary_dir/md5sum.txt"

xorriso \
  -indev "$input_iso" \
  -outdev "$output_iso" \
  -boot_image any replay \
  -map "$temporary_dir/autoinstall.yaml" /autoinstall.yaml \
  -map "$script_dir/grub.cfg" /boot/grub/grub.cfg \
  -map "$temporary_dir/md5sum.txt" /md5sum.txt \
  -commit

xorriso -indev "$output_iso" -check_media -- 2>&1 \
  | tee "$temporary_dir/xorriso-check.log"

xorriso -osirrox on -indev "$output_iso" \
  -extract /autoinstall.yaml "$temporary_dir/extracted-autoinstall.yaml" \
  -extract /boot/grub/grub.cfg "$temporary_dir/extracted-grub.cfg" \
  -extract /md5sum.txt "$temporary_dir/extracted-md5sum.txt" \
  >/dev/null 2>&1

cmp "$temporary_dir/autoinstall.yaml" "$temporary_dir/extracted-autoinstall.yaml"
cmp "$script_dir/grub.cfg" "$temporary_dir/extracted-grub.cfg"
cmp "$temporary_dir/md5sum.txt" "$temporary_dir/extracted-md5sum.txt"
grep -q 'linux /casper/vmlinuz autoinstall ---' "$temporary_dir/extracted-grub.cfg"

echo "Built: $output_iso"
shasum -a 256 "$output_iso"
