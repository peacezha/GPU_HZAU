#!/usr/bin/env python3
"""Loopback control for a single official VS Code tunnel on this instance."""

import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import HTTPRedirectHandler, Request, build_opener


WORKSPACE = Path('/home/work')
CLI_ROOT = WORKSPACE / '.compute-connect' / 'microsoft'
ARCHIVE_CACHE = Path('/mnt/data/vscode-connect-20261104/vscode-cli-1.115.0-linux-x64.tar.gz')
ARCHIVE_URL = 'https://update.code.visualstudio.com/1.115.0/cli-linux-x64/stable'
ARCHIVE_REDIRECT = ('https://vscode.download.prss.microsoft.com/dbazure/download/stable/'
                    '41dd792b5e652393e7787322889ed5fdc58bd75b/vscode_cli_linux_x64_cli.tar.gz')
ARCHIVE_SHA = '3a36228691e540b9a1e5798c5e5738ccabff7bc4a83bd030a8f7b0cce6045426'
CLI_SHA = '404a6b3050b0d2c896544f8a7032a44bc3f6a5a6fe1aa8b4ac7bb8b5430763e8'
GITHUB_URL = 'https://github.com/login/device'
PORT = 38751
MAX_BODY = 2048
MAX_ARCHIVE = 32 * 1024 * 1024
MAX_BINARY = 64 * 1024 * 1024
DEVICE_TIMEOUT = 600
TUNNEL_TIMEOUT = 120
TOKEN = re.compile(r'[0-9a-f]{64}', re.ASCII)
INSTANCE = re.compile(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', re.ASCII)
TUNNEL_NAME = re.compile(r'[a-z0-9](?:[a-z0-9-]{1,47}[a-z0-9])', re.ASCII)
ANSI = re.compile(rb'\x1b\[[0-?]*[ -/]*[@-~]')
DEVICE_LINE = re.compile(
    rb'To grant access to the server, please log into[ \t\r\n]+'
    rb'https://github\.com/login/device[ \t\r\n]+and[ \t]+use[ \t]+code[ \t]+'
    rb'([A-Z0-9]{4}-[A-Z0-9]{4})(?=[ \t\r\n])'
)


class AgentFailure(Exception):
    """An error with a fixed, public-facing message."""


class Cancelled(Exception):
    pass


def check_cancelled(cancel):
    if cancel.is_set():
        raise Cancelled()


def private_directory(path):
    path.mkdir(mode=0o700, exist_ok=True)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
        raise AgentFailure('连接程序目录的权限不安全。')


def check_binary(path):
    with path.open('rb') as stream:
        header = stream.read(20)
        if (len(header) != 20 or header[:6] != b'\x7fELF\x02\x01'
                or struct.unpack('<H', header[18:20])[0] != 62):
            raise AgentFailure('连接程序不是 Linux x64 官方二进制。')
        digest = hashlib.sha256(header)
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    if not hmac.compare_digest(digest.hexdigest(), CLI_SHA):
        raise AgentFailure('连接程序校验失败。')


def write_archive(source, destination, cancel, deadline):
    digest = hashlib.sha256()
    total = 0
    with destination.open('wb') as output:
        while True:
            check_cancelled(cancel)
            if time.monotonic() > deadline:
                raise AgentFailure('获取官方连接程序超时。')
            block = source.read(1024 * 1024)
            if not block:
                break
            total += len(block)
            if total > MAX_ARCHIVE:
                raise AgentFailure('官方安装包超过大小限制。')
            digest.update(block)
            output.write(block)
    if not hmac.compare_digest(digest.hexdigest(), ARCHIVE_SHA):
        raise AgentFailure('官方安装包校验失败。')


class FixedRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if request.full_url != ARCHIVE_URL or new_url != ARCHIVE_REDIRECT:
            raise AgentFailure('官方安装包下载地址发生变化。')
        return super().redirect_request(request, fp, code, message, headers, new_url)


def install_cli(cancel):
    check_cancelled(cancel)
    private_directory(CLI_ROOT.parent)
    private_directory(CLI_ROOT)
    private_directory(CLI_ROOT / 'cli-data')
    destination = CLI_ROOT / 'code-1.115.0'
    if destination.exists() or destination.is_symlink():
        info = destination.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                or info.st_mode & 0o022 or not info.st_mode & 0o100 or info.st_size > MAX_BINARY):
            raise AgentFailure('已安装的连接程序权限或格式无效。')
        check_binary(destination)
        return destination

    with tempfile.TemporaryDirectory(prefix='.tunnel-install-', dir=CLI_ROOT) as stage:
        archive = Path(stage) / 'cli.tar.gz'
        deadline = time.monotonic() + 120
        try:
            # The project mount contains public installer bytes only. Copy and hash
            # the same stream before extraction so changes to the mount cannot race it.
            descriptor = os.open(ARCHIVE_CACHE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(descriptor, 'rb') as source:
                cached = os.fstat(source.fileno())
                if not stat.S_ISREG(cached.st_mode) or cached.st_size > MAX_ARCHIVE:
                    raise AgentFailure('缓存中的官方安装包不可用。')
                write_archive(source, archive, cancel, deadline)
        except (OSError, AgentFailure):
            check_cancelled(cancel)
            try:
                request = Request(ARCHIVE_URL, headers={'Accept': 'application/octet-stream'})
                with build_opener(FixedRedirect()).open(request, timeout=12) as source:
                    if source.geturl() not in (ARCHIVE_URL, ARCHIVE_REDIRECT):
                        raise AgentFailure('官方安装包下载地址发生变化。')
                    write_archive(source, archive, cancel, deadline)
            except OSError as error:
                raise AgentFailure('无法下载官方连接程序，请检查算力实例的出站网络。') from error

        check_cancelled(cancel)
        temporary = Path(stage) / 'code'
        try:
            with tarfile.open(archive, 'r:gz') as bundle:
                member = bundle.next()
                if (member is None or member.name != 'code' or not member.isfile()
                        or not 20 <= member.size <= MAX_BINARY or bundle.next() is not None):
                    raise AgentFailure('官方安装包结构异常。')
                with bundle.extractfile(member) as source, temporary.open('xb') as output:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        check_cancelled(cancel)
                        output.write(block)
        except (OSError, tarfile.TarError) as error:
            raise AgentFailure('无法解包官方连接程序。') from error
        check_binary(temporary)
        temporary.chmod(0o700)
        check_cancelled(cancel)
        try:
            os.link(temporary, destination, follow_symlinks=False)
        except FileExistsError as error:
            raise AgentFailure('连接程序安装位置已被另一个进程使用。') from error
    return destination


class TunnelAgent:
    def __init__(self, token, instance_id, installer=install_cli):
        self.token = token
        self.instance_id = instance_id
        self.installer = installer
        self.lock = threading.RLock()
        self.worker = None
        self.process = None
        self.cancel = threading.Event()
        self.name = None
        self.state = 'idle'
        self.message = '等待建立隧道。'
        self.device_code = None
        self.code_expires_at = None

    def snapshot(self):
        with self.lock:
            return {
                'instanceId': self.instance_id,
                'state': self.state,
                'deviceCode': self.device_code,
                'deviceUrl': GITHUB_URL if self.device_code else None,
                'codeExpiresAt': self.code_expires_at,
                'tunnelName': self.name,
                'message': self.message,
            }

    def publish(self, state, message, device_code=None, code_expires_at=None):
        with self.lock:
            if self.cancel.is_set() and state != 'stopped':
                return
            self.state = state
            self.message = message
            self.device_code = device_code
            self.code_expires_at = code_expires_at

    def start(self, name):
        with self.lock:
            if self.worker is not None and self.worker.is_alive():
                if self.name == name and not self.cancel.is_set():
                    return 200, self.snapshot()
                return 409, self.snapshot()
            self.cancel = threading.Event()
            self.name = name
            self.publish('starting', '正在准备官方连接程序。')
            self.worker = threading.Thread(target=self.run, args=(name,), daemon=True)
            self.worker.start()
            return 200, self.snapshot()

    def stop(self):
        with self.lock:
            self.cancel.set()
            worker = self.worker
            self.publish('stopped', '已停止本次连接任务。')
        # The owner thread terminates its own process group. Concurrent stop
        # requests must not send another signal to a reaped process ID.
        if worker is not None and worker.is_alive():
            worker.join(timeout=3)
        return self.snapshot()

    @staticmethod
    def terminate(process):
        # Every child is its own process group. Never target another user's tunnel.
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=1.5)
        except subprocess.TimeoutExpired:
            pass
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass

    def child(self, cli, args, timeout, consume, *, stay_open=False):
        environment = os.environ.copy()
        for variable in ('VSCODE_CLI_ACCESS_TOKEN', 'VSCODE_CLI_REFRESH_TOKEN',
                         'VSCODE_CLI_DISABLE_KEYCHAIN_ENCRYPT'):
            environment.pop(variable, None)
        command = [str(cli), '--cli-data-dir', str(CLI_ROOT / 'cli-data'), *args]
        with self.lock:
            check_cancelled(self.cancel)
            process = subprocess.Popen(command, cwd=WORKSPACE, env=environment,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            self.process = process
        deadline = time.monotonic() + timeout
        tail = b''
        output_open = True
        matched = False
        extended_for_login = False
        try:
            with selectors.DefaultSelector() as stream:
                stream.register(process.stdout, selectors.EVENT_READ)
                while True:
                    check_cancelled(self.cancel)
                    if (not stay_open or not matched) and time.monotonic() >= deadline:
                        return None
                    if output_open:
                        for key, _ in stream.select(0.2):
                            chunk = os.read(key.fd, 4096)
                            if chunk:
                                tail = (tail + chunk)[-8192:]
                                matched = consume(ANSI.sub(b'', tail), process) or matched
                                if stay_open and not extended_for_login and self.state == 'waiting_github':
                                    deadline = time.monotonic() + DEVICE_TIMEOUT
                                    extended_for_login = True
                            else:
                                stream.unregister(key.fileobj)
                                output_open = False
                    elif process.poll() is None:
                        self.cancel.wait(0.2)
                    if not output_open and process.poll() is not None:
                        return process.returncode
        finally:
            if process.poll() is None or self.cancel.is_set():
                self.terminate(process)
            process.stdout.close()
            with self.lock:
                if self.process is process:
                    self.process = None

    def run(self, name):
        try:
            cli = self.installer(self.cancel)
            self.ensure_no_external_tunnel(cli)
            login_state = []

            def account(tail, _process):
                if b'logged in with provider GitHub Account' in tail:
                    login_state[:] = ['github']
                elif b'logged in with provider Microsoft Account' in tail:
                    login_state[:] = ['microsoft']

            status = self.child(cli, ['tunnel', 'user', 'show'], 15, account)
            if status is None:
                raise AgentFailure('检查 GitHub 登录状态超时。')
            if status == 0 and login_state == ['microsoft']:
                raise AgentFailure('当前连接程序已登录 Microsoft 账号，请在终端核对账号后再连接。')
            if status != 0 or login_state != ['github']:
                self.authorize(cli)
            self.connect(cli, name)
        except Cancelled:
            self.publish('stopped', '已停止本次连接任务。')
        except AgentFailure as error:
            self.publish('failed', str(error))
        except (OSError, ValueError, subprocess.SubprocessError):
            self.publish('failed', '连接程序无法运行，请查看算力实例和终端状态。')
        except Exception:
            self.publish('failed', '连接程序遇到错误，请在当前实例重试。')

    def ensure_no_external_tunnel(self, cli):
        status_result = None

        def read_status(tail, _process):
            nonlocal status_result
            for line in tail.splitlines():
                if not line.startswith(b'{') or not line.endswith(b'}'):
                    continue
                try:
                    data = json.loads(line)
                except ValueError:
                    continue
                if isinstance(data, dict) and 'tunnel' in data:
                    status_result = data['tunnel'] is not None

        status = self.child(cli, ['tunnel', 'status'], 15, read_status)
        if status != 0 or status_result is None:
            raise AgentFailure('无法确认当前实例的官方隧道状态。')
        if status_result:
            raise AgentFailure('当前实例已有其他方式启动的隧道。请在启动它的终端停止后重试。')

    def authorize(self, cli):
        self.publish('starting', '正在向 GitHub 申请设备码。')
        login_started = time.time()
        last_code = None
        request_failed = False

        def device(tail, _process):
            nonlocal last_code, request_failed
            matches = list(DEVICE_LINE.finditer(tail))
            if matches:
                code = matches[-1].group(1).decode('ascii')
                if code != last_code:
                    last_code = code
                    self.publish('waiting_github', '请在 GitHub 官方页面完成设备授权。',
                                 code, int((login_started + DEVICE_TIMEOUT) * 1000))
            request_failed = request_failed or b'error requesting https://github.com/login/device/code' in tail.lower()

        status = self.child(cli, ['tunnel', 'user', 'login', '--provider', 'github'], DEVICE_TIMEOUT, device)
        if status == 0:
            return
        if status is None and last_code:
            raise AgentFailure('GitHub 设备授权已超时，请重新建立隧道。')
        if request_failed or status is None:
            raise AgentFailure('算力实例无法及时从 GitHub 获取设备码，请检查出站网络。')
        raise AgentFailure('GitHub 设备授权未完成，请重新建立隧道。')

    def connect(self, cli, name):
        self.publish('starting_tunnel', '正在连接 Microsoft 隧道服务。')
        ready = False
        last_code = None
        expected = re.compile(
            rb'Open this link in your browser[ \t]+https://vscode\.dev/tunnel/'
            + re.escape(name.encode('ascii'))
            + rb'(?:/home/work/?)?(?=[ \t\r\n])'
        )

        def connected(tail, process):
            nonlocal ready, last_code
            if b'Command-line options will not be applied until the existing tunnel exits.' in tail:
                raise AgentFailure('当前实例已有其他方式启动的隧道。请在启动它的终端停止后重试。')
            if not ready and expected.search(tail) and process.poll() is None:
                self.publish('ready', '官方隧道已启动。可用同一 GitHub 账号连接桌面 VS Code。')
                ready = True
            if not ready:
                matches = list(DEVICE_LINE.finditer(tail))
                if matches:
                    code = matches[-1].group(1).decode('ascii')
                    if last_code is None:
                        self.publish('waiting_github', '先前的 GitHub 登录已过期，请在官方页面重新授权。',
                                     code, int((time.time() + DEVICE_TIMEOUT) * 1000))
                        last_code = code
            return ready

        result = self.child(cli, ['tunnel', '--name', name, '--accept-server-license-terms'],
                            TUNNEL_TIMEOUT, connected, stay_open=True)
        if ready:
            raise AgentFailure('官方隧道进程已退出，请重新建立连接。')
        if result is None and last_code:
            raise AgentFailure('GitHub 设备授权已超时，请重新建立隧道。')
        if result is None:
            raise AgentFailure('建立 Microsoft 隧道超时，请检查实例到隧道服务的网络。')
        raise AgentFailure('Microsoft 隧道启动失败，请检查实例网络与同名隧道状态。')


class BoundedServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, agent):
        self.agent = agent
        self.slots = threading.BoundedSemaphore(8)
        super().__init__(address, Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, _request, _address):
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = 'ComputeTunnel'
    sys_version = ''

    def log_message(self, *_args):
        pass

    def send_error(self, code, *_args, **_kwargs):
        self.send_json(code, {'message': '无法处理此连接请求。'})

    def send_json(self, code, data):
        self.close_connection = True
        body = json.dumps(data, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
        try:
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(body)
        except OSError:
            pass

    def authorize(self):
        authorization = self.headers.get_all('Authorization') or []
        expected = 'Bearer ' + self.server.agent.token
        if self.headers.get('Origin') is not None or len(authorization) != 1:
            self.send_error(403)
            return False
        candidate = authorization[0].encode('utf-8')
        if len(candidate) != len(expected) or not hmac.compare_digest(candidate, expected.encode('ascii')):
            self.send_error(403)
            return False
        return True

    def read_body(self):
        lengths = self.headers.get_all('Content-Length') or []
        if (self.headers.get('Transfer-Encoding') is not None or len(lengths) > 1
                or (lengths and not re.fullmatch(r'[0-9]{1,4}', lengths[0]))):
            raise ValueError()
        length = int(lengths[0]) if lengths else 0
        if length > MAX_BODY:
            raise ValueError()
        if length == 0:
            return {}
        if self.headers.get_content_type() != 'application/json':
            raise ValueError()
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ValueError()
        return json.loads(raw)

    def do_GET(self):
        if not self.authorize():
            return
        if self.path != '/status':
            self.send_error(404)
            return
        self.send_json(200, self.server.agent.snapshot())

    def do_POST(self):
        if not self.authorize():
            return
        if self.path not in ('/start', '/stop'):
            self.send_error(404)
            return
        try:
            data = self.read_body()
        except (ValueError, OSError, RecursionError):
            self.send_error(400)
            return
        if self.path == '/stop':
            if data != {}:
                self.send_error(400)
                return
            self.send_json(200, self.server.agent.stop())
            return
        name = data.get('name') if isinstance(data, dict) else None
        if (not isinstance(name, str) or not TUNNEL_NAME.fullmatch(name)
                or set(data) != {'name', 'acceptServerLicense'} or data['acceptServerLicense'] is not True):
            self.send_json(400, {'message': '需要有效的隧道名称和明确的 Microsoft 服务器许可同意。'})
            return
        status, snapshot = self.server.agent.start(name)
        self.send_json(status, snapshot)


def load_config(filename):
    if filename:
        descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(descriptor, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise ValueError()
            raw = stream.read(MAX_BODY + 1)
    else:
        raw = sys.stdin.buffer.readline(MAX_BODY + 1)
    if len(raw) > MAX_BODY:
        raise ValueError()
    config = json.loads(raw)
    if not isinstance(config, dict) or set(config) != {'token', 'instanceId'}:
        raise ValueError()
    token, instance_id = config['token'], config['instanceId']
    if (not isinstance(token, str) or not TOKEN.fullmatch(token)
            or not isinstance(instance_id, str) or not INSTANCE.fullmatch(instance_id)):
        raise ValueError()
    return token, instance_id


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='Read startup JSON from a private file instead of stdin.')
    options = parser.parse_args()
    os.umask(0o077)
    try:
        token, instance_id = load_config(options.config)
        agent = TunnelAgent(token, instance_id)
        server = BoundedServer(('127.0.0.1', PORT), agent)
    except (ValueError, OSError, RecursionError):
        print('TUNNEL_AGENT_START_FAILED', file=sys.stderr, flush=True)
        return 1

    def terminate_server(_signal, _frame):
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, terminate_server)
    try:
        print('TUNNEL_AGENT_READY', flush=True)
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        agent.stop()
    return 0


if __name__ == '__main__':
    sys.exit(main())
