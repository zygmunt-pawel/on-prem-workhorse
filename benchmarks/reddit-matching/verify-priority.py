#!/usr/bin/env python3
"""Verify late urgent work overtakes an observed waiting backlog on vLLM.

Run inside the production container (aiohttp and VLLM_API_KEY available).
Uses 80 long generations to fill slots, then queues 8 ordinary requests
before submitting an urgent one. All responses drain and usage is checked.
This validates scheduling behavior, not throughput or network latency.
"""

import asyncio
import json
import os
from pathlib import Path
import time

import aiohttp


async def trial(session, repetition):
    origin = time.monotonic()
    records = []
    tasks = []

    async def metrics():
        async with session.get('http://localhost:8000/metrics') as response:
            response.raise_for_status()
            body = await response.text()
        values = {}
        for name in ('num_requests_running', 'num_requests_waiting'):
            values[name] = sum(float(line.split()[-1]) for line in body.splitlines()
                               if line.startswith('vllm:' + name + '{'))
        return values

    async def wait_for(predicate):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            for task in tasks:
                if task.done() and task.exception():
                    raise task.exception()
            current = await metrics()
            if predicate(current):
                return current
            await asyncio.sleep(0.1)
        raise RuntimeError('Required scheduler state not observed')

    async def generate(kind, index, priority, tokens):
        record = {'kind': kind, 'index': index, 'priority': priority,
                  'submitted': time.monotonic() - origin, 'first_token': None}
        records.append(record)
        body = {
            'model': 'gemma-4-26B-A4B-it',
            'prompt': f'Queue probe {repetition} {kind} {index}. Continue a long list of integers: 1, 2, 3,',
            'priority': priority, 'temperature': 0,
            'max_tokens': tokens, 'min_tokens': tokens, 'ignore_eos': True,
            'stream': True, 'stream_options': {'include_usage': True},
        }
        finished = False
        usage = None
        done = False
        async with session.post('http://localhost:8000/v1/completions', json=body) as response:
            response.raise_for_status()
            async for raw in response.content:
                line = raw.decode().strip()
                if not line.startswith('data: '):
                    continue
                payload = line[6:]
                if payload == '[DONE]':
                    done = True
                    continue
                event = json.loads(payload)
                if 'error' in event:
                    raise RuntimeError('SSE error returned')
                for choice in event.get('choices', []):
                    if choice.get('text') and record['first_token'] is None:
                        record['first_token'] = time.monotonic() - origin
                    finished |= choice.get('finish_reason') == 'length'
                if event.get('usage'):
                    usage = event['usage']
        if not done or not finished or not usage or usage['completion_tokens'] != tokens:
            raise RuntimeError(f'Incomplete response for {kind}/{index}')
        record.update(completed=time.monotonic() - origin, output_tokens=usage['completion_tokens'])

    try:
        idle = await metrics()
        if any(idle.values()):
            raise RuntimeError('Engine is not idle before trial')
        tasks.extend(asyncio.create_task(generate('blocker', i, 0, 1024)) for i in range(80))
        full = await wait_for(lambda m: m['num_requests_running'] == 80)
        tasks.extend(asyncio.create_task(generate('ordinary', i, 0, 16)) for i in range(8))
        queued = await wait_for(lambda m: m['num_requests_running'] == 80 and m['num_requests_waiting'] >= 8)
        if any(r['kind'] == 'ordinary' and r['first_token'] is not None for r in records):
            raise RuntimeError('Ordinary work started before urgent submission')
        tasks.append(asyncio.create_task(generate('urgent', 0, -10, 16)))
        await asyncio.gather(*tasks)
        urgent = next(r for r in records if r['kind'] == 'urgent')
        ordinary = [r for r in records if r['kind'] == 'ordinary']
        passed = all(urgent['first_token'] < r['first_token'] for r in ordinary)
        return {'repetition': repetition, 'passed': passed, 'full': full, 'queued': queued,
                'urgent_first_token': urgent['first_token'],
                'first_ordinary_token': min(r['first_token'] for r in ordinary),
                'urgent_wait_seconds': urgent['first_token'] - urgent['submitted'],
                'responses': len(records), 'records': records}
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def main():
    result = {'status': 'running', 'trials': []}
    output = Path(os.environ.get('PRIORITY_RESULT', '/tmp/priority-result.json'))
    try:
        async with aiohttp.ClientSession(
            headers={'Authorization': 'Bearer ' + os.environ['VLLM_API_KEY']},
            connector=aiohttp.TCPConnector(limit=128),
            timeout=aiohttp.ClientTimeout(total=300),
        ) as session:
            for repetition in range(2):
                trial_result = await trial(session, repetition)
                result['trials'].append(trial_result)
                print(json.dumps({k: v for k, v in trial_result.items() if k != 'records'}), flush=True)
                if not trial_result['passed']:
                    raise RuntimeError('Urgent request did not overtake every queued ordinary request')
        result['status'] = 'passed'
    except Exception as error:
        result.update(status='failed', error=str(error))
        raise
    finally:
        output.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    asyncio.run(main())
