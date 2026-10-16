#!/usr/bin/env python3
"""Deterministic Claude Code print-mode double; no auth, network, Node, or model needed."""
import json
import os
import sys
import time

base = os.path.realpath(__file__)

def log(text):
    with open(base + '.log', 'a') as f:
        f.write(text + '\n')

def send(value):
    print(json.dumps(value), flush=True)

if sys.argv[1:4] == ['auth', 'status', '--json']:
    log('auth')
    mode_file = base + '.account'
    mode = open(mode_file).read() if os.path.exists(mode_file) else 'ready'
    with open(base + '.pid', 'w') as pid_file:
        pid_file.write(str(os.getpid()))
    if mode == 'wait':
        time.sleep(60)
    elif mode == 'malformed':
        print('bad json', flush=True)
    elif mode == 'signin':
        send({'loggedIn': False, 'authMethod': 'none'})
        sys.exit(1)
    else:
        send({'loggedIn': True, 'authMethod': 'claude.ai', 'email': 'secret@example.com'})
    sys.exit(0)

prompt = sys.stdin.read()
cwd = os.getcwd()
with open(base + '.requests', 'a') as requests:
    requests.write(json.dumps({'argv': sys.argv[1:], 'stdin': prompt, 'cwd': cwd, 'cwdEntries': os.listdir(cwd)}) + '\n')
with open(base + '.pid', 'w') as pid_file:
    pid_file.write(str(os.getpid()))
log('explain')

if 'FIXTURE_NONZERO' in prompt:
    sys.stderr.write("error: unknown option '--tools'\nsecond line\n")
    sys.exit(2)

init = {'type': 'system', 'subtype': 'init', 'tools': [], 'mcp_servers': [], 'model': 'fixture'}
if 'FIXTURE_TOOLS_ENABLED' in prompt:
    init['tools'] = ['Bash']
if 'FIXTURE_MCP_ENABLED' in prompt:
    init['mcp_servers'] = [{'name': 'tauride', 'status': 'connected'}]
if 'FIXTURE_TOOLS_UNREPORTED' in prompt:
    del init['tools']
send(init)

def event(value):
    send({'type': 'stream_event', 'event': value})

def delta(text):
    event({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': text}})

def result(text, is_error=False):
    send({'type': 'result', 'subtype': 'success', 'is_error': is_error, 'result': text})

if 'FIXTURE_WAIT' in prompt:
    time.sleep(60)
elif 'FIXTURE_IS_ERROR' in prompt:
    send({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'Credit balance is too low'}]}, 'error': 'billing_error'})
    result('Credit balance is too low', is_error=True)
elif 'FIXTURE_OVERSIZED' in prompt:
    print('x' * (256 * 1024 + 1), flush=True)
elif 'FIXTURE_MALFORMED' in prompt:
    print('bad json', flush=True)
elif 'FIXTURE_TOOL' in prompt:
    event({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'tool', 'name': 'Bash', 'input': {}}})
    result('')
elif 'FIXTURE_NO_RESULT' in prompt:
    delta('Partial ')
elif 'FIXTURE_DONE_ONLY' in prompt:
    result('Only the final text.')
else:
    # A chatty stderr must not deadlock the stream reader.
    sys.stderr.write('diagnostic\n' * 10000)
    sys.stderr.flush()
    event({'type': 'message_start', 'message': {'id': 'msg'}})
    event({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
    event({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'thinking_delta', 'thinking': 'hidden'}})
    delta('The array ranks differ. ')
    delta('Check the operands.')
    send({'type': 'assistant', 'message': {'content': [{'type': 'text', 'text': 'The array ranks differ. Check the operands.'}]}})
    event({'type': 'content_block_stop', 'index': 0})
    event({'type': 'message_stop'})
    result('The array ranks differ. Check the operands.')
