import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

// Execute a fixed, silent expression in a disposable kernel through the same
// authenticated listener used by the desktop Jupyter extension.
export async function verifyJupyterConnection(serverUrl, { signal, fetchImpl = fetch } = {}) {
  const base = new URL(serverUrl);
  const headers = { Authorization: `token ${base.searchParams.get('token')}`, 'Content-Type': 'application/json' };
  const request = (path, options = {}, timeout = 10_000) => fetchImpl(new URL(path, base), {
    ...options, headers, redirect: 'error',
    signal: options.method === 'DELETE' || !signal ? AbortSignal.timeout(timeout) : AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
  });
  const name = `workbench-check-${randomUUID()}.ipynb`;
  let id, websocket;
  try {
    const response = await request('api/sessions', { method: 'POST', body: JSON.stringify({ name, path: name, type: 'notebook', kernel: { name: 'python3' } }) });
    if (response.status !== 201) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Jupyter refused a test session');
    }
    const created = await response.json();
    if (!idPattern.test(created?.id || '')) throw new Error('Invalid Jupyter session');
    id = created.id;
    if (!idPattern.test(created.kernel?.id || '')) throw new Error('Invalid Jupyter kernel');
    const channel = new URL(`api/kernels/${created.kernel.id}/channels`, base);
    channel.protocol = 'ws:';
    channel.searchParams.set('session_id', id);
    channel.searchParams.set('token', base.searchParams.get('token'));
    websocket = new WebSocket(channel);
    const timeout = AbortSignal.timeout(20_000);
    const waiting = signal ? AbortSignal.any([signal, timeout]) : timeout;
    await once(websocket, 'open', { signal: waiting });
    const msgId = randomUUID();
    const reply = new Promise((resolve, reject) => {
      const fail = () => reject(new Error('Jupyter test execution did not complete'));
      waiting.addEventListener('abort', fail, { once: true });
      websocket.addEventListener('close', fail, { once: true });
      websocket.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.parent_header?.msg_id !== msgId || message.header?.msg_type !== 'execute_reply') return;
        waiting.removeEventListener('abort', fail);
        websocket.removeEventListener('close', fail);
        if (message.content?.status === 'ok' && message.content.user_expressions?.check?.data?.['text/plain'] === '4') resolve();
        else fail();
      });
    });
    websocket.send(JSON.stringify({ header: { msg_id: msgId, username: 'workbench', session: id,
      msg_type: 'execute_request', version: '5.3', date: new Date().toISOString() }, parent_header: {}, metadata: {},
      channel: 'shell', buffers: [], content: { code: '', silent: true, store_history: false,
        user_expressions: { check: '2 + 2' }, allow_stdin: false, stop_on_error: true } }));
    await reply;
  } finally {
    websocket?.close();
    if (id) await request(`api/sessions/${id}`, { method: 'DELETE' }, 5000).then(response => response.body?.cancel()).catch(() => {});
  }
}
