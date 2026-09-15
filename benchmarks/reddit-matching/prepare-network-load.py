#!/usr/bin/env python3
"""Prepare token-counted, synthetic fixtures inside the model container."""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path

from transformers import AutoTokenizer

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--profile', choices=['fixed', 'json-mixed', 'json-short'], required=True)
parser.add_argument('--count', type=int, default=2048)
parser.add_argument('--tokenizer', default='/models/Gemma-4-26B-A4B-NVFP4')
args = parser.parse_args()
tokenizer = AutoTokenizer.from_pretrained(args.tokenizer, local_files_only=True)
encode = lambda s: tokenizer.encode(s, add_special_tokens=False)
rows = []
if args.profile == 'fixed':
    spec = importlib.util.spec_from_file_location('pressure', Path(__file__).with_name('cache-pressure.py'))
    pressure = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(pressure)
    prompts, _, common, _ = pressure.make_prompts(tokenizer, 'shared', args.count, 1, 8192, 6144, phase_count=64)
    for index, tokens in enumerate(prompts):
        text = tokenizer.decode(tokens, skip_special_tokens=False)
        assert encode(text) == tokens
        rows.append({'id': index, 'prompt': text, 'inputTokens': len(tokens)})
else:
    material = encode(('The operations team gathers evidence from email and shared drives. '
                       'Records lack verified dates and responsible owners. Reviewers need exact source links '
                       'and follow-up actions before an audit.\n') * 1500)
    head = encode('<bos><|turn>user\nReview operational records and return JSON with record_id, decision and reason. '
                  'Use decision REVIEW if missing evidence requires follow-up. Explain the evidence gaps and actions.\n')
    prefix = (head + material)[:6144]
    common_prefix = None
    for index in range(args.count):
        length = 8192
        words = ([30, 45, 60, 45] if args.profile == 'json-short' else
                 [30, 100, 220, 100])[(index // 4 + index) % 4]
        unique = encode(f'\nRecord {index}:\n')
        sentence_instruction = (' Use two or three concise sentences.'
                                if args.profile == 'json-short' else '')
        suffix = encode(f'\nFor record_id {index}, return the JSON now. Write approximately {words} words '
                        f'in the reason field.{sentence_instruction} Do not add any other fields.\n<turn|>\n'
                        '<|turn>model\n<|channel>final\n<channel|>\n')
        padding = length-len(prefix)-len(unique)-len(suffix)-64
        lead = tokenizer.decode(prefix + unique + material[:padding], skip_special_tokens=False) + '\nPadding:'
        tail = tokenizer.decode(suffix, skip_special_tokens=False)
        padding_words = 64
        for _ in range(10):
            text = lead + ' x'*padding_words + tail
            tokens = encode(text)
            if len(tokens) == length:
                break
            padding_words += length-len(tokens)
            assert padding_words >= 0
        assert len(tokens) == length
        if common_prefix is None:
            common_prefix = tokens
        else:
            matched = 0
            for left, right in zip(common_prefix, tokens):
                if left != right:
                    break
                matched += 1
            common_prefix = common_prefix[:matched]
        rows.append({'id': index, 'prompt': text, 'inputTokens': length, 'requestedReasonWords': words})
    common = len(common_prefix)
result = {'profile': args.profile, 'commonPrefixTokens': common, 'rows': rows}
result['bankSha256'] = hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest()
Path(args.output).write_text(json.dumps(result, separators=(',', ':')))
print(json.dumps({k: v for k, v in result.items() if k != 'rows'}), flush=True)
