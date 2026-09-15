#!/usr/bin/env python3
"""Bounded, continuously replenished HTTP pools over the actual public route.

Prompts are prepared separately in the model container. Metrics travel through
an SSH forward, not Cloudflare. Raw responses are validated, hashed and discarded.
No retries; generation counter accounting detects unrelated inference traffic.
"""
import argparse
import asyncio
import hashlib
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import time

import aiohttp
import jsonschema

SCHEMA = {'type': 'object', 'properties': {
    'record_id': {'type': 'integer'}, 'decision': {'type': 'string', 'enum': ['REVIEW', 'OK']},
    'reason': {'type': 'string', 'minLength': 1}},
    'required': ['record_id', 'decision', 'reason'], 'additionalProperties': False}
VALIDATOR = jsonschema.Draft202012Validator(SCHEMA)
METRICS = ('generation_tokens_total', 'num_preemptions_total', 'prefix_cache_hits_total',
           'prefix_cache_queries_total', 'kv_cache_usage_perc', 'num_requests_running',
           'num_requests_waiting', 'request_success_total',
           'spec_decode_num_drafts_total', 'spec_decode_num_draft_tokens_total',
           'spec_decode_num_accepted_tokens_total')


def percentile(values, fraction):
    values = sorted(values)
    if not values:
        return None
    offset = (len(values)-1)*fraction
    low, high = math.floor(offset), math.ceil(offset)
    return values[low] + (values[high]-values[low])*(offset-low)


async def metrics(session, base):
    async with session.get(base + '/metrics', timeout=aiohttp.ClientTimeout(total=5)) as response:
        response.raise_for_status()
        body = await response.text()
    result = {name: 0 for name in METRICS}
    seen = set()
    for line in body.splitlines():
        if not line or line.startswith('#'):
            continue
        key, value = line.rsplit(' ', 1)
        key = key.split('{')[0].removeprefix('vllm:')
        if key in result:
            result[key] += float(value)
            seen.add(key)
    if not {'generation_tokens_total', 'num_requests_running', 'kv_cache_usage_perc'} <= seen:
        raise RuntimeError('Required vLLM metrics missing')
    return result


