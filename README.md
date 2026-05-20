# on-prem-workhorse

Self-hosted inference stack: scraper microservice + ik-llama GPU server + Cloudflare tunnel.

Fully self-hosted — no cloud dependencies. Secrets live in a local `.env` file.

## Deployment

### First-time setup on a new machine

```bash
git clone git@github.com:zygmunt-pawel/on-prem-workhorse.git
cd on-prem-workhorse

# Create the local config from the template and fill in the real values
cp .env.example .env
$EDITOR .env

# Build and start everything
docker compose up -d --build
```

`docker compose` reads `.env` automatically. The file is gitignored and never
committed — it holds the API keys and the Cloudflare tunnel token.

### Updating

```bash
git pull
docker compose up -d --build
```
