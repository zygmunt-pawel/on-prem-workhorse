#!/usr/bin/env python3
"""Fixed-token synthetic load: measure active KV pressure, queues and throughput.

Run inside the isolated benchmark container. This is a resource stress test,
not a JSON quality benchmark. EOS is ignored to give both versions equal work.
"""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import time

import aiohttp
from transformers import AutoTokenizer


MODEL = "gemma-4-26B-A4B-it"
GAUGES = ("kv_cache_usage_perc", "num_requests_running", "num_requests_waiting")
COUNTERS = ("num_preemptions_total", "prefix_cache_hits_total",
            "prefix_cache_queries_total", "request_queue_time_seconds_sum",
            "request_queue_time_seconds_count", "request_prefill_time_seconds_sum",
            "request_prefill_time_seconds_count")


def percentile(values, q):
    if not values:
        return None
    values = sorted(values)
    position = (len(values) - 1) * q
    low = math.floor(position)
    high = math.ceil(position)
    return values[low] + (values[high] - values[low]) * (position - low)


def parse_metrics(body):
    result = {}
    wanted = {"vllm:" + x for x in GAUGES + COUNTERS}
    for line in body.splitlines():
        if not line or line.startswith("#"):
            continue
        metric, value = line.rsplit(" ", 1)
        name = metric.split("{", 1)[0]
        if name in wanted:
            result[name.removeprefix("vllm:")] = result.get(name.removeprefix("vllm:"), 0) + float(value)
    return result


def make_prompts(tokenizer, mode, count, repetition, prompt_tokens, shared_tokens, run_id=""):
    encode = lambda text: tokenizer.encode(text, add_special_tokens=False)
    suffix = encode("\nWrite a detailed numbered review of the operational records. "
                    "Explain gaps and actions in complete sentences.\n"
                    "<turn|>\n<|turn>model\n<|channel>thought\n<channel|>\n")
    material = encode(("The team collects operational evidence from email and shared drives. "
                       "Reviewers check dates, owners, source records and missing approvals. "
                       "Every finding needs a traceable source and a concrete follow-up action.\n") * 1600)
    phase = f"pressure-{mode}-{count}-{repetition}" + (f"-{run_id}" if run_id else "")

    def block(header, size):
        tokens = encode(header)
        assert len(tokens) < size and len(material) >= size
        return (tokens + material)[:size]

    prefix = block(f"<bos><|turn>user\nBatch {phase}. Shared review instructions:\n", shared_tokens)
    prompts = []
    for i in range(count):
        if mode == "shared":
            tokens = prefix + block(f"\nIndependent record {i:06d}:\n",
                                    prompt_tokens - shared_tokens - len(suffix)) + suffix
        else:
            tokens = block(f"<bos><|turn>user\nIndependent record {i:06d}, batch {phase}:\n",
                           prompt_tokens - len(suffix)) + suffix
        assert len(tokens) == prompt_tokens
        prompts.append(tokens)
    common = 0
    for columns in zip(*prompts):
        if len(set(columns)) != 1:
            break
        common += 1
    digest = hashlib.sha256(json.dumps(prompts, separators=(",", ":")).encode()).hexdigest()
    return prompts, prefix + suffix, common, digest


async def metrics(session, base):
    async with session.get(base + "/metrics", timeout=aiohttp.ClientTimeout(total=5)) as response:
        response.raise_for_status()
        return parse_metrics(await response.text())


async def complete(session, base, prompt, output_tokens):
    start = time.perf_counter()
    first = None
    usage = None
    finish = None
    digest = hashlib.sha256()
    try:
        async with session.post(base + "/v1/completions", json={
            "model": MODEL, "prompt": prompt, "temperature": 0,
            "max_tokens": output_tokens, "min_tokens": output_tokens,
            "ignore_eos": True, "stream": True,
            "stream_options": {"include_usage": True},
        }, timeout=aiohttp.ClientTimeout(total=1200)) as response:
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}: {(await response.text())[:300]}")
            async for raw in response.content:
                line = raw.decode().strip()
                if not line.startswith("data: ") or line == "data: [DONE]":
                    continue
                body = json.loads(line[6:])
                if body.get("error"):
                    raise RuntimeError(str(body["error"])[:300])
                if body.get("usage"):
                    usage = body["usage"]
                for choice in body.get("choices", []):
                    text = choice.get("text", "")
                    if text:
                        if first is None:
                            first = time.perf_counter() - start
                        digest.update(text.encode())
                    finish = choice.get("finish_reason") or finish
        if not usage or usage.get("completion_tokens") != output_tokens:
            raise RuntimeError(f"Unexpected output length/usage: {usage}")
        if usage.get("prompt_tokens") != len(prompt):
            raise RuntimeError(f"Unexpected input length: {usage}")
        return {"seconds": time.perf_counter() - start, "ttftSeconds": first,
                "usage": usage, "finishReason": finish, "sha256": digest.hexdigest()}
    except Exception as error:
        return {"seconds": time.perf_counter() - start, "error": str(error),
                "errorType": type(error).__name__}


