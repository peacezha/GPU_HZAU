import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const WORKSPACE_ORIGIN = 'https://xrapi.wuhan.net.cn:9443';
const GITHUB_DEVICE_URL = 'https://github.com/login/device';
const NAME = /^[a-z0-9][a-z0-9-]{1,47}[a-z0-9]$/;
const PREFIX = /^\/notebook\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/$/;
const STATES = new Set(['idle', 'starting', 'waiting_github', 'starting_tunnel', 'ready', 'failed', 'stopped']);
const ACTIVE = new Set(['starting', 'waiting_github', 'starting_tunnel', 'ready']);

function setupCommand(source, record) {
  const payload = gzipSync(source).toString('base64').match(/.{1,72}/g).map(line => `    '${line}'`).join('\n');
  // The worker secret is supplied only to the user's own instance. The
  // installation is idempotent for the same pair and never replaces a live worker.
  return `python3 - <<'COMPUTE_WORKBENCH_SETUP'
import base64, fcntl, gzip, json, os, pathlib, socket, stat, subprocess, sys, time, urllib.request
os.umask(0o077)
root = pathlib.Path('/home/work/.compute-connect')
root.mkdir(mode=0o700, exist_ok=True)
root_fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    st = os.fstat(root_fd)
    if st.st_uid != os.geteuid() or st.st_mode & 0o022:
        raise SystemExit('Invalid workbench directory permissions.')
    if st.st_mode & 0o077:
        os.fchmod(root_fd, 0o700)
finally:
    os.close(root_fd)
lock_fd = os.open(root / 'setup.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
if not stat.S_ISREG(os.fstat(lock_fd).st_mode):
    raise SystemExit('Invalid workbench setup lock.')
fcntl.flock(lock_fd, fcntl.LOCK_EX)
cfg = {'token': '${record.token}', 'instanceId': '${record.instanceId}'}
cfg_path = root / 'tunnel-agent.json'
worker = root / 'tunnel-agent.py'
request = urllib.request.Request('http://127.0.0.1:38751/status', headers={'Authorization': 'Bearer ' + cfg['token']})
client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
def connected():
    try:
        with client.open(request, timeout=1) as response:
            return json.loads(response.read(8192)).get('instanceId') == cfg['instanceId']
    except Exception:
        return False
if connected():
    print('WORKBENCH_HELPER_READY')
    raise SystemExit(0)
try:
    with socket.create_connection(('127.0.0.1', 38751), timeout=1):
        raise SystemExit('The helper port is already used by another pairing. Keep that workbench session, or stop its helper before pairing again.')
except ConnectionRefusedError:
    pass
data = gzip.decompress(base64.b64decode((
${payload}
)))
for target, content in ((worker, data), (cfg_path, json.dumps(cfg).encode())):
    temporary = target.with_name(target.name + '.new-' + str(os.getpid()))
    with temporary.open('xb') as stream:
        stream.write(content)
    os.replace(temporary, target)
process = subprocess.Popen([sys.executable, str(worker), '--config', str(cfg_path)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
for _ in range(12):
    if connected():
        print('WORKBENCH_HELPER_READY')
        break
    if process.poll() is not None:
        raise SystemExit('Workbench helper exited. Check the current workspace and Python 3.')
    time.sleep(.25)
else:
    raise SystemExit('Workbench helper did not respond.')
COMPUTE_WORKBENCH_SETUP`;
}

