# Bare-metal recovery and RTX 5090 deployment

This is the canonical zero-to-production runbook for this repository. It is
split deliberately into two stages:

1. `deploy/autoinstall/` creates a reusable, zero-touch Ubuntu installer. It
   erases one disk and installs a clean, updated OS with SSH access.
2. `deploy/server/` runs after the first SSH login. It installs the NVIDIA
   driver, Docker, NVIDIA Container Toolkit, the pinned models, the application
   stack and the persistent 450 W power limit.

The USB remains generic and useful for other servers. It contains no API keys,
Cloudflare credentials, project checkout, GPU driver, Docker or model files.
Secrets and machine-specific services belong to stage two.

The last known-good live state is recorded in
[`VERIFIED_STATE.md`](VERIFIED_STATE.md).

## Safety contract

The installer is intentionally destructive: after booting from USB, it erases
the **largest non-install-media disk without asking**. Use it only when that is
the intended target. For the current RTX 5090 machine, the sole internal NVMe
may be erased in full. On another computer, verify every attached disk first;
the largest disk may not be the one you intend to replace.

Inserting the USB into an already running computer does nothing. The computer
must boot from it. If firmware does not already prefer USB, use its one-time
boot menu once. After the USB has booted, GRUB waits three seconds and the rest
of the installation needs no keyboard, display or clicks.

## Inputs kept outside Git

Prepare these on the administrator Mac:

- official `ubuntu-26.04.1-live-server-amd64.iso`;
- Pawel's Ed25519 public key, normally `~/.ssh/id_ed25519.pub`;
- the two service API-key values for the server's `.env`;
- optional Cloudflare tunnel credential
  `ca500d27-9a93-440c-9023-e1729c249e1e.json`;
- a Hugging Face account that has accepted the model terms, if the Hub asks for
  authentication.

Never commit `.env`, a Hugging Face token, the tunnel JSON, `cert.pem`, a
private SSH key, downloaded model weights or a generated ISO.

## 1. Build the autoinstall image on macOS

Install the only nonstandard build dependency:

```bash
brew install xorriso
```

From this repository:

```bash
ALLOW_ERASE_LARGEST_DISK=yes \
SSH_PUBLIC_KEY_FILE=/Users/pawel/.ssh/id_ed25519.pub \
./deploy/autoinstall/build-image.sh \
  /Users/pawel/Downloads/ubuntu-26.04.1-live-server-amd64.iso \
  /Users/pawel/Downloads/ubuntu-26.04.1-server-autoinstall.iso
```

The builder:

- requires an explicit destructive-install acknowledgement;
- verifies the official source ISO SHA-256;
- validates that the embedded key is Ed25519;
- generates and discards a random console password;
- injects the autoinstall data and automatic GRUB entry;
- verifies the resulting ISO without overwriting an existing output.

The image installs account and hostname `server`, DHCP networking, public-key
SSH, passwordless `sudo`, the standard Ubuntu Server package set and all
installer-time updates. Password SSH is disabled.

## 2. Write the image to exactly one USB device

First list only external physical media and identify the whole disk by size and
name:

```bash
diskutil list external physical
diskutil info /dev/disk4
```

Replace `/dev/disk4` below with the verified whole USB disk. Never use a slice
such as `/dev/disk4s1`.

```bash
ALLOW_ERASE_USB=yes \
CONFIRM_USB_DEVICE=/dev/disk4 \
./deploy/autoinstall/write-usb-macos.sh \
  /Users/pawel/Downloads/ubuntu-26.04.1-server-autoinstall.iso \
  /dev/disk4
```

The writer refuses `disk0`, partitions and devices that macOS reports as
internal. It prints the final target identity before asking `sudo` to unmount
and overwrite it. The USB is ejected on success.

## 3. Install Ubuntu on the target

1. Power the target off and insert only the intended installer USB.
2. Power it on and boot the UEFI USB entry. Use the one-time firmware boot menu
   if USB is not already first.
3. Do not interact with the installer. Initial boot text may be followed by a
   black screen or `Input not supported` on an RTX 5090 display.
4. Wait for the machine to power itself off. This is the configured success
   behavior; installation and updates commonly take tens of minutes.
5. Remove the USB, then power the target on. Leaving it attached can erase the
   disk again if firmware boots USB first.

The black screen seen on the current RTX 5090 host did not mean installation
had stopped. The machine powered off normally, booted Ubuntu and was reachable
over SSH. Local video became normal after the NVIDIA driver was installed and
the host rebooted.

## 4. Find the host and connect

The Linux hostname really is `server`; it is not merely an SSH client alias.
Try local name resolution first:

```bash
ssh server@server
```

If that does not resolve, find the DHCP lease in the router and use the IP:

```bash
ssh server@192.168.1.15
```

`192.168.1.15` is the current known address, not an installer guarantee. Add a
DHCP reservation in the router before applications depend on it. A local SSH
alias is optional and may have any name:

```sshconfig
Host classifier-gpu
  HostName 192.168.1.15
  User server
  IdentityFile ~/.ssh/id_ed25519
```

