#!/usr/bin/env python3
"""Maintain a fixed HTTP concurrency, replacing each completed request immediately.

Measure server generation counters during a steady interval, after warm-up;
then stop refilling and drain. Run exclusively against the existing container.
"""
import argparse
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import statistics
import time

spec = importlib.util.spec_from_file_location("batching", Path(__file__).with_name("compare-http-batching.py"))
batching = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batching)
pressure = batching.pressure
pressure.COUNTERS += ("generation_tokens_total",)


class Continuous:
    def __init__(self, args):
        self.args = args
        args.prompts_per_wave = 64
        self.client = batching.Experiment(args)
        self.report = {"status": "running", "runId": args.run_id,
                       "warmupSeconds": args.warmup, "measurementSeconds": args.duration,
                       "repetitions": args.repetitions, "cases": args.cases, "promptTokens": 8192,
                       "outputTokens": 512, "endpoint": "/v1/completions", "stream": False,
                       "refill": "immediate after each response", "phases": []}

    def save(self):
        Path(self.args.output).write_text(json.dumps(self.report, indent=2).replace(
            os.environ["API_KEY"], "[REDACTED]") + "\n")

    async def phase(self, prompts, http_concurrency, batch_size, repetition):
        concurrency = http_concurrency * batch_size
        salt = f"{self.args.run_id}:{http_concurrency}x{batch_size}:{repetition}"
        errors, results, samples = [], [], []
        next_index = 0
        stop = asyncio.Event()
        async with self.client.session() as session:
            await self.client.idle(session)
            before = await pressure.metrics(session, self.args.base_url)
            started = time.perf_counter()

            async def worker():
                nonlocal next_index
                while not stop.is_set():
                    index = next_index
                    next_index += batch_size
                    if index + batch_size > len(prompts):
                        errors.append("Unique prompt bank exhausted")
                        stop.set()
                        return
                    try:
                        response = await self.client.post(session, prompts[index:index+batch_size], salt, 512)
                        results.append({"firstPromptIndex": index, "sequences": batch_size, "seconds": response["seconds"],
                                        "receivedAfterSeconds": response["receivedAt"] - started,
                                        "completionTokens": response["usage"]["completion_tokens"],
                                        "outputSha256": batching.digest([c["sha256"] for c in response["choices"]])})
                    except Exception as error:
                        errors.append(str(error))
                        stop.set()
                        return

            tasks = [asyncio.create_task(worker()) for _ in range(http_concurrency)]
            async def sample():
                values = await pressure.metrics(session, self.args.base_url)
                values["seconds"] = time.perf_counter() - started
                return values
            try:
                await asyncio.sleep(self.args.warmup)
                samples.append(await sample())
                deadline = time.perf_counter() + self.args.duration
                next_progress = 10
                while time.perf_counter() < deadline and not stop.is_set():
                    await asyncio.sleep(min(.25, max(0, deadline-time.perf_counter())))
                    samples.append(await sample())
                    elapsed = samples[-1]["seconds"] - samples[0]["seconds"]
                    if elapsed >= next_progress:
                        rate = (samples[-1]["generation_tokens_total"] - samples[0]["generation_tokens_total"]) / elapsed
                        print(f"PROGRESS pool={http_concurrency}x{batch_size} rep={repetition}: "
                              f"{elapsed:.0f}s measured, {rate:.1f} output t/s, "
                              f"KV={100*samples[-1]['kv_cache_usage_perc']:.1f}%", flush=True)
                        next_progress += 10
                stop.set()
            finally:
                stop.set()
                await asyncio.gather(*tasks)
            await self.client.idle(session)
            after = await pressure.metrics(session, self.args.base_url)
            drained_wall = time.perf_counter() - started
        if len(samples) < 2:
            raise RuntimeError(f"No measurement interval: {errors}")
        first, last = samples[0], samples[-1]
        seconds = last["seconds"] - first["seconds"]
        output_tokens = last["generation_tokens_total"] - first["generation_tokens_total"]
        # Every reported peak covers >=10 seconds, avoiding one-step counter spikes.
        windows = []
        left = 0
        for right in range(1, len(samples)):
            while left + 1 < right and samples[right]["seconds"] - samples[left+1]["seconds"] >= 10:
                left += 1
            dt = samples[right]["seconds"] - samples[left]["seconds"]
            if dt >= 10:
                windows.append((samples[right]["generation_tokens_total"] - samples[left]["generation_tokens_total"]) / dt)
        def mean(name):
            return sum(samples[i][name] * (samples[i+1]["seconds"]-samples[i]["seconds"])
                       for i in range(len(samples)-1)) / seconds
        measured_total = after["generation_tokens_total"] - before["generation_tokens_total"]
        expected_total = sum(r["completionTokens"] for r in results)
        if measured_total != expected_total:
            errors.append(f"Generation counter differs from response usage: {measured_total} != {expected_total}")
        queries = last["prefix_cache_queries_total"] - first["prefix_cache_queries_total"]
        hits = last["prefix_cache_hits_total"] - first["prefix_cache_hits_total"]
        row = {"concurrency": concurrency, "httpConcurrency": http_concurrency,
               "batchSize": batch_size, "repetition": repetition,
               "measurementSecondsActual": seconds, "steadyOutputTokens": output_tokens,
               "steadyOutputTokensPerSecond": output_tokens/seconds,
               "peak10SecondOutputTokensPerSecond": max(windows, default=0),
               "kvMeanPct": 100*mean("kv_cache_usage_perc"),
               "kvPeakPct": 100*max(s["kv_cache_usage_perc"] for s in samples),
               "runningMean": mean("num_requests_running"),
               "runningMax": max(s["num_requests_running"] for s in samples),
               "waitingMean": mean("num_requests_waiting"),
               "waitingMax": max(s["num_requests_waiting"] for s in samples),
               "steadyPreemptions": last["num_preemptions_total"]-first["num_preemptions_total"],
               "totalPreemptions": after["num_preemptions_total"]-before["num_preemptions_total"],
               "prefixHitPct": 100*hits/max(queries, 1),
               "completedRequestsIncludingWarmupAndDrain": len(results),
               "completedSequencesIncludingWarmupAndDrain": sum(r["sequences"] for r in results),
               "totalOutputTokensIncludingWarmupAndDrain": measured_total,
               "totalSecondsIncludingWarmupAndDrain": drained_wall,
               "responseSecondsMedianIncludingWarmupAndDrain": statistics.median(r["seconds"] for r in results) if results else None,
               "responseSecondsP95IncludingWarmupAndDrain": pressure.percentile([r["seconds"] for r in results], .95),
               "errors": errors, "samples": samples, "responses": results}
        self.report["phases"].append(row)
        self.save()
        print(f"DONE pool={http_concurrency}x{batch_size} ({concurrency} sequences) rep={repetition}: {row['steadyOutputTokensPerSecond']:.1f} output t/s, "
              f"peak10s={row['peak10SecondOutputTokensPerSecond']:.1f}, "
              f"KV mean/max={row['kvMeanPct']:.1f}/{row['kvPeakPct']:.1f}%, "
              f"preemptions={row['steadyPreemptions']}, errors={len(errors)}", flush=True)
        if errors:
            raise RuntimeError("Continuous phase failed; partial results saved")

    async def run(self):
        self.save()
        try:
            print("Preparing 1024 unique prompts outside measurement", flush=True)
            tokens, _, common, _ = pressure.make_prompts(self.client.tokenizer, "shared", 1024, 1,
                                                        8192, 6144, phase_count=64)
            prompts = [self.client.text(p) for p in tokens]
            self.report.update(commonPrefixTokens=common, promptBankSha256=batching.digest(prompts))
            del tokens
            for repetition in range(1, self.args.repetitions+1):
                cases = self.args.cases if repetition % 2 else list(reversed(self.args.cases))
                for http_concurrency, batch_size in cases:
                    print(f"START pool={http_concurrency}x{batch_size} rep={repetition}", flush=True)
                    await self.phase(prompts, http_concurrency, batch_size, repetition)
            self.report["status"] = "ok"
        except BaseException as error:
            self.report.update(status="failed", error=str(error))
            raise
        finally:
            self.save()


def parse_case(value):
    try:
        http_concurrency, batch_size = map(int, value.split("x"))
        if http_concurrency <= 0 or batch_size <= 0 or http_concurrency * batch_size > 256:
            raise ValueError()
        return http_concurrency, batch_size
    except ValueError as error:
        raise argparse.ArgumentTypeError("Use HTTP-count x prompts-per-HTTP, e.g. 8x8, up to 256 sequences") from error


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--output", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--cases", type=parse_case, nargs="+", default=[(64, 1), (80, 1)])
    parser.add_argument("--warmup", type=float, default=20)
    parser.add_argument("--duration", type=float, default=60)
    asyncio.run(Continuous(parser.parse_args()).run())
