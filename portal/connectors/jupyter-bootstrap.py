#!/usr/bin/env python3
"""Start a private Jupyter kernel server for the current workbench instance."""

import fcntl
import hashlib
import hmac
from io import BytesIO
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener
from zipfile import BadZipFile, ZipFile


TOKEN = '__COMPUTE_JUPYTER_TOKEN__'
INSTALL_DEPENDENCIES = '__COMPUTE_JUPYTER_INSTALL__' == 'True'
PORT = '__COMPUTE_JUPYTER_PORT__'
WORK = Path('/home/work')
DATA = Path('/mnt/data')
PAIR_HEADER = 'X-Compute-Jupyter-Pair'
KERNEL = 'python3'
UPSTREAM_ORIGIN = 'https://xrapi.wuhan.net.cn:9443'
REQUIREMENTS = 'import ipykernel, jupyter_server; raise SystemExit(jupyter_server.version_info[0] != 2)'
OFFLINE_ARCHIVE = DATA / 'A800-Jupyter-Python312-offline.zip'
OFFLINE_HASHES = {
    '53745ff7318d70f5930b86a4e6934457350e81030e1ac9a5b5743bfad31e590c',
    '1fdb947cfc45e4a401e2c54499d5f73551132701dabb799b9c3c4ff57cb7c1d5',
}
MAX_OFFLINE_ARCHIVE = 64 * 1024 * 1024
MAX_OFFLINE_CONTENTS = 150 * 1024 * 1024

# The child reads the token through a pipe so it never appears in its command line.
SERVER = r'''
import json
from pathlib import Path
import re
import sys
from jupyter_client.kernelspec import KernelSpecManager
from jupyter_server.serverapp import ServerApp
from traitlets import default
from traitlets.config import Config

token = sys.stdin.readline(66).strip()
if not re.fullmatch(r'[0-9a-f]{64}', token, re.ASCII):
    raise SystemExit(1)
runtime, files, port, header, fingerprint, kernel, origin = sys.argv[1:]
runtime = Path(runtime)
spec = runtime / 'kernels' / kernel
spec.mkdir(parents=True, exist_ok=True)
(spec / 'kernel.json').write_text(json.dumps({
    'argv': [sys.executable, '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    'display_name': 'Python 3 (远程算力)',
    'language': 'python',
}), encoding='utf-8')


class WorkbenchServer(ServerApp):
    def migrate_config(self):
        pass

    def load_config_file(self, suppress_errors=True):
        pass


class WorkbenchKernelSpecs(KernelSpecManager):
    @default('kernel_dirs')
    def _kernel_dirs_default(self):
        return [str(spec.parent)]


config = Config()
config.ServerApp.ip = '127.0.0.1'
config.ServerApp.port = int(port)
config.ServerApp.port_retries = 0
config.ServerApp.base_url = '/'
config.ServerApp.root_dir = files
config.ServerApp.runtime_dir = str(runtime)
config.ServerApp.open_browser = False
config.ServerApp.no_browser_open_file = True
config.ServerApp.allow_root = True
config.ServerApp.allow_remote_access = False
config.ServerApp.local_hostnames = ['localhost', 'xrapi.wuhan.net.cn']
config.ServerApp.allow_origin = origin
config.ServerApp.allow_unauthenticated_access = False
config.ServerApp.terminals_enabled = False
config.ServerApp.jpserver_extensions = {}
config.ServerApp.shutdown_no_activity_timeout = 900
config.ServerApp.kernel_spec_manager_class = WorkbenchKernelSpecs
config.ServerApp.tornado_settings = {'headers': {header: fingerprint}}
config.ServerApp.log_level = 'CRITICAL'
config.IdentityProvider.token = token
config.PasswordIdentityProvider.hashed_password = ''
config.PasswordIdentityProvider.allow_password_change = False
config.GatewayClient.url = ''
config.KernelSpecManager.ensure_native_kernel = False
config.KernelSpecManager.allowed_kernelspecs = {kernel}
app = WorkbenchServer.instance(config=config)
app.initialize(argv=[], find_extensions=False)
app.start()
'''


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


class SetupFailure(Exception):
    """An error with safe text for the terminal."""


def checked_directory(directory, private):
    directory.mkdir(mode=0o700, exist_ok=True)
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise SetupFailure(f'Jupyter 目录 {directory} 属主或权限不匹配。请核对当前实例和目录。')
        # Python's venv and archive extraction can create an owned directory
        # with mode 0755. Tighten that directory before storing runtime data.
        if private and info.st_mode & 0o077:
            os.fchmod(descriptor, 0o700)
            print(f'已将 Jupyter 目录 {directory} 的权限设为 700。', flush=True)
    finally:
        os.close(descriptor)


def mounted_data():
    if not DATA.is_dir():
        return False
    try:
        with open('/proc/self/mountinfo', encoding='utf-8') as mounts:
            return any(line.split(' ', 5)[4] == str(DATA) for line in mounts)
    except OSError:
        return DATA.is_mount()