## 5. Put this repository on the host

Use Git when the host has repository access:

```bash
git clone git@github.com:zygmunt-pawel/on-prem-workhorse.git \
  /home/server/on-prem-workhorse
cd /home/server/on-prem-workhorse
```

For uncommitted deployment work, copy the local checkout from the Mac. This
preserves any existing server-side `.env` because it is excluded:

```bash
ssh server@server 'mkdir -p /home/server/on-prem-workhorse'
rsync -az \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='benchmark-results/' \
  /Users/pawel/workspace/on-prem-workhorse/ \
  server@server:/home/server/on-prem-workhorse/
```

The scripts locate the repository from their own paths, so they need not be
started from a particular working directory.

## 6. Bootstrap Ubuntu, NVIDIA and Docker

Install `tmux` first on a completely fresh image, then use it for the long
network/package operation. If SSH disconnects, reconnect and run
`tmux attach -t setup`.

```bash
cd /home/server/on-prem-workhorse
sudo apt-get update && sudo apt-get install -y tmux
tmux new -s setup
./deploy/server/bootstrap-host.sh
```

The script is safe to rerun and performs the following:

- applies all available Ubuntu updates;
- installs Ubuntu's `nvidia-driver-595-open` package;
- installs Docker Engine and Compose from Docker's official Ubuntu repository;
- installs NVIDIA Container Toolkit `1.20.0-1` from NVIDIA's repository and
  configures the Docker runtime;
- creates persistent model and vLLM cache directories;
- installs Hugging Face CLI `1.29.0` in `~/.venvs/huggingface`;
- enables Docker and the repository's 450 W RTX 5090 systemd unit at boot.

It does not uninstall a pre-existing conflicting Docker/container runtime; it
stops and names the packages so they can be reviewed first. The NVIDIA driver
branch and toolkit version are fixed, while Ubuntu and Docker receive current
compatible stable updates.

Reboot when the script says it is required, then reconnect so membership in
the `docker` group is active:

```bash
sudo reboot
ssh server@server
```

The current machine has Secure Boot disabled. If `nvidia-smi` still fails after
reboot, check Secure Boot/module-signing state before changing the application
configuration:

```bash
mokutil --sb-state
journalctl -k -b | grep -iE 'nvidia|nouveau|secure'
```

## 7. Download and verify the pinned models

If authentication is required, log in without putting a token in the
repository:

```bash
/home/server/.venvs/huggingface/bin/hf auth login
```

Then, preferably inside `tmux`:

```bash
cd /home/server/on-prem-workhorse
./deploy/server/download-models.sh
```

If a Hub login was needed only for this recovery, it can be removed after the
successful checksum verification with
`/home/server/.venvs/huggingface/bin/hf auth logout`.

The script downloads and verifies every file against these immutable Hub
commits:

- `nvidia/Gemma-4-26B-A4B-NVFP4` at
  `a19cfe00be84568a6867111c9a68c9c44fdcffe6`;
- `google/gemma-4-26B-A4B-it-assistant` at
  `6e5aaaf4c42b98394530b8fda2e95cadd65c151c`.

Downloads resume in place, a lock prevents two concurrent copies, and the
whole command can be rerun after a connection loss. The verified snapshots
occupy about 18 GiB and 832 MiB respectively.

## 8. Provision runtime secrets

On the server:

```bash
cd /home/server/on-prem-workhorse
cp .env.example .env
chmod 600 .env
$EDITOR .env
```

Fill the two nonempty service keys. For the current LeadsRun integration the
mapping is:

| on-prem variable | corresponding LeadsRun backend variable |
|---|---|
| `API_KEY` | `AI_PIPELINE_CHAT_API_KEY` |
| `SCRAPER_API_KEY` | `ELIGIBILITY_SCRAPER_API_KEY` |

Keep the production defaults already present in `.env.example`, especially
`VLLM_GPU_MEMORY_UTILIZATION=0.92` (changed from `0.90` at the operator's
request on 15 September 2026; see the [memory tutorial](../../docs/vllm-pamiec-krok-po-kroku.md)).
The previous `0.94` setting left too little
transient MoE workspace and could terminate the engine. Likewise, 450 W is the
measured production power cap; 600 W did not improve throughput.

For public LLM ingress, copy only the tunnel-specific JSON from an administrator
machine and fix its permissions:

```bash
ssh server@server 'mkdir -p /home/server/.cloudflared && chmod 700 /home/server/.cloudflared'
scp ~/.cloudflared/ca500d27-9a93-440c-9023-e1729c249e1e.json \
  server@server:/home/server/.cloudflared/
ssh server@server \
  'chmod 400 /home/server/.cloudflared/ca500d27-9a93-440c-9023-e1729c249e1e.json'
```

Do not copy the account-wide Cloudflare `cert.pem` to the server.

## 9. Build, start and verify the stack

Inside `tmux` on the server:

```bash
cd /home/server/on-prem-workhorse
./deploy/server/install-stack.sh
./deploy/server/verify.sh
```

