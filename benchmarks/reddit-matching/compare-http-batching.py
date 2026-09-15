#!/usr/bin/env python3
"""Compare a prompt list in one HTTP request with concurrent single-prompt requests.

Run inside the existing vLLM container. No server restart/config changes.
Each wave has its own HTTP pool and cache salt; failures are never retried.
"""
import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import time

import aiohttp
import jsonschema
from transformers import AutoTokenizer

spec = importlib.util.spec_from_file_location("pressure", Path(__file__).with_name("cache-pressure.py"))
pressure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pressure)
MODEL = "gemma-4-26B-A4B-it"


def digest(value):
    return hashlib.sha256(json.dumps(value, separators=(",", ":")).encode()).hexdigest()


class Experiment:
    def __init__(self, args):
        self.args = args
        self.count = args.prompts_per_wave
        self.secret = os.environ["API_KEY"]
        self.tokenizer = AutoTokenizer.from_pretrained(
            "/models/Gemma-4-26B-A4B-NVFP4", local_files_only=True)
        self.prompt_lengths = {}
        self.report = {"status": "running", "runId": args.run_id, "repetitions": args.repetitions,
                       "endpoint": "/v1/completions", "transport": "non-streaming",
                       "promptsPerWave": self.count, "promptTokens": 8192, "outputTokens": 512,
                       "connectionReuseScope": "wave", "warmPrime": "exact first 6144 input tokens, 32 output tokens",
                       "waves": [], "jsonChecks": [],
                       "prefixProbes": []}

    def save(self):
        Path(self.args.output).write_text(json.dumps(self.report, indent=2).replace(
            self.secret, "[REDACTED]") + "\n")

    def session(self):
        return aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=0), headers={
            "Authorization": f"Bearer {self.secret}", "User-Agent": "on-prem-batching-benchmark/1.0"})

    async def idle(self, session):
        for _ in range(60):
            m = await pressure.metrics(session, self.args.base_url)
            if m.get("num_requests_running", 0) == m.get("num_requests_waiting", 0) == 0:
                return
            await asyncio.sleep(1)
        raise RuntimeError("Server did not become idle")

    def text(self, tokens):
        text = self.tokenizer.decode(tokens, skip_special_tokens=False)
        assert self.tokenizer.encode(text, add_special_tokens=False) == tokens
        self.prompt_lengths[text] = len(tokens)
        return text

    async def post(self, session, prompts, salt, output_tokens, structured=False):
        payload = {"model": MODEL, "prompt": prompts[0] if len(prompts) == 1 else prompts,
                   "temperature": 0, "max_tokens": output_tokens, "stream": False,
                   "n": 1, "add_special_tokens": False, "cache_salt": salt}
        schema = {"type": "object", "properties": {"record_id": {"type": "integer"},
                  "ready": {"type": "boolean"}}, "required": ["record_id", "ready"],
                  "additionalProperties": False}
        if structured:
            payload["response_format"] = {"type": "json_schema", "json_schema": {
                "name": "record", "strict": True, "schema": schema}}
        else:
            payload.update(min_tokens=output_tokens, ignore_eos=True)
        started = time.perf_counter()
        async with session.post(self.args.base_url + "/v1/completions", json=payload,
                                timeout=aiohttp.ClientTimeout(total=600)) as response:
            body = await response.json()
            if response.status != 200:
                raise RuntimeError(f"HTTP {response.status}: {str(body)[:300]}")
        received_at = time.perf_counter()
        elapsed = received_at - started
        choices = sorted(body["choices"], key=lambda c: c["index"])
        assert [c["index"] for c in choices] == list(range(len(prompts)))
        expected_input = sum(self.prompt_lengths[p] for p in prompts)
        assert body["usage"]["prompt_tokens"] == expected_input, body["usage"]
        if not structured:
            assert body["usage"]["completion_tokens"] == output_tokens * len(prompts), body["usage"]
            assert all(c["finish_reason"] == "length" for c in choices)
        records = []
        for c in choices:
            row = {"index": c["index"], "sha256": digest(c["text"]),
                   "finishReason": c["finish_reason"]}
            if structured:
                parsed = json.loads(c["text"])
                jsonschema.validate(parsed, schema)
                assert c["finish_reason"] == "stop"
                row["json"] = parsed
            records.append(row)
        return {"seconds": elapsed, "receivedAt": received_at, "choices": records, "usage": body["usage"]}

    async def wave(self, prompts, prime, batch_size, cache_state, rep):
        salt = f"{self.args.run_id}:{rep}:{cache_state}:{batch_size}"
        async with self.session() as session:
            await self.idle(session)
            if cache_state == "warm":
                await self.post(session, [prime], salt, 32)
                await self.idle(session)
            before = await pressure.metrics(session, self.args.base_url)
            samples, metric_errors = [], []
            stop = asyncio.Event()
            start = time.perf_counter()
            async def monitor():
                while not stop.is_set():
                    try:
                        samples.append(await pressure.metrics(session, self.args.base_url))
                    except Exception as error:
                        metric_errors.append(str(error))
                    try:
                        await asyncio.wait_for(stop.wait(), .25)
                    except asyncio.TimeoutError:
                        pass
            monitor_task = asyncio.create_task(monitor())
            try:
                results = await asyncio.gather(*(self.post(session, prompts[i:i+batch_size], salt, 512)
                                                for i in range(0, self.count, batch_size)), return_exceptions=True)
            finally:
                wall = time.perf_counter() - start
                stop.set()
                await monitor_task
            after = await pressure.metrics(session, self.args.base_url)
        errors = [str(x) for x in results if isinstance(x, Exception)]
        valid = [x for x in results if not isinstance(x, Exception)]
        validation_wall = wall
        wall = max((r["receivedAt"] for r in valid), default=start) - start
        queries = after["prefix_cache_queries_total"] - before["prefix_cache_queries_total"]
        hits = after["prefix_cache_hits_total"] - before["prefix_cache_hits_total"]
        row = {"batchSize": batch_size, "httpRequests": self.count // batch_size, "cacheState": cache_state,
               "repetition": rep, "inputSha256": digest(prompts),
               "first64InputSha256": digest(prompts[:64]), "wallSeconds": wall,
               "wallIncludingValidationSeconds": validation_wall,
               "outputTokensPerSecond": sum(x["usage"]["completion_tokens"] for x in valid) / max(wall, 1e-9),
               "prefixQueries": queries, "prefixHits": hits, "prefixHitPct": 100 * hits / max(queries, 1),
               "runningMax": max((m["num_requests_running"] for m in samples), default=0),
               "waitingMax": max((m["num_requests_waiting"] for m in samples), default=0),
               "kvPeakPct": 100 * max((m["kv_cache_usage_perc"] for m in samples), default=0),
               "preemptions": after["num_preemptions_total"] - before["num_preemptions_total"],
               "errors": errors, "metricsErrors": metric_errors, "responses": valid}
        self.report["waves"].append(row)
        self.save()
        print(f"DONE {cache_state} batch={batch_size} rep={rep}: {wall:.2f}s, "
              f"prefix={row['prefixHitPct']:.2f}%, running={row['runningMax']}, errors={len(errors)}", flush=True)
        if errors or metric_errors:
            raise RuntimeError("Wave failed; partial results saved")

    async def json_check(self, batch_size):
        prompts = [f"<bos><|turn>user\nReturn JSON with record_id equal to {i} and ready equal to true."
                   "\n<turn|>\n<|turn>model\n<|channel>final\n<channel|>\n" for i in range(self.count)]
        self.prompt_lengths.update({p: len(self.tokenizer.encode(p, add_special_tokens=False)) for p in prompts})
        async with self.session() as session:
            await self.idle(session)
            responses = await asyncio.gather(*(self.post(
                session, prompts[i:i+batch_size], f"{self.args.run_id}:json:{batch_size}", 128, True)
                for i in range(0, self.count, batch_size)))
        choices = [c for r in responses for c in r["choices"]]
        assert [c["json"] for c in choices] == [{"record_id": i, "ready": True} for i in range(self.count)]
        self.report["jsonChecks"].append({"batchSize": batch_size, "validated": len(choices),
                                           "inputSha256": digest(prompts), "responses": responses})
        self.save()
        print(f"JSON batch={batch_size}: {self.count}/{self.count} schema and record IDs verified", flush=True)

    async def prefix_probes(self):
        for output_tokens in (1, 32):
            for mode in ("shared", "independent", "exact-prefix"):
                token_prompts, _, common, _ = pressure.make_prompts(
                    self.tokenizer, "shared" if mode == "exact-prefix" else mode, self.count, 1, 8192, 6144, phase_count=64)
                prompts = [self.text(p) for p in token_prompts[:2]]
                if mode == "exact-prefix":
                    prompts[0] = self.text(token_prompts[0][:6144])
                    common = 6144
                salt = f"{self.args.run_id}:probe:{mode}:{output_tokens}"
                async with self.session() as session:
                    await self.idle(session)
                    for label, prompt in [("first", prompts[0]), ("different-record", prompts[1]),
                                          ("identical-repeat", prompts[1])]:
                        before = await pressure.metrics(session, self.args.base_url)
                        result = await self.post(session, [prompt], salt, output_tokens)
                        await self.idle(session)
                        after = await pressure.metrics(session, self.args.base_url)
                        queries = after["prefix_cache_queries_total"] - before["prefix_cache_queries_total"]
                        hits = after["prefix_cache_hits_total"] - before["prefix_cache_hits_total"]
                        row = {"layout": mode, "probe": label, "commonPrefixTokens": common,
                               "outputTokens": output_tokens, "prefixHits": hits, "prefixQueries": queries,
                               "seconds": result["seconds"], "inputSha256": digest(prompt)}
                        self.report["prefixProbes"].append(row)
                        self.save()
                        print(f"CACHE {mode}/{label} output={output_tokens}: {hits}/{queries} token hits", flush=True)

    async def run(self):
        self.save()
        try:
            await self.prefix_probes()
            for size in (self.count, 1):
                await self.json_check(size)
            # Warm kernels before measurements, in a separate cache namespace.
            tokens, _, _, _ = pressure.make_prompts(self.tokenizer, "shared", self.count, 0, 8192, 6144, phase_count=64)
            async with self.session() as session:
                await self.post(session, [self.text(p) for p in tokens], f"{self.args.run_id}:warmup", 512)
            for rep in range(1, self.args.repetitions + 1):
                tokens, _, common, _ = pressure.make_prompts(self.tokenizer, "shared", self.count, rep, 8192, 6144, phase_count=64)
                prompts = [self.text(p) for p in tokens]
                self.report["commonPrefixTokens"] = common
                sizes = (self.count, 1) if rep % 2 else (1, self.count)
                states = ("cold", "warm") if rep % 2 else ("warm", "cold")
                for state in states:
                    for size in sizes:
                        print(f"START {state} batch={size} rep={rep}", flush=True)
                        await self.wave(prompts, self.text(tokens[0][:6144]), size, state, rep)
            self.report["summary"] = [{"cacheState": state, "batchSize": size,
                "wallSecondsMedian": statistics.median(r["wallSeconds"] for r in self.report["waves"]
                    if r["cacheState"] == state and r["batchSize"] == size),
                "prefixHitPctMean": statistics.fmean(r["prefixHitPct"] for r in self.report["waves"]
                    if r["cacheState"] == state and r["batchSize"] == size)}
                for state in ("cold", "warm") for size in (self.count, 1)]
            self.report["status"] = "ok"
        except BaseException as error:
            self.report["status"] = "failed"
            self.report["error"] = str(error)
            raise
        finally:
            self.save()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--prompts-per-wave", type=int, choices=(64, 80), default=64)
    asyncio.run(Experiment(parser.parse_args()).run())
