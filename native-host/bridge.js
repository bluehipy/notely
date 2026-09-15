#!/usr/bin/env node
// Notely Native Messaging Bridge
//
// Chrome launches this process when the extension calls connectNative().
// stdin/stdout: Chrome's Native Messaging protocol (4-byte LE length + UTF-8 JSON)
// HTTP: talks to the MCP relay at 127.0.0.1:3779
//
// Flow:
//   MCP tool call → relay /pending → bridge → extension (stdout) → extension executes
//   extension result → bridge (stdin) → relay /result → MCP server resolves

const RELAY = 'http://127.0.0.1:3779';
const POLL_MS = 100;

// ── Stdin reader ───────────────────────────────────────────────────
// Buffers incoming chunks; parses complete Native Messaging frames.
// Each frame: 4-byte LE uint32 length + UTF-8 JSON body.

let stdinBuf = Buffer.alloc(0);
const msgQueue = [];
const msgWaiters = [];

process.stdin.on('data', (chunk) => {
  stdinBuf = Buffer.concat([stdinBuf, chunk]);
  while (stdinBuf.length >= 4) {
    const len = stdinBuf.readUInt32LE(0);
    if (stdinBuf.length < 4 + len) break;
    const body = stdinBuf.slice(4, 4 + len).toString('utf8');
    stdinBuf = stdinBuf.slice(4 + len);
    let msg;
    try { msg = JSON.parse(body); } catch { continue; }
    if (msgWaiters.length > 0) {
      msgWaiters.shift()(msg);
    } else {
      msgQueue.push(msg);
    }
  }
});

process.stdin.on('end', () => process.exit(0));

function readMessage() {
  return new Promise((resolve) => {
    if (msgQueue.length > 0) {
      resolve(msgQueue.shift());
    } else {
      msgWaiters.push(resolve);
    }
  });
}

// ── Stdout writer ──────────────────────────────────────────────────

function writeMessage(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

// ── HTTP relay helpers ─────────────────────────────────────────────

async function relayGet(path) {
  const res = await fetch(`${RELAY}${path}`);
  return res.json();
}

async function relayPost(path, body) {
  await fetch(`${RELAY}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── In-flight response map ─────────────────────────────────────────
// Keyed by call id. Extension sends { id, result } back via stdin.

const inflight = new Map();

// ── Stdin loop: extension → bridge ────────────────────────────────

async function readLoop() {
  for (;;) {
    const msg = await readMessage();
    const entry = inflight.get(String(msg.id));
    if (entry) {
      clearTimeout(entry.timer);
      inflight.delete(String(msg.id));
      entry.resolve(msg.result);
    }
  }
}

// ── Poll loop: relay → extension ───────────────────────────────────

async function pollLoop() {
  for (;;) {
    try {
      const data = await relayGet('/pending');
      if (data.pending) {
        const { id, name, input } = data.pending;

        writeMessage({ id, tool: name, args: input });

        const result = await new Promise((resolve) => {
          const timer = setTimeout(() => {
            inflight.delete(String(id));
            resolve({ error: 'Extension did not respond within 12 s' });
          }, 12_000);
          inflight.set(String(id), { resolve, timer });
        });

        await relayPost('/result', { id, result });
      }
    } catch {
      // Relay not running yet — back off
      await new Promise((r) => setTimeout(r, 1_000));
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

readLoop();
pollLoop();