class Benchmark:
    def __init__(self, args):
        self.args = args
        self.bank = json.loads(Path(args.prompts).read_text())
        self.key = os.environ.get('API_KEY') or subprocess.check_output([
            'ssh', '-o', 'BatchMode=yes', 'server@server',
            'docker exec ik-llama printenv VLLM_API_KEY'], text=True).strip()
        self.report = {'status': 'running', 'runId': args.run_id,
                       'baseUrl': args.base_url, 'metricsUrl': args.metrics_url,
                       'client': 'administrator Mac, HTTPS via Cloudflare',
                       'profile': self.bank['profile'], 'bankSha256': self.bank['bankSha256'],
                       'commonPrefixTokens': self.bank['commonPrefixTokens'],
                       'warmupSeconds': args.warmup, 'durationSeconds': args.duration,
                       'policy': 'priority', 'requestPriority': 0, 'stream': False,
                       'refill': 'after each complete HTTP response', 'phases': []}

    def save(self):
        Path(self.args.output).write_text(json.dumps(self.report, indent=2).replace(self.key, '[REDACTED]')+'\n')

    def session(self):
        return aiohttp.ClientSession(headers={
            'Authorization': 'Bearer '+self.key, 'User-Agent': 'on-prem-network-benchmark/1.0'},
            connector=aiohttp.TCPConnector(limit=0), timeout=aiohttp.ClientTimeout(total=300))

    async def idle(self, session):
        for _ in range(300):
            value = await metrics(session, self.args.metrics_url)
            if value['num_requests_running'] == value['num_requests_waiting'] == 0:
                return value
            await asyncio.sleep(0.2)
        raise RuntimeError('Engine did not become idle')

    async def post(self, session, rows, salt):
        profile = self.bank['profile']
        payload = {'model': 'gemma-4-26B-A4B-it', 'prompt': [r['prompt'] for r in rows],
                   'temperature': 0, 'priority': 0, 'stream': False, 'n': 1,
                   'add_special_tokens': False, 'cache_salt': salt,
                   'max_tokens': 512 if profile == 'fixed' else 1024}
        if len(rows) == 1:
            payload['prompt'] = payload['prompt'][0]
        if profile == 'fixed':
            payload.update(min_tokens=512, ignore_eos=True)
        else:
            payload['response_format'] = {'type': 'json_schema', 'json_schema': {
                'name': 'review', 'strict': True, 'schema': SCHEMA}}
        started = time.perf_counter()
        async with session.post(self.args.base_url+'/v1/completions', json=payload) as response:
            if response.status != 200:
                raise RuntimeError(f'HTTP {response.status}: {(await response.text())[:200]}')
            body = await response.json()
        received = time.perf_counter()
        choices = sorted(body['choices'], key=lambda c: c['index'])
        if [c['index'] for c in choices] != list(range(len(rows))):
            raise RuntimeError('Response indices do not match input batch')
        if body['usage']['prompt_tokens'] != sum(r['inputTokens'] for r in rows):
            raise RuntimeError('Prompt token usage mismatch')
        reasons = []
        for row, choice in zip(rows, choices):
            if profile == 'fixed':
                assert choice['finish_reason'] == 'length'
            else:
                assert choice['finish_reason'] == 'stop', 'Truncated JSON output'
                value = json.loads(choice['text'])
                VALIDATOR.validate(value)
                assert value['record_id'] == row['id'], 'Wrong record ID'
                reasons.append(len(value['reason'].split()))
        if profile == 'fixed':
            assert body['usage']['completion_tokens'] == 512*len(rows)
        return {'seconds': received-started, 'received': received, 'sequences': len(rows),
                'firstIndex': rows[0]['id'], 'usage': body['usage'], 'reasonWords': reasons,
                'outputSha256': hashlib.sha256(json.dumps(choices, separators=(',', ':')).encode()).hexdigest()}

    async def phase(self, workers, size, repetition):
        stop = asyncio.Event()
        results, samples, errors = [], [], []
        next_index = 0
        salt = f'{self.args.run_id}:{workers}x{size}:{repetition}'
        async with self.session() as session, self.session() as metric_session:
            before = await self.idle(metric_session)
            started_epoch = time.time()
            started = time.perf_counter()

            async def worker():
                nonlocal next_index
                while not stop.is_set():
                    index = next_index
                    next_index += size
                    if next_index > len(self.bank['rows']):
                        errors.append('Unique prompt bank exhausted')
                        stop.set()
                        return
                    try:
                        row = await self.post(session, self.bank['rows'][index:next_index], salt)
                        row['received'] -= started
                        results.append(row)
                    except Exception as error:
                        errors.append(f'{type(error).__name__}: {error}; detail={error!r}')
                        stop.set()

            async def sample():
                value = await metrics(metric_session, self.args.metrics_url)
                value['seconds'] = time.perf_counter()-started
                return value

            tasks = [asyncio.create_task(worker()) for _ in range(workers)]
            try:
                await asyncio.sleep(self.args.warmup)
                samples.append(await sample())
                deadline = time.perf_counter()+self.args.duration
                progress = 15
                while time.perf_counter() < deadline and not stop.is_set():
                    await asyncio.sleep(min(.25, max(0, deadline-time.perf_counter())))
                    samples.append(await sample())
                    elapsed = samples[-1]['seconds']-samples[0]['seconds']
                    if elapsed >= progress:
                        rate = (samples[-1]['generation_tokens_total']-samples[0]['generation_tokens_total'])/elapsed
                        print(f'PROGRESS {workers}x{size} rep={repetition} {elapsed:.0f}s: {rate:.1f} t/s, '
                              f"KV={samples[-1]['kv_cache_usage_perc']*100:.1f}% waiting={samples[-1]['num_requests_waiting']}", flush=True)
                        progress += 15
            finally:
                stop.set()
                await asyncio.gather(*tasks)
            after = await self.idle(metric_session)
            total_wall = time.perf_counter()-started
        if len(samples) < 2:
            errors.append('Measurement interval incomplete')
        first, last = samples[0], samples[-1]
        seconds = max(last['seconds']-first['seconds'], 1e-9)
        delta = last['generation_tokens_total']-first['generation_tokens_total']
        total = after['generation_tokens_total']-before['generation_tokens_total']
        expected = sum(r['usage']['completion_tokens'] for r in results)
        if total != expected:
            errors.append(f'Counter mismatch (possible unrelated traffic): {total} != {expected}')
        def mean(name):
            return sum(a[name]*(b['seconds']-a['seconds']) for a,b in zip(samples,samples[1:]))/seconds
        measured_responses = [r for r in results if first['seconds'] <= r['received'] <= last['seconds']]
        queries = last['prefix_cache_queries_total']-first['prefix_cache_queries_total']
        hits = last['prefix_cache_hits_total']-first['prefix_cache_hits_total']
        drafts = last['spec_decode_num_drafts_total']-first['spec_decode_num_drafts_total']
        draft_tokens = last['spec_decode_num_draft_tokens_total']-first['spec_decode_num_draft_tokens_total']
        accepted = last['spec_decode_num_accepted_tokens_total']-first['spec_decode_num_accepted_tokens_total']
        row = {'workers': workers, 'batchSize': size, 'inflightSequences': workers*size, 'repetition': repetition,
               'startedEpoch': started_epoch,
               'measurementStartEpoch': started_epoch+first['seconds'],
               'measurementEndEpoch': started_epoch+last['seconds'],
               'seconds': seconds, 'outputTokens': delta, 'outputTokensPerSecond': delta/seconds,
               'clientCompletedSequencesPerSecond': sum(r['sequences'] for r in measured_responses)/seconds,
               'clientReceivedTokensPerSecond': sum(r['usage']['completion_tokens'] for r in measured_responses)/seconds,
               'kvMeanPct': 100*mean('kv_cache_usage_perc'),
               'kvPeakPct': 100*max(s['kv_cache_usage_perc'] for s in samples),
               'runningMean': mean('num_requests_running'), 'waitingMean': mean('num_requests_waiting'),
               'runningMax': max(s['num_requests_running'] for s in samples),
               'waitingMax': max(s['num_requests_waiting'] for s in samples),
               'preemptions': last['num_preemptions_total']-first['num_preemptions_total'],
               'prefixHitPct': 100*hits/max(queries,1),
               'mtpDrafts': drafts, 'mtpDraftTokens': draft_tokens, 'mtpAcceptedTokens': accepted,
               'mtpAcceptancePct': 100*accepted/draft_tokens if draft_tokens else None,
               'mtpAcceptedPerDraft': accepted/drafts if drafts else None,
               'httpLatencyP50': percentile([r['seconds'] for r in measured_responses], .5),
               'httpLatencyP95': percentile([r['seconds'] for r in measured_responses], .95),
               'allSequences': sum(r['sequences'] for r in results), 'allRequests': len(results),
               'allOutputTokens': total, 'totalSeconds': total_wall,
               'averageOutputTokens': expected/max(sum(r['sequences'] for r in results),1),
               'reasonWordsP10': percentile([w for r in results for w in r['reasonWords']], .1),
               'reasonWordsP90': percentile([w for r in results for w in r['reasonWords']], .9),
               'errors': errors, 'samples': samples, 'responses': results}
        self.report['phases'].append(row)
        self.save()
        print('DONE '+json.dumps({k:v for k,v in row.items() if k not in ('samples','responses')}), flush=True)
        if errors:
            raise RuntimeError('Phase failed; partial results saved')

    async def run(self):
        try:
            async with self.session() as session:
                health = []
                for _ in range(10):
                    start = time.perf_counter()
                    async with session.get(self.args.base_url+'/health') as response:
                        response.raise_for_status()
                        await response.read()
                    health.append(time.perf_counter()-start)
                self.report['healthRoundtripSeconds'] = health
            for repetition in range(1, self.args.repetitions+1):
                cases = self.args.cases if repetition % 2 else list(reversed(self.args.cases))
                for workers, size in cases:
                    print(f'START {workers}x{size} rep={repetition} profile={self.bank["profile"]}', flush=True)
                    await self.phase(workers, size, repetition)
            self.report['status'] = 'ok'
        except BaseException as error:
            self.report.update(status='failed', error=f'{type(error).__name__}: {error}')
            raise
        finally:
            self.save()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--base-url', default='https://model.leads.run')
    parser.add_argument('--metrics-url', default='http://127.0.0.1:18090')
    parser.add_argument('--prompts', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--warmup', type=float, default=20)
    parser.add_argument('--duration', type=float, default=60)
    parser.add_argument('--repetitions', type=int, default=2)
    parser.add_argument('--cases', nargs='+', default=['64x1','80x1','100x1','128x1','8x8','25x4'])
    args = parser.parse_args()
    args.cases = [tuple(map(int, value.split('x'))) for value in args.cases]
    assert all(0 < workers*size <= 256 and workers > 0 and size > 0 for workers,size in args.cases)
    lock = subprocess.Popen(['ssh','-o','BatchMode=yes','server@server',
                             "flock -n /tmp/on-prem-vllm-version-benchmark.lock sh -c 'echo LOCKED; cat >/dev/null'"],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE)
    try:
        if lock.stdout.readline().strip() != b'LOCKED':
            raise SystemExit('Another benchmark holds the server lock')
        asyncio.run(Benchmark(args).run())
    finally:
        lock.stdin.close()
        lock.wait(timeout=15)
