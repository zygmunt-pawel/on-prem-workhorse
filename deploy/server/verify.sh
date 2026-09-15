#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $(id -u) -eq 0 ]]; then
  echo "Run this as the regular server account, not root." >&2
  exit 2
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd "$script_dir/../.." && pwd)
cd "$repo_root"

[[ -f .env ]] || { echo "Missing $repo_root/.env" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
source ./.env
set +a
[[ -n ${API_KEY:-} && -n ${SCRAPER_API_KEY:-} ]] || {
  echo "API keys are not configured in .env." >&2
  exit 1
}

require_setting() {
  local name=$1
  local actual=$2
  local expected=$3
  [[ "$actual" == "$expected" ]] || {
    echo "Unexpected production setting $name=$actual; expected $expected." >&2
    exit 1
  }
}

require_setting VLLM_MAX_MODEL_LEN "${VLLM_MAX_MODEL_LEN:-32768}" 32768
require_setting VLLM_MAX_NUM_SEQS "${VLLM_MAX_NUM_SEQS:-80}" 80
require_setting VLLM_MAX_NUM_BATCHED_TOKENS "${VLLM_MAX_NUM_BATCHED_TOKENS:-8192}" 8192
require_setting VLLM_GPU_MEMORY_UTILIZATION "${VLLM_GPU_MEMORY_UTILIZATION:-0.92}" 0.92
require_setting VLLM_KV_CACHE_DTYPE "${VLLM_KV_CACHE_DTYPE:-fp8}" fp8
require_setting VLLM_ATTENTION_BACKEND "${VLLM_ATTENTION_BACKEND:-TRITON_ATTN}" TRITON_ATTN
require_setting VLLM_MOE_BACKEND "${VLLM_MOE_BACKEND:-flashinfer_cutlass}" flashinfer_cutlass
require_setting VLLM_KV_CACHE_DTYPE_SKIP_LAYERS "${VLLM_KV_CACHE_DTYPE_SKIP_LAYERS:-}" ''

echo "Host: $(hostname) ($(uname -srmo))"
gpu_line=$(nvidia-smi --query-gpu=name,driver_version,memory.total,power.limit \
  --format=csv,noheader)
echo "GPU: $gpu_line"
grep -q 'NVIDIA GeForce RTX 5090' <<< "$gpu_line" || {
  echo "Expected an NVIDIA GeForce RTX 5090." >&2
  exit 1
}

power_limit=$(nvidia-smi --query-gpu=power.limit --format=csv,noheader,nounits | awk '{print int($1 + 0.5)}')
[[ "$power_limit" == 450 ]] || {
  echo "Expected the persistent 450 W cap; found ${power_limit} W." >&2
  exit 1
}
systemctl is-enabled --quiet docker
systemctl is-active --quiet docker
systemctl is-enabled --quiet nvidia-power-limit.service
systemctl is-active --quiet nvidia-power-limit.service

docker compose config --quiet
docker compose ps

for container in scraper ik-llama; do
  state=$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}} restart={{.HostConfig.RestartPolicy.Name}}' "$container")
  echo "$container: $state"
  [[ "$state" == running/healthy* ]] || exit 1
  [[ "$state" == *'restarts=0 restart=unless-stopped' ]] || {
    echo "$container has restarted or has the wrong restart policy." >&2
    exit 1
  }
done

llm_runtime=$(docker inspect --format '{{.HostConfig.Runtime}}' ik-llama)
llm_image=$(docker inspect --format '{{.Config.Image}}' ik-llama)
[[ "$llm_runtime" == nvidia ]] || { echo "ik-llama is not using the NVIDIA runtime." >&2; exit 1; }
[[ "$llm_image" == on-prem-workhorse-vllm:v0.29.0-gemma4-mtp ]] || {
  echo "Unexpected ik-llama image: $llm_image" >&2
  exit 1
}

python3 <<'PY'
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

runtime = json.loads(subprocess.check_output(["docker", "inspect", "ik-llama"]))[0]
runtime_env = dict(value.split("=", 1) for value in runtime["Config"]["Env"])
for name, expected in {
    "VLLM_USE_V2_MODEL_RUNNER": "1",
    "ON_PREM_VLLM_ATTENTION_BACKEND": "TRITON_ATTN",
    "ON_PREM_VLLM_MOE_BACKEND": "flashinfer_cutlass",
    "ON_PREM_VLLM_GPU_MEMORY_UTILIZATION": "0.92",
    "ON_PREM_VLLM_MAX_NUM_BATCHED_TOKENS": "8192",
    "ON_PREM_VLLM_MAX_NUM_SEQS": "80",
    "ON_PREM_VLLM_MAX_MODEL_LEN": "32768",
    "ON_PREM_VLLM_KV_CACHE_DTYPE": "fp8",
    "ON_PREM_VLLM_KV_CACHE_DTYPE_SKIP_LAYERS": "",
}.items():
    if runtime_env.get(name) != expected:
        raise SystemExit(f"FAIL: live container setting {name} differs from production")
