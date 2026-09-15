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

function connectBridge() {
  try {
    nativePort = chrome.runtime.connectNative('com.notely.bridge');
  } catch (err) {
    // Native host not installed — silently skip (extension still works standalone)
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
    console.error('[notely-bridge] disconnected:', err ? err.message : 'no error');
    nativePort = null;
    setTimeout(connectBridge, 3_000);
  });
}

connectBridge();

// Relay external tool calls (from javascript_tool / any https page) to the open Notely tab
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
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