The production image is digest-pinned vLLM **0.29.0**, with Model Runner V2,
`TRITON_ATTN` attention and `flashinfer_cutlass` MoE. The official Gemma MTP
fix is included upstream. Keep `.92`, batch `8192`, MTP×4 and 450 W.
Use `/home/server/.cache/vllm-gemma4-v029` for persistent compilation data;
benchmark result directories must not be production mounts.

The scheduler uses `VLLM_SCHEDULING_POLICY=priority`. Requests may set
`priority` in the JSON body: lower numbers run earlier, the default is `0`,
and arrival time breaks ties. Clients should bound their in-flight backlog
and allow urgent work to bypass their own background-request pool.

The first vLLM image build and first CUDA graph compilation take the longest.
The scripts may be rerun after interruption: Docker reuses finished layers,
model downloads resume, and Compose converges to the declared services. The
installer starts Cloudflare only when the expected credential file exists.

Expected endpoints after verification:

- private LLM: `http://192.168.1.15:8090`;
- private scraper: `http://192.168.1.15:3000`;
- public LLM: `https://model.leads.run`;
- unauthenticated `/health` on each service;
- authenticated LLM `/v1/*` with `Authorization: Bearer ...`;
- authenticated scraper endpoints with `x-api-key: ...`.

Set `VERIFY_PUBLIC_TUNNEL=no` when deliberately deploying without the tunnel:

```bash
VERIFY_PUBLIC_TUNNEL=no ./deploy/server/verify.sh
```

For an intentionally offline host, the real `example.com` Playwright smoke
test can also be skipped with `VERIFY_SCRAPER_FETCH=no`.

All three containers use `restart: unless-stopped`, Docker starts at boot, the
450 W limit is reapplied by systemd, and model/cache files remain on the NVMe.

## Recovery and diagnostics

| Symptom | Action |
|---|---|
| USB shows boot text, then `Input not supported` | Leave it alone and wait for automatic poweroff; the current RTX 5090 behaved this way before its driver was installed. |
| Target powers off during install | Expected success path. Remove USB and boot the NVMe. |
| Installer starts again | Power off and remove USB; firmware selected it again. |
| `ssh server@server` does not resolve | Use the router's DHCP lease/IP and add a reservation. |
| SSH/package/model/build session was interrupted | Reattach `tmux`, or rerun the same script. All setup scripts are convergent/resumable. |
| `nvidia-smi` fails after driver install | Reboot, then inspect Secure Boot and kernel logs. |
| LLM container is unhealthy | `docker logs --tail 200 ik-llama`; confirm both pinned snapshots and `.env` paths. |
| vLLM reports CUDA OOM in fused MoE | Return to the previous `0.90` memory utilization and keep the `8192` batched-token budget; recheck the mixed workload before raising utilization again. |
| Python `urllib` gets a public Cloudflare 403 but curl works | Supply a normal application `User-Agent`; the origin and bearer auth can still be healthy. |

Useful status commands:

```bash
nvidia-smi
systemctl status nvidia-power-limit.service
docker compose ps
docker compose logs -f ik-llama
docker compose -f deploy/cloudflared/docker-compose.yml ps
docker compose -f deploy/cloudflared/docker-compose.yml logs -f cloudflared
```

## Rollback after the 2026-09-15 migration

The server retains `on-prem-workhorse-vllm:v0.25.0-gemma4-mtp` and its original
`/home/server/.cache/vllm-gemma4-bench` cache. A server-local snapshot of the old
Compose file is at
`benchmark-results/vllm-upgrade-20260915/migration/rollback-compose.yml`.
For rollback, restore that file as the root `docker-compose.yml`, set only
`VLLM_CACHE_DIR=/home/server/.cache/vllm-gemma4-bench` in the existing `.env`,
and run `docker compose up -d --no-build --no-deps --force-recreate ik-llama`.
Preserve the existing keys, `.92`, batch `8192` and 450 W. Check health,
authenticated models and structured JSON again. The current `verify.sh`
intentionally requires 0.29, so its version check should fail after rollback;
the successful health, auth and JSON checks must be assessed separately.

This rollback depends on the retained old image; bare-metal recovery builds
only the current 0.29 image. Do not reapply the old MTP patch to 0.29.

## Deliberate upgrades

The Ubuntu release and its official checksum are pinned in
`deploy/autoinstall/build-image.sh`; changing the ISO requires changing and
reviewing both. vLLM and the Cloudflare image are pinned in Compose/Dockerfile,
and model revisions are pinned in `download-models.sh`. Do not float any of
these during disaster recovery. Upgrade one component at a time and rerun the
benchmark matrix before updating `VERIFIED_STATE.md`.

Primary references:

- [Ubuntu autoinstall reference](https://canonical-subiquity.readthedocs-hosted.com/en/latest/reference/autoinstall-reference.html)
- [Ubuntu 26.04.1 SHA-256 list](https://releases.ubuntu.com/26.04/SHA256SUMS)
- [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [NVIDIA Container Toolkit install guide](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- [Hugging Face CLI reference](https://huggingface.co/docs/huggingface_hub/en/package_reference/cli)