async def phase(session, base, prompts, prime, common, digest, mode, count, rep, args):
    # Keep old phases from contributing active blocks or queue entries.
    before = await metrics(session, base)
    if before.get("num_requests_running", 0) or before.get("num_requests_waiting", 0):
        raise RuntimeError("Server was not idle at the phase boundary")
    if mode == "shared":
        primed = await complete(session, base, prime, 1)
        if "error" in primed:
            raise RuntimeError(f"Prefix prime failed: {primed['error']}")
    before = await metrics(session, base)
    samples, metric_errors = [], []
    stopped = asyncio.Event()
    start = time.perf_counter()

    async def sample():
        while not stopped.is_set():
            try:
                samples.append({"seconds": time.perf_counter() - start,
                                **await metrics(session, base)})
            except Exception as error:
                metric_errors.append(str(error))
            try:
                await asyncio.wait_for(stopped.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                pass

    monitor = asyncio.create_task(sample())
    try:
        responses = await asyncio.gather(*(complete(session, base, p, args.output_tokens) for p in prompts))
    finally:
        stopped.set()
        await monitor
    wall = time.perf_counter() - start
    after = await metrics(session, base)
    delta = {key: after.get(key, 0) - before.get(key, 0) for key in COUNTERS}
    valid = [r for r in responses if "error" not in r]
    latencies = [r["seconds"] for r in valid]
    ttft = [r["ttftSeconds"] for r in valid if r["ttftSeconds"] is not None]
    output = sum(r["usage"]["completion_tokens"] for r in valid)
    seconds_full = sum(b["seconds"] - a["seconds"] for a, b in zip(samples, samples[1:])
                       if a.get("kv_cache_usage_perc", 0) >= 0.95)
    return {"mode": mode, "requests": count, "repetition": rep,
            "commonPrefixTokens": common, "inputSha256": digest,
            "wallSeconds": wall, "successfulRequests": len(valid),
            "outputTokens": output, "outputTokensPerSecond": output / wall,
            "requestsPerSecond": len(valid) / wall,
            "latencyP50Seconds": percentile(latencies, 0.5),
            "latencyP95Seconds": percentile(latencies, 0.95),
            "ttftP50Seconds": percentile(ttft, 0.5), "ttftP95Seconds": percentile(ttft, 0.95),
            "queueMeanSeconds": delta["request_queue_time_seconds_sum"] / max(delta["request_queue_time_seconds_count"], 1),
            "kvPeakPct": 100 * max((s.get("kv_cache_usage_perc", 0) for s in samples), default=0),
            "secondsAtLeast95PctKV": seconds_full,
            "waitingMax": max((s.get("num_requests_waiting", 0) for s in samples), default=0),
            "runningMax": max((s.get("num_requests_running", 0) for s in samples), default=0),
            "preemptions": delta["num_preemptions_total"],
            "prefixHitPct": 100 * delta["prefix_cache_hits_total"] / max(delta["prefix_cache_queries_total"], 1),
            "counterDeltas": delta, "metricsErrors": metric_errors,
            "responses": responses, "samples": samples}


async def run(args):
    secret = os.environ["API_KEY"]
    tokenizer = AutoTokenizer.from_pretrained("/models/Gemma-4-26B-A4B-NVFP4", local_files_only=True)
    report = {"variant": args.variant, "workload": "fixed-token-cache-pressure",
              "promptTokens": args.prompt_tokens, "outputTokens": args.output_tokens,
              "sharedTokens": args.shared_tokens, "repetitions": args.repetitions,
              "levels": args.levels, "modes": args.modes, "ignoreEOS": True,
              "connectionReuseScope": "phase", "runId": args.run_id,
              "phases": [], "status": "running"}
    path = Path(args.output)
    def save():
        path.write_text(json.dumps(report, indent=2).replace(secret, "[REDACTED]") + "\n")
    save()
    for rep in range(1, args.repetitions + 1):
        # Alternate mode order to reduce a systematic order effect.
        modes = args.modes if rep % 2 else list(reversed(args.modes))
        for mode in modes:
            for count in args.levels:
                prompts, prime, common, digest = make_prompts(
                    tokenizer, mode, count, rep, args.prompt_tokens,
                    args.shared_tokens, args.run_id)
                print(f"START {mode} n={count} repetition={rep}", flush=True)
                # Do not carry idle HTTP connections across long waves. Each
                # phase owns its pool; errors are recorded without retries.
                connector = aiohttp.TCPConnector(limit=0)
                async with aiohttp.ClientSession(
                    connector=connector, headers={"Authorization": f"Bearer {secret}"}
                ) as session:
                    result = await phase(session, args.base_url, prompts, prime,
                                         common, digest, mode, count, rep, args)
                report["phases"].append(result)
                save()
                print(f"DONE {mode} n={count}: {result['wallSeconds']:.2f}s, "
                      f"KV peak={result['kvPeakPct']:.1f}%, KV>=95%={result['secondsAtLeast95PctKV']:.1f}s, "
                      f"waiting={result['waitingMax']}, errors={count-result['successfulRequests']}", flush=True)
                if result["successfulRequests"] != count or result["metricsErrors"]:
                    report["status"] = "failed"
                    save()
                    return 1
    report["status"] = "ok"
    report["saturationObserved"] = {
        mode: any(p["secondsAtLeast95PctKV"] >= 2 and p["waitingMax"] > 0
                  for p in report["phases"] if p["mode"] == mode)
        for mode in args.modes}
    save()
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--variant", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-id", default="", help="Salt prompts to avoid reuse of an earlier run; use the same ID for both versions")
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--levels", type=int, nargs="+", default=[32, 96])
    parser.add_argument("--modes", choices=["shared", "independent"], nargs="+",
                        default=["shared", "independent"])
    parser.add_argument("--prompt-tokens", type=int, default=12288)
    parser.add_argument("--shared-tokens", type=int, default=9216)
    parser.add_argument("--output-tokens", type=int, default=512)
    raise SystemExit(asyncio.run(run(parser.parse_args())))
