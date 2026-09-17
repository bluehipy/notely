// Opens (or focuses) the Notely tab when the extension icon is clicked
chrome.action.onClicked.addListener(async () => {
  const appUrl = chrome.runtime.getURL('index.html');
  const tabs = await chrome.tabs.query({ url: appUrl });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url: appUrl });
  }
});

// ── Native Messaging bridge ────────────────────────────────────────
// The bridge (native-host/bridge.js) forwards MCP tool calls from the
// relay server to us, and we relay them to the open Notely tab.

async function sendToNotelyTab(tool, args) {
  const appUrl = chrome.runtime.getURL('index.html');
  const tabs = await chrome.tabs.query({ url: appUrl });
  if (!tabs.length) {
    return { error: 'Notely tab is not open — click the extension icon first.' };
  }
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabs[0].id, { tool, args: args || {} }, (result) => {
      if (chrome.runtime.lastError) {
        resolve({ error: chrome.runtime.lastError.message });
      } else {
        resolve(result ?? { error: 'No response from Notely tab' });
      }
    });
  });
}

let nativePort = null;

// The native bridge is an optional, opt-in companion (Claude Desktop / MCP
// integration) — most installs never have it registered. Not finding it is
// the expected, common case, not an error: log at info level and don't spam
// retries for a host that was never installed. A crash of an *already
// connected* bridge is treated as transient and retried, since that can
// recover on its own (e.g. the user restarts bridge.py).
const NOT_INSTALLED = /not found|forbidden/i;

function connectBridge() {
  try {
    nativePort = chrome.runtime.connectNative('com.notely.bridge');
  } catch (err) {
    console.info('[notely-bridge] Native bridge unavailable — Notely works standalone:', err.message);
    return;
  }

  nativePort.onMessage.addListener(async (msg) => {
    // Bridge sends: { id, tool, args }
    const { id, tool, args } = msg;
    const result = await sendToNotelyTab(tool, args);
    nativePort.postMessage({ id, result });
  });

  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    const reason = err ? err.message : 'disconnected';
    nativePort = null;

    console.info(`[notely-bridge] Native bridge unavailable (${reason}) — Notely works standalone.`);

    // MV3 service workers get re-instantiated (and connectBridge() re-run
    // from the top) on their own next wake-up, so a permanent "not
    // installed" state doesn't need an internal retry loop at all.
    if (!NOT_INSTALLED.test(reason)) {
      setTimeout(connectBridge, 3_000);
    }
  });
}

connectBridge();

// Relay external tool calls to the open Notely tab. Restricted to local pages
// only (see externally_connectable in manifest.json) — this executes
// data-mutating tools (delete_note, delete_event, ...) with no further
// confirmation, so it must never be reachable from an arbitrary website.
// The origin check here is defense-in-depth on top of the manifest pattern,
// in case that pattern is ever loosened again without re-auditing this.
const ALLOWED_EXTERNAL_ORIGINS = [/^http:\/\/localhost(:\d+)?$/, /^http:\/\/127\.0\.0\.1(:\d+)?$/];

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const origin = sender.origin || '';
  if (!ALLOWED_EXTERNAL_ORIGINS.some((re) => re.test(origin))) {
    console.warn('[notely] Rejected external message from disallowed origin:', origin);
    sendResponse({ error: 'Origin not allowed' });
    return;
  }

  const { tool, args } = message || {};
  if (!tool) { sendResponse({ error: 'Missing tool name' }); return; }

  const appUrl = chrome.runtime.getURL('index.html');
  chrome.tabs.query({ url: appUrl }, (tabs) => {
    if (!tabs.length) {
      sendResponse({ error: 'Notely is not open — click the extension icon to open it first.' });
      return;
    }
    chrome.tabs.sendMessage(tabs[0].id, { tool, args: args || {} }, (result) => {
      if (chrome.runtime.lastError) {
        sendResponse({ error: chrome.runtime.lastError.message });
      } else {
        sendResponse(result);
      }
    });
  });

  return true; // keep channel open for async response
});
