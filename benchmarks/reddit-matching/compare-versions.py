#!/usr/bin/env python3
"""Isolated, reversible comparison on the single production GPU.

Pre-pull/build candidate images before running. Production is stopped only for
the GPU test window and its original container is restarted in finally. Run in
tmux so an SSH disconnect cannot interrupt cleanup. No production config changes.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
NAME = "vllm-version-benchmark"


def command(args, **kwargs):
    return subprocess.run(args, check=True, text=True, **kwargs)


def inspect(name):
    return json.loads(command(["docker", "inspect", name], capture_output=True).stdout)[0]


def healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as r:
            return r.status == 200
    except OSError:
        return False


def wait_ready(name, port, timeout=900):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if healthy(port):
            return True
        if not inspect(name)["State"]["Running"]:
            return False
        time.sleep(5)
    return False


def drain():
    # Require three consecutive idle observations before stopping production.
    idle = 0
    for _ in range(60):
        with urllib.request.urlopen("http://127.0.0.1:8090/metrics", timeout=5) as r:
            lines = r.read().decode().splitlines()
        counts = [float(line.rsplit(" ", 1)[1]) for line in lines
                  if line.startswith(("vllm:num_requests_running{", "vllm:num_requests_waiting{"))]
        if not counts:
            raise RuntimeError("Cannot verify production is idle")
        idle = idle + 1 if sum(counts) == 0 else 0
        if idle == 3:
            return
        time.sleep(5)
    raise RuntimeError("Production stayed busy; test window not started")


def safe_logs(secret):
    result = subprocess.run(["docker", "logs", NAME], capture_output=True, text=True)
    return (result.stdout + result.stderr).replace(secret, "[REDACTED]")


def smoke(secret, port):
    base = f"http://127.0.0.1:{port}"
    try:
        urllib.request.urlopen(base + "/v1/models", timeout=10)
    except urllib.error.HTTPError as error:
        if error.code != 401:
            raise
    else:
        raise RuntimeError("Unauthenticated model endpoint did not reject the request")
    request = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps({
        "model": "gemma-4-26B-A4B-it", "temperature": 0, "max_tokens": 1024,
        "messages": [{"role": "user", "content": "Return a JSON object with ready set to true."}],
        "chat_template_kwargs": {"enable_thinking": False},
        "response_format": {"type": "json_schema", "json_schema": {
            "name": "readiness", "strict": True, "schema": {"type": "object",
                "properties": {"ready": {"type": "boolean"}},
                "required": ["ready"], "additionalProperties": False}}},
    }).encode(), headers={"Authorization": f"Bearer {secret}", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        body = json.load(response)
    message = body["choices"][0]["message"]
    if json.loads(message["content"]) != {"ready": True}:
        raise RuntimeError("Chat structured-output smoke failed")
    return {"auth": "ok", "chatStructuredOutput": "ok", "messageFields": sorted(message),
            "usage": body.get("usage")}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--debug-profiling", action="store_true")
    parser.add_argument("--workload", choices=["reddit", "cache-pressure"], default="reddit")
    parser.add_argument("--pressure-output-tokens", type=int, default=512)
    parser.add_argument("--pressure-levels", type=int, nargs="+", default=[32, 96])
    parser.add_argument("--pressure-modes", choices=["shared", "independent"], nargs="+",
                        default=["shared", "independent"])
    parser.add_argument("--startup-only", action="store_true",
                        help="Measure startup/cache and run auth/JSON smoke without the workload")
    parser.add_argument("--variants", nargs="+", default=["v025", "v029"])
    args = parser.parse_args()
    output = Path(args.output).resolve()
    if (output / "comparison.json").exists():
        raise RuntimeError("Use a new output directory to preserve earlier results")
    output.mkdir(parents=True, exist_ok=True)
    guard = Path("/tmp/on-prem-vllm-version-benchmark.lock").open("w")
    fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if subprocess.run(["docker", "inspect", NAME], capture_output=True).returncode == 0:
        raise RuntimeError(f"Existing {NAME} container; inspect it before running")
    production = inspect("ik-llama")
    if not production["State"]["Running"]:
        raise RuntimeError("Production must be running before the comparison")
    source_env = dict(item.split("=", 1) for item in production["Config"]["Env"])
    secret = source_env["VLLM_API_KEY"]
    required = {
        "ON_PREM_VLLM_GPU_MEMORY_UTILIZATION": "0.92",
        "ON_PREM_VLLM_MAX_NUM_BATCHED_TOKENS": "8192",
        "ON_PREM_VLLM_MAX_NUM_SEQS": "80",
        "ON_PREM_VLLM_MAX_MODEL_LEN": "32768",
        "ON_PREM_VLLM_KV_CACHE_DTYPE": "fp8",
    }
    for key, value in required.items():
        if source_env.get(key) != value:
            raise RuntimeError(f"Unexpected production setting {key}; inspect before testing")
    power = command(["nvidia-smi", "--query-gpu=power.limit", "--format=csv,noheader,nounits"], capture_output=True).stdout
    if float(power.strip()) != 450:
        raise RuntimeError("Expected the production 450 W cap")
    images = {
        "baseline": production["Image"],  # Current production, not a version label.
        "v025": "on-prem-workhorse-vllm:v0.25.0-gemma4-mtp",
        "v029": "vllm/vllm-openai:v0.29.0@sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1",
        "v029_mrv1": "vllm/vllm-openai:v0.29.0@sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1",
        "v029_flashinfer": "vllm/vllm-openai:v0.29.0@sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1",
        "b12x": "on-prem-workhorse-vllm-benchmark:v0.29.0-b12x-1.2.6",
        "flashinfer_b12x": "vllm/vllm-openai:v0.29.0@sha256:c2914767605584b6d8f45686b82de173ecc99e781897aa3d0a66dacd72c51ae1",
    }
    image_ids = {v: inspect(images[v])["Id"] for v in args.variants}
    models = next(m["Source"] for m in production["Mounts"] if m["Destination"] == "/models")
    metadata = {"productionImage": production["Image"], "variants": image_ids,
                "settings": required, "powerLimitWatts": 450, "speculativeTokens": 4,
                "repetitions": args.repetitions, "debugProfiling": args.debug_profiling,
                "startupOnly": args.startup_only,
                "workload": args.workload,
                "pressureOutputTokens": args.pressure_output_tokens,
                "pressureLevels": args.pressure_levels, "pressureModes": args.pressure_modes,
                "restored": False}
    meta_path = output / "comparison.json"
    meta_path.write_text(json.dumps(metadata, indent=2) + "\n")
    stopped = False

    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")

    signal.signal(signal.SIGTERM, interrupted)
    try:
        drain()
        print("Stopping production for the isolated GPU benchmark", flush=True)
        stopped = True
        command(["docker", "stop", "--time", "60", "ik-llama"], stdout=subprocess.DEVNULL)
        for variant in args.variants:
            folder = output / variant
            folder.mkdir(exist_ok=True)
            env = {k: v for k, v in source_env.items()
                   if k.startswith("ON_PREM_") or k in ("VLLM_API_KEY", "VLLM_NO_USAGE_STATS", "DO_NOT_TRACK", "PYTORCH_ALLOC_CONF", "NVIDIA_VISIBLE_DEVICES")}
            env["ON_PREM_VLLM_MOE_BACKEND"] = (
                variant if variant in ("b12x", "flashinfer_b12x") else "flashinfer_cutlass"
            )
            if variant == "v029_mrv1":
                env["VLLM_USE_V2_MODEL_RUNNER"] = "0"
            if args.debug_profiling:
                env["VLLM_LOGGING_LEVEL"] = "DEBUG"
            attention_backend = "FLASHINFER" if variant == "v029_flashinfer" else "TRITON_ATTN"
            env["ON_PREM_VLLM_ATTENTION_BACKEND"] = attention_backend
            # Pin candidate runners; baseline inherits the live runner selection.
            if variant == "baseline" and "VLLM_USE_V2_MODEL_RUNNER" in source_env:
                env["VLLM_USE_V2_MODEL_RUNNER"] = source_env["VLLM_USE_V2_MODEL_RUNNER"]
            elif variant not in ("baseline", "v025", "v029_mrv1"):
                env["VLLM_USE_V2_MODEL_RUNNER"] = "1"
            entrypoint = ROOT / "deploy/vllm/entrypoint.sh"
            cache = output / f"cache-{variant}"
            cache.mkdir(exist_ok=True)
            cmd = ["docker", "run", "-d", "--name", NAME, "--runtime", "nvidia", "--ipc", "host",
                   "--restart", "no", "-p", "127.0.0.1:8091:8000",
                   "-v", f"{models}:/models:ro", "-v", f"{cache}:/root/.cache",
                   "-v", f"{ROOT / 'benchmarks/reddit-matching'}:/benchmark:ro",
                   "-v", f"{folder}:/results",
                   "-v", f"{entrypoint}:/benchmark-entrypoint.sh:ro",
                   "--entrypoint", "/bin/bash"]
            for key in env:
                cmd.extend(["--env", key])
            cmd.extend([image_ids[variant], "/benchmark-entrypoint.sh"])
            print(f"Starting {variant}", flush=True)
            started = time.monotonic()
            command(cmd, env={**os.environ, **env}, stdout=subprocess.DEVNULL)
            status = {"variant": variant, "image": image_ids[variant],
                      "runnerOverride": env.get("VLLM_USE_V2_MODEL_RUNNER"),
                      "attentionBackendOverride": attention_backend,
                      "debugProfiling": args.debug_profiling}
            try:
                ready = wait_ready(NAME, 8091)
                status["startupSeconds"] = round(time.monotonic() - started, 2)
                if not ready:
                    status["status"] = "startup_failed"
                    print(f"{variant}: startup failed", flush=True)
                    continue
                (folder / "smoke.json").write_text(json.dumps(smoke(secret, 8091), indent=2) + "\n")
                if args.startup_only:
                    status["status"] = "startup_ok"
                    print(f"{variant}: startup and smoke passed", flush=True)
                    continue
                run_env = {**os.environ, "API_KEY": secret}
                for key, value in required.items():
                    run_env[key.removeprefix("ON_PREM_")] = value
                test = ["docker", "exec", "--env", "API_KEY"]
                for key in required:
                    test.extend(["--env", key.removeprefix("ON_PREM_")])
                workload_script = "cache-pressure.py" if args.workload == "cache-pressure" else "validate-version.py"
                test.extend([NAME, "python3", f"/benchmark/{workload_script}",
                             "--base-url", "http://127.0.0.1:8000", "--variant", variant,
                             "--repetitions", str(args.repetitions), "--output", "/results/result.json"])
                if args.workload == "cache-pressure":
                    test.extend(["--output-tokens", str(args.pressure_output_tokens),
                                 "--levels", *map(str, args.pressure_levels),
                                 "--modes", *args.pressure_modes])
                with (folder / "console.log").open("w") as log:
                    result = subprocess.run(test, env=run_env, stdout=log, stderr=subprocess.STDOUT, timeout=2400)
                status["status"] = "ok" if result.returncode == 0 else "benchmark_failed"
                print(f"{variant}: {status['status']}", flush=True)
            except Exception as error:
                status["status"] = "validation_failed"
                status["error"] = str(error).replace(secret, "[REDACTED]")
                print(f"{variant}: {status['status']}: {status['error']}", flush=True)
            finally:
                (folder / "runtime.log").write_text(safe_logs(secret))
                status["containerState"] = inspect(NAME)["State"]
                (folder / "status.json").write_text(json.dumps(status, indent=2) + "\n")
                command(["docker", "rm", "-f", NAME], stdout=subprocess.DEVNULL)
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        # Same container, image, environment, mounts and restart policy as before.
        subprocess.run(["docker", "rm", "-f", NAME], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if stopped:
            print("Restoring the original production container", flush=True)
            command(["docker", "start", "ik-llama"], stdout=subprocess.DEVNULL)
            metadata["restored"] = wait_ready("ik-llama", 8090)
            meta_path.write_text(json.dumps(metadata, indent=2) + "\n")
            if not metadata["restored"]:
                raise RuntimeError("Production did not become healthy after restoration")
            (output / "restored-smoke.json").write_text(json.dumps(smoke(secret, 8090), indent=2) + "\n")
            print("Production restored and healthy", flush=True)


if __name__ == "__main__":
    main()
