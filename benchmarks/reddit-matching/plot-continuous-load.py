#!/usr/bin/env python3
"""Plot the first measured repetition of each confirmed HTTP grouping."""
import argparse
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("results", type=Path, nargs="+")
    parser.add_argument("output", type=Path)
    parser.add_argument("--preview", type=Path)
    parser.add_argument("--cases", nargs="+")
    args = parser.parse_args()
    phases = []
    for path in args.results:
        report = json.loads(path.read_text())
        assert report["status"] == "ok"
        assert report["promptTokens"] == 8192 and report["outputTokens"] == 512
        phases.extend(p for p in report["phases"] if p["repetition"] == 1 and
                      (not args.cases or f"{p['httpConcurrency']}x{p['batchSize']}" in args.cases))
    fig, axes = plt.subplots(2, 1, figsize=(11, 6.4), sharex=True, layout="constrained")
    colors = ("#2563eb", "#d97706", "#059669", "#be185d", "#7c3aed")
    for index, phase in enumerate(phases):
        rows = phase["samples"]
        x = [row["seconds"]-rows[0]["seconds"] for row in rows]
        rate_x, rates = [], []
        left = 0
        for right in range(1, len(rows)):
            while left+1 < right and x[right]-x[left+1] >= 10:
                left += 1
            dt = x[right]-x[left]
            if dt >= 10:
                rate_x.append(x[right])
                rates.append((rows[right]["generation_tokens_total"]-rows[left]["generation_tokens_total"])/dt)
        label = f"{phase['httpConcurrency']}×{phase['batchSize']} ({phase['concurrency']} sekwencji)"
        color = colors[index % len(colors)]
        axes[0].plot(rate_x, rates, color=color, linewidth=1.7, label=label)
        axes[1].plot(x, [100*r["kv_cache_usage_perc"] for r in rows], color=color, linewidth=1.2)
    axes[0].set_ylabel("Tokeny odpowiedzi/s\n(okno ≥10 s)")
    axes[0].legend(loc="lower left", fontsize=9)
    axes[1].set_ylabel("Zajętość KV (%)")
    axes[1].set_xlabel("Czas właściwego pomiaru (s)")
    axes[1].set_ylim(0, 103)
    for axis in axes:
        axis.grid(alpha=.22)
        axis.spines[["top", "right"]].set_visible(False)
    fig.suptitle("Ciągłe dosyłanie zadań: tempo generowania i KV\n"
                 "RTX 5090 · 8192 tokeny wejścia + 512 odpowiedzi · pierwsze powtórzenie", fontsize=13)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(args.output)
    if args.output.suffix.lower() == ".svg":
        args.output.write_text("\n".join(line.rstrip() for line in args.output.read_text().splitlines()) + "\n")
    if args.preview:
        fig.savefig(args.preview, dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    main()
