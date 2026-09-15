# Reusable Ubuntu Server autoinstall

This directory builds a reusable zero-touch Ubuntu Server 26.04.1 installer.
It configures:

- hostname and user `server`;
- SSH key authentication only;
- DHCP networking;
- the standard Ubuntu Server package set and all available updates;
- no project code, runtime secrets, Docker, NVIDIA software or model files.

The complete path from blank NVMe to the running RTX 5090 stack is documented
in [`../server/README.md`](../server/README.md). This directory covers only the
portable clean-OS stage.

## Destructive storage policy

Booting the resulting image automatically erases the largest disk. Subiquity's
`size: largest` selector excludes the installation media, so the USB stick is
not selected. Use it only on a machine whose largest internal disk may be
erased in full.

The machine powers off after installation. Remove the USB before turning it on
again so firmware boot order cannot start another installation.

Simply inserting this USB into a running machine does not start anything. The
target must boot from the USB once. After that boot, the three-second GRUB
timeout, disk erase, installation, updates and shutdown are automatic.

## Build

```bash
ALLOW_ERASE_LARGEST_DISK=yes \
SSH_PUBLIC_KEY_FILE=/Users/pawel/.ssh/id_ed25519.pub \
./deploy/autoinstall/build-image.sh \
  /Users/pawel/Downloads/ubuntu-26.04.1-live-server-amd64.iso \
  /Users/pawel/Downloads/ubuntu-26.04.1-server-autoinstall.iso
```

The script verifies the exact official 26.04.1 ISO checksum and refuses to
overwrite an existing output file. It does not write to a block device.

## Write on macOS

Identify the whole external USB device by name and size:

```bash
diskutil list external physical
diskutil info /dev/disk4
```

Then replace `/dev/disk4` with that exact verified device and write the image:

```bash
ALLOW_ERASE_USB=yes \
CONFIRM_USB_DEVICE=/dev/disk4 \
./deploy/autoinstall/write-usb-macos.sh \
  /Users/pawel/Downloads/ubuntu-26.04.1-server-autoinstall.iso \
  /dev/disk4
```

This step erases the USB completely. The writer refuses partitions, `disk0`
and any device macOS reports as internal.

## Expected target behavior

Boot the target's UEFI USB entry once. No installer input is required. On the
current RTX 5090 machine, initial boot text was followed by a black screen and
the monitor's `Input not supported` message; installation continued normally
and the configured automatic poweroff marked completion. Remove the USB,
start the machine, and connect with `ssh server@server` or its DHCP address.
Local video works after the post-install NVIDIA driver step and reboot.

Runtime secrets, project code and credentials are intentionally not embedded.
