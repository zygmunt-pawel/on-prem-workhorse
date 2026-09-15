#!/usr/bin/env python3
"""Plot compact WAN benchmark results (Matplotlib, optional PNG preview)."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('results')
parser.add_argument('output')
parser.add_argument('--preview')
args = parser.parse_args()
report = json.loads(Path(args.results).read_text())
fig, axes = plt.subplots(2, 3, figsize=(13, 7.5), layout='constrained')
fig.suptitle('vLLM przez Cloudflare: aktywne sekwencje i pula klientów', fontsize=16, weight='bold')
for row, profile in enumerate(('fixed', 'json-mixed')):
    groups = [g for g in report['comparisonSummary'] if g['profile'] == profile]
    groups.sort(key=lambda g: (g['engineMaxNumSeqs'], g['workers']*g['batchSize']))
    labels = [f"{g['workers']}×{g['batchSize']} / limit {g['engineMaxNumSeqs']}" for g in groups]
    colors = ['#d27635' if g['workers'] == 100 and g['batchSize'] == 1 else '#267c87' for g in groups]
    throughput = ('outputTokensPerSecond', 'Tokeny odpowiedzi / s') if profile == 'fixed' else ('clientCompletedSequencesPerSecond', 'Poprawne JSON-y / s')
    for col, (field, title) in enumerate((throughput,
                                        ('httpLatencyP50', 'Mediana czasu HTTP [s]'),
                                        ('kvMeanPct', 'Średnie zajęcie KV [%]'))):
        ax = axes[row, col]
        values = [g[field] for g in groups]
        bars = ax.barh(labels, values, color=colors, height=.65)
        decimals = 2 if col == 0 and profile == 'json-mixed' else 1
        ax.bar_label(bars, labels=[f'{value:.{decimals}f}' for value in values], padding=4, fontsize=10)
        ax.set_xlim(0, max(values, default=1)*1.2)
        ax.set_title(title, loc='left', fontsize=11)
        ax.spines[['top','right','left']].set_visible(False)
        ax.grid(axis='x', alpha=.15)
        ax.set_axisbelow(True)
        ax.invert_yaxis()
        if col == 0:
            ax.set_ylabel('8192 + 512 tokenów' if profile == 'fixed' else '8192 + JSON / zmienny reason')
fig.supxlabel('Etykiety: HTTP × prompty / limit aktywnych. Pomarańczowy: 100 pojedynczych requestów.\nMac → HTTPS / Cloudflare. Stałe odpowiedzi: przegląd wariantów; JSON: dłuższe powtórki.', fontsize=9)
fig.savefig(args.output)
if str(args.output).endswith('.svg'):
    path = Path(args.output)
    path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines())+'\n')
if args.preview:
    fig.savefig(args.preview, dpi=140)
