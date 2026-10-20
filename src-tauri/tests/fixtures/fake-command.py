#!/usr/bin/env python3
"""Deterministic user-defined explanation command; the first argument selects its behaviour."""
import json
import os
import subprocess
import sys
import time

if sys.argv[1:] == ['--fixture-ready']:
    sys.exit(0)

base = os.path.abspath(__file__)
mode = sys.argv[1] if len(sys.argv) > 1 else 'stream'
prompt = sys.stdin.read()
cwd = os.getcwd()
with open(base + '.requests', 'a') as requests:
    requests.write(json.dumps({'argv': sys.argv[1:], 'stdin': prompt, 'cwd': cwd, 'cwdEntries': os.listdir(cwd)}) + '\n')
with open(base + '.pid', 'w') as pid_file:
    pid_file.write(str(os.getpid()))

out = sys.stdout.buffer

def write(data):
    out.write(data)
    out.flush()

if mode == 'stream':
    write('The array ranks differ. '.encode())
    time.sleep(0.05)
    write('Check the operands.'.encode())
elif mode == 'utf8':
    shape = '⍴'.encode()
    write(b'Use ' + shape[:1])
    time.sleep(0.1)
    write(shape[1:] + b' to check.')
elif mode == 'fail':
    sys.stderr.write('model not found\n' + 'x' * 10000 + '\n')
    sys.exit(3)
elif mode == 'silent':
    pass
elif mode == 'linger':
    write(b'Partial explanation.')
    os.close(1)
    time.sleep(60)
elif mode == 'wait':
    write(b'Thinking ')
    time.sleep(60)
elif mode == 'grandchild':
    child = subprocess.Popen(['/bin/sh', '-c', "trap '' TERM; while :; do sleep 1; done"])
    with open(base + '.grandchild', 'w') as f:
        f.write(str(child.pid))
    write(b'Thinking ')
    time.sleep(60)
