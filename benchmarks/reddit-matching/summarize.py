#!/usr/bin/env python3
"""Print a compact comparison from run-matrix.sh result directories."""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: summarize.py RESULT_DIRECTORY")
    root = Path(sys.argv[1])
    rows = []
    for result_path in sorted(root.glob("*/result.json")):
        report = json.loads(result_path.read_text())
        if report.get("status") != "ok":
            continue
        summary = report["summary"]
        rows.append(
            (
                report["variant"],
                summary["totalWallSecondsMedian"],
                summary["prefilter"]["wallSecondsMedian"],
                summary["sieve"]["wallSecondsMedian"],
                summary["mixed"]["wallSecondsMedian"],
                summary["sieve"]["completionTokensPerSecondMedian"],
                summary["mixed"]["completionTokensPerSecondMedian"],
                summary["sieve"]["gpuUtilizationAveragePct"],
                sum(summary[phase]["errors"] for phase in ("prefilter", "sieve", "mixed")),
                sum(
                    summary[phase]["parseFailures"]
                    for phase in ("prefilter", "sieve", "mixed")
                ),
            )
        )
    if not rows:
        print("no successful benchmark results")
        return 1

    header = (
        "variant",
        "total_s",
        "pref_s",
        "sieve_s",
        "mixed_s",
        "sieve_out_tps",
        "mixed_out_tps",
        "sieve_gpu_pct",
        "errors",
        "parse",
    )
    widths = [
        max(len(str(row[index])) for row in [header, *rows])
        for index in range(len(header))
    ]
    for row in [header, *rows]:
        print("  ".join(str(value).ljust(widths[index]) for index, value in enumerate(row)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
