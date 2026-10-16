#!/usr/bin/env python3
"""Deterministic JSONL app-server double; no auth, network, Node, or model needed."""
import json
import os
import sys
import time

with open(__file__ + '.pid', 'w') as pid_file:
    pid_file.write(str(os.getpid()))
if os.path.exists(__file__ + '.initwait'):
    time.sleep(60)

with open(__file__ + '.log', 'a') as log:
    log.write('start\n')

def send(value):
    print(json.dumps(value), flush=True)

thread_number = 0
for line in sys.stdin:
    message = json.loads(line)
    with open(__file__ + '.requests', 'a') as requests:
        requests.write(json.dumps(message) + '\n')
    method = message.get('method')
    request_id = message.get('id')
    params = message.get('params', {})
    if method == 'initialize':
        send({'id': request_id, 'result': {'userAgent': 'fixture'}})
    elif method == 'config/read':
        send({'id': request_id, 'result': {'config': {'mcp_servers': {'tauride': {'enabled': True}}}}})
    elif method == 'account/read':
        assert params == {'refreshToken': False}
        with open(__file__ + '.log', 'a') as log:
            log.write('account/read\n')
        mode_file = __file__ + '.account'
        mode = open(mode_file).read() if os.path.exists(mode_file) else 'ready'
        if mode == 'wait':
            time.sleep(60)
        elif mode == 'unsupported':
            send({'id': request_id, 'error': {'message': 'secret@example.com'}})
        elif mode == 'malformed':
            print('bad json', flush=True)
        else:
            result = {
                'ready': {'account': {'email': 'secret@example.com'}, 'requiresOpenaiAuth': True},
                'signin': {'account': None, 'requiresOpenaiAuth': True},
                'provider': {'account': None, 'requiresOpenaiAuth': False},
                'invalid': {},
            }[mode]
            send({'id': request_id, 'result': result})
    elif method == 'thread/start':
        assert params['ephemeral'] is True
        assert params['sandbox'] == 'read-only'
        assert params['config']['mcp_servers.tauride.enabled'] is False
        assert params['config']['features.apps'] is False
        assert params['config']['features.shell_tool'] is False
        thread_number += 1
        thread = 'thread-' + str(thread_number)
        with open(__file__ + '.log', 'a') as log:
            log.write(thread + '\n')
        send({'id': request_id, 'result': {'thread': {'id': thread}}})
    elif method == 'thread/unsubscribe':
        with open(__file__ + '.log', 'a') as log:
            log.write('release-' + params['threadId'] + '\n')
        send({'id': request_id, 'result': {'status': 'unsubscribed'}})
    elif method == 'turn/start':
        prompt = params['input'][0]['text']
        if 'FIXTURE_EXIT' in prompt:
            sys.exit(0)
        if 'FIXTURE_MALFORMED' in prompt:
            print('bad json', flush=True)
            continue
        if 'FIXTURE_OVERSIZED' in prompt:
            print('x' * (256 * 1024 + 1), flush=True)
            continue
        if 'FIXTURE_TOOL' in prompt:
            send({'id': 999, 'method': 'item/tool/call', 'params': {}})
            continue
        if 'FIXTURE_WRONG_ID' in prompt:
            send({'id': request_id + 99, 'result': {}})
            continue
        turn = 'turn-' + str(thread_number)
        send({'id': request_id, 'result': {'turn': {'id': turn}}})
        if 'FIXTURE_WAIT' in prompt:
            time.sleep(60)
            continue
        # A chatty stderr must not deadlock the protocol reader.
        sys.stderr.write('diagnostic\n' * 10000)
        sys.stderr.flush()
        p = {'threadId': thread, 'turnId': turn, 'itemId': 'answer'}
        send({'method': 'item/agentMessage/delta', 'params': dict(p, delta='The array ranks differ. ')})
        send({'method': 'item/agentMessage/delta', 'params': dict(p, delta='Check the operands.')})
        send({'method': 'item/completed', 'params': dict(p, item={'id': 'answer', 'type': 'agentMessage', 'text': 'The array ranks differ. Check the operands.'})})
        send({'method': 'turn/completed', 'params': {'threadId': thread, 'turn': {'id': turn, 'status': 'completed'}}})
