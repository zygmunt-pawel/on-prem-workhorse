#!/usr/bin/env python3
"""Validate the sequential JSON tuning campaign and preserve every attempted run."""
import argparse
import csv
import datetime
import hashlib
import json
from pathlib import Path
import re
import statistics

parser=argparse.ArgumentParser()
parser.add_argument('directory')
parser.add_argument('output')
args=parser.parse_args()
root=Path(args.directory)
state=json.loads((root/'state.json').read_text())
clock=json.loads((root/'clock-alignment.json').read_text())
gpu=[]
for row in csv.reader((root/'gpu.csv').open()):
    stamp=datetime.datetime.strptime(row[0].strip()+clock['timezone'],'%Y/%m/%d %H:%M:%S.%f%z').timestamp()-clock['estimatedServerMinusClientSeconds']
    gpu.append((stamp,float(row[1]),float(row[3])))
result={'date':'2026-09-15','status':state['status'],'finalization':state.get('finalization'),'selectionRule':state['selectionRule'],
        'stages':state['stages'],'selectedConfig':state.get('selectedConfig'),
        'inflightRequests':100,'maxModelLen':32768,'inputTokens':8192,
        'gpuMemoryUtilization':.92,'powerLimitWatts':450,'runs':[],
        'validatedSequences':0,'exclusions':[]}
for record in state['runs']:
    n,budget,cap=map(int,record['config'].split('-'))
    row={'label':record['label'],'status':record['status'],'config':record['config'],
         'mtpTokens':n,'budget':budget,'maxNumSeqs':cap,'phases':[]}
    if record.get('error'):row['error']=record['error']
    runtime=record.get('runtime')
    if runtime:
        row['runtime']=runtime
        row['kvPoolGiB']=float(next(re.search(r'Available KV cache memory: ([0-9.]+) GiB',line).group(1) for line in runtime['kvLines'] if 'Available KV cache memory' in line))
    observed=root/('observed-'+record['label']+'.json')
    if observed.exists():
        row['observedRuntime']=json.loads(observed.read_text())
        assert row['observedRuntime']['matches']
    report_path=root/(record['label']+'.json')
    if report_path.exists():
        report=json.loads(report_path.read_text())
        row.update(reportStatus=report['status'],bankSha256=report['bankSha256'],
                   warmupSeconds=report['warmupSeconds'],durationSeconds=report['durationSeconds'])
        assert result.setdefault('bankSha256',report['bankSha256'])==report['bankSha256']
        for p in report['phases']:
            phase={k:v for k,v in p.items() if k not in ('samples','responses')}
            if not p['errors']:
                assert p['seconds']>=60 and p['runningMax']<=cap
                assert sorted(r['firstIndex'] for r in p['responses'])==list(range(p['allSequences']))
                assert sum(r['usage']['completion_tokens'] for r in p['responses'])==p['allOutputTokens']
                assert all(r['usage']['prompt_tokens']==8192 for r in p['responses'])
                assert (p['mtpDraftTokens']>0) if n else (p['mtpDraftTokens']==0)
                readings=[(u,w) for t,u,w in gpu if p['measurementStartEpoch']<=t<=p['measurementEndEpoch']]
                assert len(readings)>=55
                phase.update(gpuSamples=len(readings),gpuMeanPct=statistics.mean(u for u,w in readings),gpuPowerMeanWatts=statistics.mean(w for u,w in readings))
                result['validatedSequences']+=p['allSequences']
            row['phases'].append(phase)
    if record['status']=='ok':
        assert observed.exists() and len(row['phases'])==2
        assert not any(p['errors'] for p in row['phases'])
        keys=('clientCompletedSequencesPerSecond','outputTokensPerSecond','kvMeanPct','gpuMeanPct','httpLatencyP50','httpLatencyP95','averageOutputTokens','prefixHitPct','gpuPowerMeanWatts')
        row['mean']={k:statistics.mean(p[k] for p in row['phases']) for k in keys}
        row['preemptions']=sum(p['preemptions'] for p in row['phases'])
    else:result['exclusions'].append({'label':row['label'],'error':record.get('error')})
    result['runs'].append(row)
kept=root/'kept-best.json'
if kept.exists():
    result['finalState']=json.loads(kept.read_text())
    assert result['finalState']['config']==state['selectedConfig']
    assert all(result['finalState'][key] for key in ('keptBest','originalApiKey','envUnchanged','verified'))
else:
    result['restoration']=json.loads((root/'restored.json').read_text())
    assert all(result['restoration'].values())
result['confirmationBest']=state.get('confirmationBest')
result['confirmationBaseline']=state.get('confirmationBaseline')
result['rawArtifacts']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in root.iterdir() if p.is_file() and p.suffix in ('.json','.log','.py','.csv','.sh')}
Path(args.output).write_text(json.dumps(result,indent=2)+'\n')
for r in result['runs']:
    print(r['label'],r['config'],r['status'],r.get('mean',{}).get('clientCompletedSequencesPerSecond'),r.get('preemptions'))
print('Validated',result['validatedSequences'])