version = subprocess.check_output([
    "docker", "exec", "ik-llama", "python3", "-c",
    "import vllm; print(vllm.__version__)",
], text=True).strip()
if version != "0.29.0":
    raise SystemExit(f"FAIL: unexpected live vLLM version {version}")
print("OK: live vLLM 0.29.0 / MRV2 / Triton / CUTLASS settings")

api_key = os.environ["API_KEY"]
scraper_key = os.environ["SCRAPER_API_KEY"]
user_agent = "on-prem-workhorse-verifier/1.0"


def request(url, *, headers=None, body=None, timeout=20):
    merged = {"User-Agent": user_agent, **(headers or {})}
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, headers=merged, data=data)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


checks = []
checks.append(("LLM health", *request("http://127.0.0.1:8090/health"), 200))
checks.append(("LLM rejects missing key", *request("http://127.0.0.1:8090/v1/models"), 401))
checks.append((
    "LLM authenticated models",
    *request(
        "http://127.0.0.1:8090/v1/models",
        headers={"Authorization": f"Bearer {api_key}"},
    ),
    200,
))

if os.environ.get("VERIFY_SCRAPER_FETCH", "yes") == "yes":
    checks.append((
        "scraper authenticated fetch",
        *request(
            "http://127.0.0.1:3000/scrape",
            headers={
                "Content-Type": "application/json",
                "x-api-key": scraper_key,
            },
            body={"url": "https://example.com", "maxChars": 2000},
            timeout=90,
        ),
        200,
    ))
checks.append(("scraper health", *request("http://127.0.0.1:3000/health"), 200))
checks.append((
    "scraper rejects missing key",
    *request(
        "http://127.0.0.1:3000/scrape",
        headers={"Content-Type": "application/json"},
        body={"url": "https://example.com"},
    ),
    401,
))

chat_status, chat_body = request(
    "http://127.0.0.1:8090/v1/chat/completions",
    headers={
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    },
    body={
        "model": "gemma-4-26B-A4B-it",
        "messages": [{"role": "user", "content": "Return a JSON object with ready set to true."}],
        "max_tokens": 1024,
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "readiness", "strict": True, "schema": {
                "type": "object", "properties": {"ready": {"type": "boolean"}},
                "required": ["ready"], "additionalProperties": False,
            },
        }},
        "temperature": 0,
    },
    timeout=300,
)
checks.append(("LLM chat completion", chat_status, chat_body, 200))

if os.environ.get("VERIFY_PUBLIC_TUNNEL", "yes") == "yes":
    checks.append(("public tunnel health", *request("https://model.leads.run/health"), 200))
    checks.append((
        "public tunnel authenticated models",
        *request(
            "https://model.leads.run/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
        ),
        200,
    ))

failed = False
for label, status, body, expected in checks:
    outcome = "OK" if status == expected else "FAIL"
    print(f"{outcome}: {label}: HTTP {status} (expected {expected})")
    if status != expected:
        failed = True
        print(body[:500].decode(errors="replace"))

if failed:
    sys.exit(1)

chat = json.loads(chat_body)
choice = chat["choices"][0]["message"]
models_body = next(body for label, _, body, _ in checks if label == "LLM authenticated models")
model_ids = {item["id"] for item in json.loads(models_body)["data"]}
if "gemma-4-26B-A4B-it" not in model_ids:
    raise SystemExit("FAIL: production served-model alias is missing")
if json.loads(choice.get("content") or "") != {"ready": True}:
    raise SystemExit("FAIL: structured JSON response differs from expected object")
if chat["choices"][0].get("finish_reason") != "stop":
    raise SystemExit("FAIL: structured JSON response was truncated")
print("OK: model returned the expected structured JSON response")
print("Content preview:", repr((choice.get("content") or "")[:160]))
PY

if docker inspect cloudflared >/dev/null 2>&1; then
  tunnel_state=$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}} restarts={{.RestartCount}} restart={{.HostConfig.RestartPolicy.Name}}' cloudflared)
  echo "cloudflared: $tunnel_state"
  [[ "$tunnel_state" == running/healthy* ]]
fi

echo "All deployment checks passed."
