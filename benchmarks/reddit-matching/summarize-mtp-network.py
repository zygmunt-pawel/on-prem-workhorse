#!/usr/bin/env python3
"""Validate and summarize the MTP 2/3/4 public-route comparison."""
import argparse
import csv
import datetime
import hashlib
import json
from pathlib import Path
import re
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('directory')
parser.add_argument('output')
parser.add_argument('--mtp-tokens', nargs='+', type=int, default=[4, 3, 2])
parser.add_argument('--min-duration', type=float, default=90)
parser.add_argument('--max-model-len', type=int, default=32768)
args = parser.parse_args()
root = Path(args.directory)
clock = json.loads((root/'clock-alignment.json').read_text())
gpu = []
for row in csv.reader((root/'gpu.csv').open()):
    stamp = datetime.datetime.strptime(row[0].strip()+clock['timezone'], '%Y/%m/%d %H:%M:%S.%f%z').timestamp()
    gpu.append((stamp-clock['estimatedServerMinusClientSeconds'], float(row[1]), float(row[3])))
result = {'date': '2026-09-15', 'maxNumSeqs': 56, 'inflightRequests': 100,
          'maxModelLen': args.max_model_len,
          'inputTokens': 8192, 'route': 'Mac → Cloudflare → RTX 5090',
          'gpuMemoryUtilization': .92, 'maxNumBatchedTokens': 8192,
          'powerLimitWatts': 450, 'variants': [], 'validatedSequences': 0,
          'clockUncertaintySeconds': (clock['clientAfter']-clock['clientBefore'])/2}
for n in args.mtp_tokens:
    report = json.loads((root/f'mtp{n}.json').read_text())
    assert report['status'] == 'ok'
    assert result.setdefault('profile', report['profile']) == report['profile']
    runtime = json.loads((root/f'runtime-{n}.json').read_text())
    assert runtime['argv'][runtime['argv'].index('--max-model-len')+1] == str(args.max_model_len)
    kv = next(re.search(r'Available KV cache memory: ([0-9.]+) GiB', line).group(1)
              for line in runtime['kvLines'] if 'Available KV cache memory:' in line)
    phases = []
    for phase in report['phases']:
        assert not phase['errors'] and phase['seconds'] >= args.min_duration
        assert phase['workers'] == 100 and phase['batchSize'] == 1
        assert phase['runningMax'] <= 56
        assert sum(r['usage']['completion_tokens'] for r in phase['responses']) == phase['allOutputTokens']
        assert sorted(r['firstIndex'] for r in phase['responses']) == list(range(phase['allSequences']))
        assert all(r['usage']['prompt_tokens'] == 8192 for r in phase['responses'])
        row = {k:v for k,v in phase.items() if k not in ('samples','responses')}
        readings = [(util,power) for stamp,util,power in gpu
                    if phase['measurementStartEpoch'] <= stamp <= phase['measurementEndEpoch']]
        assert len(readings) >= args.min_duration - 5
        row.update(gpuSamples=len(readings), gpuMeanPct=statistics.mean(v for v,_ in readings),
                   gpuPowerMeanWatts=statistics.mean(p for _,p in readings))
        phases.append(row)
        result['validatedSequences'] += phase['allSequences']
    keys = ('outputTokensPerSecond','clientCompletedSequencesPerSecond','kvMeanPct',
            'httpLatencyP50','gpuMeanPct','gpuPowerMeanWatts','averageOutputTokens',
            'mtpAcceptancePct','mtpAcceptedPerDraft','prefixHitPct')
    result['variants'].append({'mtpTokens':n,'kvPoolGiB':float(kv),'bankSha256':report['bankSha256'],
                               'phases':phases, 'mean':{k:statistics.mean(p[k] for p in phases) for k in keys}})
assert len({r['bankSha256'] for r in result['variants']}) == 1
result['restoration'] = json.loads((root/'restored.json').read_text())
assert result['restoration']['verified']
result['rawArtifacts'] = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir()
                          if p.is_file() and p.suffix in ('.json','.log','.py','.csv','.sh')}
Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'validatedSequences':result['validatedSequences'],
                  'variants':[{'mtpTokens':v['mtpTokens'],'kvPoolGiB':v['kvPoolGiB'],**v['mean']} for v in result['variants']]},indent=2))
