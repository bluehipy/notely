// Database worker bridge
// Wraps Web Worker postMessage as async functions

let msgId = 0;
const pending = new Map();
const worker = new Worker('./js/db.worker.js');
let isReady = false;
const readyQueue = [];

// Handle messages from worker
worker.onmessage = ({ data }) => {
  if (data.type === 'ready') {
    console.log('SQLite WASM initialized successfully');
    isReady = true;
    readyQueue.forEach(fn => fn());
    readyQueue.length = 0;
    return;
  }

  // Worker detected DB corruption at query time — wipe OPFS and reload
  if (data.type === 'corrupt') {
    navigator.storage.getDirectory().then(async root => {
      for await (const [name] of root.entries()) {
        try { await root.removeEntry(name, { recursive: true }); } catch {}
      }
    }).finally(() => location.reload());
    return;
  }

  // Handle query responses
  const { id, result, error } = data;
  const promise = pending.get(id);
  if (!promise) return;

  pending.delete(id);
  error ? promise.reject(new Error(error)) : promise.resolve(result);
};

// Send query to worker and return promise
function query(sql, params = []) {
  return new Promise((resolve, reject) => {
    const execute = () => {
      const id = ++msgId;
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, sql, params });
    };

    // If worker is ready, execute immediately
    // Otherwise, queue it
    if (isReady) {
      execute();
    } else {
      readyQueue.push(execute);
    }
  });
}

// Public API
export const db = {
  // Execute query and return all rows
  all: (sql, params) => query(sql, params),

  // Execute write query (INSERT, UPDATE, DELETE)
  run: (sql, params) => query(sql, params),

  // Execute query and return first row or null
  get: async (sql, params) => {
    const result = await query(sql, params);
    return Array.isArray(result) ? (result[0] ?? null) : null;
  }
};

// Wait for worker to be ready
export function waitForReady() {
  return new Promise((resolve) => {
    if (isReady) {
      resolve();
    } else {
      readyQueue.push(resolve);
    }
  });
}
