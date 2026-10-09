"""Exercise studio SSE handoffs against the real engine and a local model fixture."""
import argparse
import json
import socket
import subprocess
import tempfile
import threading
import time
from collections import Counter
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
CALLS = []
COUNTS = Counter()


class ModelFixture(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        model = body['model']
        user = next(m['content'] for m in reversed(body['messages']) if m['role'] == 'user')
        CALLS.append((model, user))
        COUNTS[model] += 1
        if 'cycle-fixture' in user:
            reply = '@质检请检查' if model == 'coder' else '@程序员请返修'
        elif 'chain-fixture' in user:
            reply = {
                ('host', 1): '任务已分配，＠程序员请实现。',
                ('coder', 1): '初稿已完成，@质检请检查。',
                ('reviewer', 1): '发现问题，@程序员请返修。',
                ('coder', 2): '返修已完成，**@质检**请复检。',
                ('reviewer', 2): '复检通过，@主持请验收。',
            }.get((model, COUNTS[model]), '验收通过，history-fixture。')
        else:
            reply = '检查完成。'
        if body.get('stream'):
            payload = 'data: ' + json.dumps({'choices': [{'index': 0, 'delta': {'content': reply}, 'finish_reason': None}]}, ensure_ascii=False) + '\n\n'
            payload += 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
            content_type = 'text/event-stream'
        else:
            payload = json.dumps({'choices': [{'message': {'role': 'assistant', 'content': reply}}]}, ensure_ascii=False)
            content_type = 'application/json'
        payload = payload.encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def request(base, path, data=None):
    req = Request(base + path, data=None if data is None else json.dumps(data).encode(),
                  headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=180) as response:
        if path.endswith('/messages') and data is not None:
            events = [json.loads(line[5:]) for line in response.read().decode().splitlines() if line.startswith('data:')]
            errors = [event for event in events if event['event_type'] == 'studio_error']
            assert not errors, errors
            assert events[-1]['event_type'] == 'studio_end', events[-1]
            return events
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--engine', type=Path, default=ROOT / 'apps/coomi-rs/target/debug/coomi.exe')
    args = parser.parse_args()
    model_server = ThreadingHTTPServer(('127.0.0.1', 0), ModelFixture)
    threading.Thread(target=model_server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix='studio-handoff-') as directory:
            home = Path(directory)
            workspace = home / 'workspace'
            workspace.mkdir()
            (home / 'config').mkdir()
            provider = {'type': 'openai', 'base_url': f'http://127.0.0.1:{model_server.server_port}/v1',
                        'api_key': 'local-fixture', 'model': 'host',
                        'models': ['host', 'coder', 'reviewer'] + [f'm{i}' for i in range(12)]}
            (home / 'config/providers.json').write_text(json.dumps({'active': 'fixture', 'providers': {'fixture': provider}}))
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                port = sock.getsockname()[1]
            base = f'http://127.0.0.1:{port}'
            with (home / 'engine.log').open('w') as log:
                process = subprocess.Popen([str(args.engine.resolve()), '--home', str(home), '--cwd', str(workspace),
                                            'serve', '--port', str(port), '--static-dir', str(ROOT / 'apps/web/dist')],
                                           stdout=log, stderr=log, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                try:
                    for _ in range(100):
                        try:
                            request(base, '/api/studios')
                            break
                        except OSError:
                            if process.poll() is not None:
                                raise RuntimeError((home / 'engine.log').read_text())
                            time.sleep(.1)
                    members = [{'id': mid, 'name': name, 'providerId': 'fixture', 'model': mid, 'toolPermission': 'full'}
                               for mid, name in [('host', '主持'), ('coder', '程序员'), ('reviewer', '质检')]]
                    studio = {'id': 'chain', 'name': 'Fixture', 'hostId': 'host', 'members': members,
                              'sharedDir': str(workspace), 'createdAt': 1, 'updatedAt': 1}
                    request(base, '/api/studios', studio)
                    events = request(base, '/api/studios/chain/messages', {'content': 'chain-fixture'})
                    replies = [e['message']['senderId'] for e in events if e['event_type'] == 'studio_message']
                    assert replies == ['host', 'coder', 'reviewer', 'coder', 'reviewer', 'host'], replies
                    assert not any(e['event_type'] == 'studio_notice' for e in events)
                    CALLS.clear()
                    request(base, '/api/studios/chain/messages', {'content': '@质检请继续上一轮'})
                    assert CALLS[0][0] == 'reviewer'
                    assert 'history-fixture' in CALLS[0][1]
                    COUNTS.clear()
                    events = request(base, '/api/studios/chain/messages', {'content': '@程序员 cycle-fixture'})
                    assert len([e for e in events if e['event_type'] == 'studio_message']) == 6
                    assert any(e['event_type'] == 'studio_notice' for e in events)
                    studio.update(id='broadcast', hostId='m0', members=[
                        {'id': f'm{i}', 'name': f'成员 {i}', 'providerId': 'fixture', 'model': f'm{i}'} for i in range(12)])
                    request(base, '/api/studios', studio)
                    events = request(base, '/api/studios/broadcast/messages', {'content': '@全体请检查'})
                    replies = [e['message']['senderId'] for e in events if e['event_type'] == 'studio_message']
                    assert set(replies) == {f'm{i}' for i in range(12)}, replies
                    assert len(replies) == 12
                    print('PASS: six-step implementation/review/rework; saved conversation context; visible cycle limit; all 12 broadcast members')
                finally:
                    process.terminate()
                    process.wait(timeout=15)
    finally:
        model_server.shutdown()
        model_server.server_close()


if __name__ == '__main__':
    main()