def port_open():
    try:
        with socket.create_connection(('127.0.0.1', PORT), timeout=0.5):
            return True
    except ConnectionRefusedError:
        return False


def ready(client, fingerprint):
    url = f'http://127.0.0.1:{PORT}/api/kernelspecs'
    try:
        with client.open(url, timeout=1):
            return False
    except HTTPError as error:
        with error:
            header = error.headers.get(PAIR_HEADER, '')
            if error.code not in (401, 403) or not hmac.compare_digest(header, fingerprint):
                return False
    except (URLError, OSError):
        return False

    request = Request(url, headers={'Authorization': f'token {TOKEN}'})
    try:
        with client.open(request, timeout=2) as response:
            kernels = json.loads(response.read(16384))
            return response.status == 200 and KERNEL in kernels.get('kernelspecs', {})
    except (ValueError, TypeError, AttributeError, OSError):
        return False


def has_requirements(python, runtime):
    if not python.is_file():
        return False
    try:
        check = subprocess.run([str(python), '-c', REQUIREMENTS], cwd=runtime, timeout=10,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return check.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def install_step(command, runtime, label, timeout):
    log_path = runtime / 'setup.log'
    descriptor = os.open(log_path, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, 'a', encoding='utf-8') as log:
        info = os.fstat(log.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise SetupFailure('Jupyter 安装记录权限不安全。')
        print(label, flush=True)
        log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + label + '\n')
        log.flush()
        try:
            result = subprocess.run(command, cwd=runtime, timeout=timeout,
                                    stdout=log, stderr=subprocess.STDOUT)
            outcome = '完成' if result.returncode == 0 else f'失败，退出码 {result.returncode}'
        except subprocess.TimeoutExpired:
            outcome = '失败，超过等待时间'
        except OSError:
            outcome = '失败，无法运行安装程序'
        log.write(time.strftime('%Y-%m-%d %H:%M:%S ') + outcome + '\n')
        log.flush()
    if outcome != '完成':
        raise SetupFailure(f'{label}{outcome}。安装记录保存在 {log_path}。请检查当前实例的软件源和网络后重试。')


def install_offline(python, runtime):
    if sys.platform != 'linux' or sys.version_info[:2] != (3, 12) or platform.machine() != 'x86_64':
        return False
    try:
        descriptor = os.open(OFFLINE_ARCHIVE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return False
    with os.fdopen(descriptor, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_OFFLINE_ARCHIVE:
            raise SetupFailure('离线依赖包不是有效的普通文件。请重新上传工作台提供的离线包。')
        payload = stream.read(MAX_OFFLINE_ARCHIVE + 1)
    if len(payload) > MAX_OFFLINE_ARCHIVE or hashlib.sha256(payload).hexdigest() not in OFFLINE_HASHES:
        raise SetupFailure('离线依赖包校验失败。请重新上传工作台提供的 A800-Jupyter-Python312-offline.zip 后重试。')

    print('已校验持久目录中的离线依赖包，正在准备本地安装。', flush=True)
    try:
        with tempfile.TemporaryDirectory(prefix='offline-', dir=runtime) as temporary:
            destination = Path(temporary)
            with ZipFile(BytesIO(payload)) as archive:
                entries = archive.infolist()
                if sum(entry.file_size for entry in entries) > MAX_OFFLINE_CONTENTS:
                    raise SetupFailure('离线依赖包解压大小超出限制。')
                seen = set()
                for entry in entries:
                    name = entry.filename.rstrip('/')
                    parts = name.split('/')
                    kind = stat.S_IFMT(entry.external_attr >> 16)
                    if (not name or name in seen or '\\' in name or PurePosixPath(name).is_absolute()
                            or any(part in ('', '.', '..') for part in parts)
                            or parts[0] != 'jupyter-offline' or kind not in (0, stat.S_IFDIR, stat.S_IFREG)
                            or any(ord(character) < 32 for character in name)):
                        raise SetupFailure('离线依赖包包含不安全的文件路径。')
                    seen.add(name)
                    # Only wheel data and its lock are needed. The installer
                    # already holds setup.lock, so it must not run install.py.
                    selected = name == 'jupyter-offline/requirements.lock' or (
                        len(parts) == 3 and parts[1] == 'wheels' and parts[2].endswith('.whl'))
                    if entry.is_dir() or not selected:
                        continue
                    target = destination.joinpath(*parts)
                    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    with archive.open(entry) as source, target.open('xb') as output:
                        copied = 0
                        while chunk := source.read(1024 * 1024):
                            copied += len(chunk)
                            if copied > entry.file_size or copied > MAX_OFFLINE_CONTENTS:
                                raise SetupFailure('离线依赖包解压大小超出限制。')
                            output.write(chunk)
            bundle = destination / 'jupyter-offline'
            if not (bundle / 'requirements.lock').is_file() or not any((bundle / 'wheels').glob('*.whl')):
                raise SetupFailure('离线依赖包缺少依赖清单或安装文件。')
            install_step([str(python), '-m', 'pip', '--isolated', '--disable-pip-version-check',
                          'install', '--no-index', '--no-deps', '--ignore-installed', '--only-binary=:all:',
                          '--require-hashes', '--find-links', str(bundle / 'wheels'),
                          '-r', str(bundle / 'requirements.lock')], runtime,
                         '正在从离线包安装 Jupyter 和 Python 内核', 600)
    except (BadZipFile, RuntimeError) as error:
        raise SetupFailure('无法读取离线依赖包。请重新上传工作台提供的离线包。') from error
    return True


def select_python(runtime):
    venv = runtime / 'venv'
    for python in (Path(sys.executable), venv / 'bin' / 'python'):
        if has_requirements(python, runtime):
            return str(python)
    if not INSTALL_DEPENDENCIES:
        raise SetupFailure(
            '当前 Python 缺少 Jupyter Server 2 或 ipykernel。确认要在专用环境安装后，请执行：\n'
            f'python3 -m venv --system-site-packages {venv}\n'
            f'{venv}/bin/python -m pip --isolated install --index-url https://pypi.org/simple '
            '--ignore-installed --timeout 120 --retries 5 "jupyter_server==2.14.1" "ipykernel==6.29.5"\n'
            '安装完成后，重新粘贴算力工作台的准备命令。'
        )
    checked_directory(venv, private=False)
    install_step([sys.executable, '-m', 'venv', '--system-site-packages', str(venv)], runtime,
                 '正在准备 Jupyter 专用 Python 环境', 120)
    python = venv / 'bin' / 'python'
    if not install_offline(python, runtime):
        install_step([str(python), '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check',
                      '--index-url', 'https://pypi.org/simple', '--ignore-installed', '--timeout', '120', '--retries', '5',
                      'jupyter_server==2.14.1', 'ipykernel==6.29.5'], runtime,
                     '正在安装 Jupyter Server 和 Python 内核，请稍候', 1800)
    if not has_requirements(python, runtime):
        raise SetupFailure(f'安装后仍无法导入 Jupyter。安装记录保存在 {runtime / "setup.log"}。')
    print(f'Jupyter 依赖已就绪，安装记录保存在 {runtime / "setup.log"}。', flush=True)
    return str(python)


def start(python, runtime, files, client, fingerprint):
    environment = {key: value for key, value in os.environ.items() if not key.startswith('JUPYTER_')}
    environment['JUPYTER_NO_CONFIG'] = '1'
    # Start in a private directory so an unrelated module in /mnt/data cannot
    # shadow Jupyter imports. The Python kernel uses the requested files directory.
    process = subprocess.Popen(
        [python, '-c', SERVER, str(runtime), str(files), str(PORT),
         PAIR_HEADER, fingerprint, KERNEL, UPSTREAM_ORIGIN],
        cwd=runtime, env=environment, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, start_new_session=True,
    )
    with process.stdin as stream:
        stream.write(TOKEN.encode('ascii') + b'\n')
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise SetupFailure('Jupyter 启动失败。请检查当前 Python 环境能否导入 jupyter_server 和 ipykernel。')
        if ready(client, fingerprint):
            return
        time.sleep(0.25)
    if process.poll() is None:
        process.terminate()
    raise SetupFailure('等待当前实例的 Jupyter 服务启动超时。请检查实例状态后重试。')


def main():
    global PORT
    if not re.fullmatch(r'[0-9a-f]{64}', TOKEN, re.ASCII):
        raise SetupFailure('准备命令无效。请从算力工作台重新复制。')
    if not re.fullmatch(r'[0-9]{5}', PORT, re.ASCII) or not 40000 <= int(PORT) < 56384:
        raise SetupFailure('Jupyter 配对端口无效。请从算力工作台重新部署。')
    PORT = int(PORT)
    os.umask(0o077)
    parent = WORK / '.compute-connect'
    runtime = parent / 'jupyter'
    checked_directory(parent, private=False)
    checked_directory(runtime, private=True)
    client = build_opener(ProxyHandler({}), NoRedirect())
    fingerprint = hashlib.sha256(TOKEN.encode('ascii')).hexdigest()
    files = DATA if mounted_data() else WORK
    lock_fd = os.open(runtime / 'setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(lock_fd, 'rb') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise SetupFailure('Jupyter 准备锁权限不安全。')
        fcntl.flock(lock, fcntl.LOCK_EX)
        if not ready(client, fingerprint):
            if port_open():
                raise SetupFailure('当前实例的 Jupyter 端口已被占用。请先保留已有任务，确认原连接已停止后再重试。')
            print('正在检查当前实例的 Jupyter 环境。', flush=True)
            python = select_python(runtime)
            print('正在启动 Jupyter 内核服务。', flush=True)
            start(python, runtime, files, client, fingerprint)
    print('WORKBENCH_JUPYTER_READY', flush=True)


if __name__ == '__main__':
    try:
        main()
    except SetupFailure as error:
        raise SystemExit(str(error)) from None
    except (OSError, subprocess.SubprocessError):
        raise SystemExit('无法准备 Jupyter。请确认当前网页终端属于该资源且 /home/work 可写。') from None
