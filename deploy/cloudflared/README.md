# Cloudflare Tunnel

Stable public ingress for the RTX 5090 LLM:

- Public hostname: `https://model.leads.run`
- Tunnel: `local-classifier-llm`
- Tunnel ID: `ca500d27-9a93-440c-9023-e1729c249e1e`
- Origin: `http://127.0.0.1:8090`

Only `/v1/*` and `/health` are routed to the origin. vLLM continues to enforce
`Authorization: Bearer <API_KEY>` on the OpenAI-compatible `/v1/*` endpoints.
The scraper is not exposed by this tunnel.

## Secret provisioning

The tunnel credential is deliberately stored outside the repository:

```text
/home/pawel/.cloudflared/ca500d27-9a93-440c-9023-e1729c249e1e.json
```

It must be owned by UID/GID `1000:1000` and readable only by its owner:

```bash
chmod 700 /home/pawel/.cloudflared
chmod 400 /home/pawel/.cloudflared/ca500d27-9a93-440c-9023-e1729c249e1e.json
```

The account-wide `cert.pem` is not needed on the server and must not be copied
there. The tunnel-specific JSON can only run this tunnel.

## Operations

Run these commands from the repository root on `local-classifier`:

```bash
docker compose -f deploy/cloudflared/docker-compose.yml up -d
docker compose -f deploy/cloudflared/docker-compose.yml ps
docker compose -f deploy/cloudflared/docker-compose.yml logs -f cloudflared
```

The container uses `restart: unless-stopped`, so Docker brings it back after a
host reboot. The hostname remains stable across container and host restarts.

Verify the public route:

```bash
curl https://model.leads.run/health
curl https://model.leads.run/v1/models \
  -H "Authorization: Bearer ${API_KEY}"
```

For long generations, prefer OpenAI streaming (`"stream": true`). Unlike a
TryCloudflare Quick Tunnel, the named tunnel supports Server-Sent Events.

## Cloudflare-side management

Run account-level commands only from an administrator machine that holds
`~/.cloudflared/cert.pem`:

```bash
cloudflared tunnel info ca500d27-9a93-440c-9023-e1729c249e1e
cloudflared tunnel route dns --overwrite-dns \
  ca500d27-9a93-440c-9023-e1729c249e1e model.leads.run
```

Deleting the tunnel revokes its credential. Rotating the LLM bearer key is
independent: update the main stack's `.env` and recreate `ik-llama`.
