# on-prem-workhorse

Self-hosted inference stack: scraper microservice + ik-llama GPU server + Cloudflare tunnel.

## Deployment

Auto-deployed via systemd user timer polling GitHub every 5 minutes. On new commits to `main`, the timer runs `deploy/auto-deploy.sh` which fetches Azure Key Vault secrets and rebuilds containers.

### Setup auto-deploy timer on a new machine

```bash
# Copy unit files
cp deploy/auto-deploy.{service,timer} ~/.config/systemd/user/

# Enable and start
systemctl --user daemon-reload
systemctl --user enable --now auto-deploy.timer

# Persist across reboots (without login)
loginctl enable-linger $USER
```