async function smallJson(response) {
  if (!response.body || !/^application\/json\b/i.test(response.headers.get('content-type') || '')) throw new Error('Unexpected helper response');
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > 16_384) throw new Error('Helper response exceeded the limit');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createTunnelManager({ fetchImpl = fetch, loadAgent = () => readFile(new URL('../connectors/tunnel-agent.py', import.meta.url)) } = {}) {
  const sessions = new WeakMap();

  function getRecord(session, id) {
    let records = sessions.get(session);
    if (!records) sessions.set(session, records = new Map());
    if (!records.has(id)) {
      if (records.size >= 20) records.delete(records.keys().next().value);
      records.set(id, { target: null, checkedAt: 0, checking: null, pair: null, ownsTask: false });
    }
    return records.get(id);
  }

  async function resolveTarget(session, id, record, force = false) {
    if (record.checking) return record.checking;
    if (!force && Date.now() - record.checkedAt < 6_000) return record.target;
    record.checking = (async () => {
      const connection = await session.provider.getWorkspaceConnection(id);
      let target = null;
      if (connection?.supported && connection.url && connection.headers?.Cookie) {
        let address;
        try { address = new URL(connection.url); } catch { /* Only a valid platform endpoint can be used. */ }
        const match = PREFIX.exec(connection.allowedPrefix || '');
        if (address && match && address.origin === WORKSPACE_ORIGIN && !address.username && !address.password
          && address.pathname.startsWith(match[0])) {
          target = { instanceId: match[1], prefix: match[0], headers: connection.headers, workspaceUrl: address.toString() };
        }
      }
      if (record.pair && record.pair.instanceId !== target?.instanceId) {
        record.pair = null;
        record.ownsTask = false;
      }
      record.target = target;
      record.checkedAt = Date.now();
      return target;
    })();
    try { return await record.checking; } finally { record.checking = null; }
  }

  function unavailable(target, message) {
    return { instanceId: target?.instanceId ?? null, state: 'unavailable', deviceCode: null, deviceUrl: null,
      codeExpiresAt: null, tunnelName: null, message };
  }

  async function call(target, pair, action, json) {
    const method = json === undefined ? 'GET' : 'POST';
    const url = new URL(`${target.prefix}proxy/38751/${action}`, WORKSPACE_ORIGIN);
    const headers = {
      Accept: 'application/json', Cookie: target.headers.Cookie, Authorization: `Bearer ${pair.token}`,
      ...(target.headers['X-XSRF-TOKEN'] ? { 'X-XSRF-TOKEN': target.headers['X-XSRF-TOKEN'] } : {}),
      ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
    };
    try {
      const response = await fetchImpl(url, {
        method, headers, body: json === undefined ? undefined : JSON.stringify(json), redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      const conflict = action === 'start' && response.status === 409;
      if (!response.ok && !conflict) {
        await response.body?.cancel();
        return unavailable(target, '暂时无法访问当前实例的小助手。请在网页工作区完成准备，再刷新。');
      }
      const body = await smallJson(response);
      if (body?.instanceId !== target.instanceId || !STATES.has(body.state)) throw new Error('Unexpected helper instance or state');
      const codeExpiresAt = Number.isFinite(body.codeExpiresAt) && body.codeExpiresAt > Date.now() ? body.codeExpiresAt : null;
      const code = !conflict && body.state === 'waiting_github' && body.deviceUrl === GITHUB_DEVICE_URL && codeExpiresAt && typeof body.deviceCode === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(body.deviceCode) ? body.deviceCode : null;
      const name = typeof body.tunnelName === 'string' && NAME.test(body.tunnelName) ? body.tunnelName : null;
      if (body.state === 'ready' && !name) throw new Error('Missing tunnel name');
      const message = conflict ? '已有一个不同名称的隧道任务。请先停止该任务。'
        : typeof body.message === 'string' ? body.message.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 320) : '';
      return { instanceId: target.instanceId, state: conflict ? 'failed' : body.state, tunnelName: name,
        deviceCode: code, deviceUrl: code ? GITHUB_DEVICE_URL : null, codeExpiresAt: code ? codeExpiresAt : null, message };
    } catch {
      return unavailable(target, '当前实例的小助手没有响应。请确认准备成功且 A800 仍在运行。');
    }
  }

  async function status(session, id) {
    const record = getRecord(session, id);
    const target = await resolveTarget(session, id, record);
    if (!target) return unavailable(null, '资源尚未提供可连接的网页工作区。请先启动资源。');
    if (!record.pair) return unavailable(target, '请为当前实例准备一次后台助手。');
    return call(target, record.pair, 'status');
  }

  async function prepare(session, id) {
    const record = getRecord(session, id);
    const target = await resolveTarget(session, id, record, true);
    if (!target) return unavailable(null, '请先启动资源，等网页工作区可用后再准备助手。');
    record.pair ??= { token: randomBytes(32).toString('hex'), instanceId: target.instanceId };
    const source = await loadAgent();
    return { ...unavailable(target, '将准备指令粘贴到当前实例的网页终端。出现 WORKBENCH_HELPER_READY 后返回扩展刷新。'),
      setupCommand: setupCommand(source, record.pair), workspaceUrl: target.workspaceUrl };
  }

  async function start(session, id, { name, acceptServerLicense } = {}) {
    const record = getRecord(session, id);
    const target = await resolveTarget(session, id, record, true);
    if (!target || !record.pair) return unavailable(target, '请先为当前实例准备后台助手。');
    if (typeof name !== 'string' || !NAME.test(name) || acceptServerLicense !== true) {
      return { ...unavailable(target, '请输入有效的隧道名，并在插件中确认微软许可。'), state: 'failed' };
    }
    const result = await call(target, record.pair, 'start', { name, acceptServerLicense: true });
    if (ACTIVE.has(result.state) && result.tunnelName === name) record.ownsTask = true;
    return result;
  }

  async function stop(session, id) {
    const record = getRecord(session, id);
    const target = await resolveTarget(session, id, record, true);
    if (!target || !record.pair || !record.ownsTask) return unavailable(target, '此会话没有启动当前实例的隧道。');
    const result = await call(target, record.pair, 'stop', {});
    if (result.state === 'stopped') record.ownsTask = false;
    return result;
  }

  return { status, prepare, start, stop };
}
