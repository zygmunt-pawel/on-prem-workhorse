#!/usr/bin/env python3
"""Format scraper JSON output for readable console display.

Usage:
    curl ... | python3 format-output.py          # auto-detect single/multi-page
    curl ... | python3 format-output.py --json    # also print raw JSON (without markdown/html)
"""
import copy
import json
import sys


def unwrap(d: dict) -> dict:
    """Unwrap {"success": ..., "data": {...}} envelope if present."""
    if "data" in d and isinstance(d["data"], dict):
        return d["data"]
    return d

def print_single(d: dict, show_json: bool) -> None:
    md = d.get("markdown", "")
    if show_json:
        show = copy.deepcopy(d)
        show.pop("markdown", None)
        show.pop("cleanedHtml", None)
        show.pop("rawHtml", None)
        show["markdown_length"] = len(md)
        print(json.dumps(show, indent=2, ensure_ascii=False))
        print()
    print("━" * 60)
    print("MARKDOWN")
    print("━" * 60)
    print(md)

def print_site(d: dict, show_json: bool) -> None:
    pages = d.get("pages", [])
    if show_json:
        show = copy.deepcopy(d)
        for p in show.get("pages", []):
            md = p.pop("markdown", "")
            p["markdown_length"] = len(md)
        print(json.dumps(show, indent=2, ensure_ascii=False))
        print()
    for i, p in enumerate(pages):
        print("━" * 60)
        print(f'PAGE {i+1}: {p.get("label", "?")} ({p.get("url", "?")})')
        print("━" * 60)
        print(p.get("markdown", ""))
        print()

def main() -> None:
    show_json = "--json" in sys.argv
    raw = sys.stdin.read()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        print("ERROR: Invalid JSON response from scraper:")
        print(raw[:2000])
        sys.exit(1)

    d = unwrap(d)

    # Error response
    if "error" in d and "pages" not in d and "markdown" not in d:
        print(json.dumps(d, indent=2, ensure_ascii=False))
        sys.exit(1)

    # Multi-page (scrape-site) vs single-page (scrape)
    if "pages" in d:
        print_site(d, show_json)
    elif "markdown" in d:
        print_single(d, show_json)
    else:
        print(json.dumps(d, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    main()
