#!/usr/bin/env python3
"""Run the shared fixture with full JSON Schema validation and response hashes.

Executed inside the tested vLLM container (which provides jsonschema). Fixtures
and sampling parameters are unchanged across versions. All saved text is synthetic.
"""
import asyncio
import hashlib
import json
import threading
from pathlib import Path

import jsonschema
import benchmark


original_load = json.load
validator = jsonschema.Draft202012Validator(benchmark.SIEVE_SCHEMA)
lock = threading.Lock()
records = []


def checked_load(response, *args, **kwargs):
    decoded = original_load(response, *args, **kwargs)
    if isinstance(decoded, dict) and "choices" in decoded:
        for choice in decoded["choices"]:
            text = choice.get("text", "")
            record = {
                "sha256": hashlib.sha256(text.encode()).hexdigest(),
                "finishReason": choice.get("finish_reason"),
                "characters": len(text),
            }
            # Prefilter is plain BEGIN/END text; sieve is always a JSON object.
            if not text.lstrip().startswith("BEGIN "):
                parsed = json.loads(text)
                validator.validate(parsed)
                record["schemaValid"] = True
            with lock:
                records.append(record)
    return decoded


if __name__ == "__main__":
    json.load = checked_load
    args = benchmark.parse_args()
    try:
        code = asyncio.run(benchmark.main_async(args))
    finally:
        if args.output:
            Path(args.output).with_name("response-validation.json").write_text(
                json.dumps({"responses": records, "fullJsonSchemaValidation": True}, indent=2) + "\n"
            )
    raise SystemExit(code)
