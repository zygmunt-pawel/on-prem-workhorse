#!/usr/bin/env python3
"""Compact validated network-load phases, exclusions, provenance and GPU samples."""
import argparse
import csv
import datetime
import hashlib
import json
from pathlib import Path
import statistics

parser = argparse.ArgumentParser()
parser.add_argument('directory')
parser.add_argument('output')
args = parser.parse_args()
root = Path(args.directory)
clock = json.loads((root/'clock-alignment.json').read_text())
gpu = []
for filename in ('gpu.csv', 'gpu-confirm.csv'):
    for row in csv.reader((root/filename).open()):
        stamp = datetime.datetime.strptime(row[0].strip()+clock['timezone'], '%Y/%m/%d %H:%M:%S.%f%z').timestamp()
        gpu.append((stamp-clock['estimatedServerMinusClientSeconds'], float(row[1]), float(row[3])))
candidate = json.loads((root/'selected-cap.json').read_text())['candidate']
result = {'date': '2026-09-15', 'route': 'administrator Mac → HTTPS / Cloudflare → RTX 5090',
          'inputTokens': 8192, 'jsonProfile': 'synthetic schema with variable reason; no hidden thinking',
          'candidateActiveLimit': candidate, 'campaigns': [], 'comparisonSummary': [],
          'exclusions': [], 'rawArtifacts': {},
          'gpuClockUncertaintySeconds': (clock['clientAfter']-clock['clientBefore'])/2}
names = ('fixed-screen', 'fixed-isolated-screen', 'fixed-remaining',
         'json-mixed-isolated-screen', 'json-lower-screen', 'json-confirm80', 'json-confirm-cap')
valid_sequences = valid_requests = 0
for name in names:
    report = json.loads((root/(name+'.json')).read_text())
    cap = candidate if name == 'json-confirm-cap' else 80
    campaign = {key: report[key] for key in ('runId','profile','status','bankSha256','commonPrefixTokens',
                                            'healthRoundtripSeconds','warmupSeconds','durationSeconds')}
    campaign.update(name=name, engineMaxNumSeqs=cap, phases=[])
    if report.get('error'):
        campaign['error'] = report['error']
    for phase in report['phases']:
        row = {k:v for k,v in phase.items() if k not in ('samples','responses')}
        row.update(profile=report['profile'], engineMaxNumSeqs=cap)
        row['valid'] = not phase['errors']
        if row['valid']:
            assert sum(r['usage']['completion_tokens'] for r in phase['responses']) == phase['allOutputTokens']
            assert sum(r['sequences'] for r in phase['responses']) == phase['allSequences']
            ids = sorted((r['firstIndex'], r['sequences']) for r in phase['responses'])
            end = 0
            for first, count in ids:
                assert first == end
                end += count
            valid_sequences += phase['allSequences']
            valid_requests += phase['allRequests']
        else:
            result['exclusions'].append({'campaign':name,'workers':phase['workers'],
                                         'batchSize':phase['batchSize'],'errors':phase['errors']})
        if 'measurementStartEpoch' in phase:
            readings = [(util,power) for stamp,util,power in gpu
                        if phase['measurementStartEpoch'] <= stamp <= phase['measurementEndEpoch']]
            if not readings:
                raise RuntimeError(f'No GPU samples for {name}')
            row.update(gpuSamples=len(readings), gpuMeanPct=statistics.mean(v for v,_ in readings),
                       gpuMinPct=min(v for v,_ in readings), gpuMaxPct=max(v for v,_ in readings),
                       gpuPowerMeanWatts=statistics.mean(p for _,p in readings))
        campaign['phases'].append(row)
        if row['valid'] and (name in ('json-confirm80','json-confirm-cap') or
                             report['profile'] == 'fixed'):
            result['comparisonSummary'].append(row)
    result['campaigns'].append(campaign)
for path in root.iterdir():
    if path.is_file() and path.suffix in ('.json','.py','.log','.csv') and not path.name.startswith('network-json-') and path.name != 'network-fixed.json':
        result['rawArtifacts'][path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
result.update(validatedSequences=valid_sequences, validatedHttpResponses=valid_requests)
Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps({'validatedSequences':valid_sequences,'validatedHttpResponses':valid_requests,
                  'excludedPhases':len(result['exclusions'])}))
