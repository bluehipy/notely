# Notely

A personal notes, task list, and calendar manager, built as a Chrome
extension (Manifest V3).

## Features

- **Notes** — notebooks, tags, full-text search.
- **Task lists** — basic, priority, or quantity-tracked lists.
- **Calendar** — a live view of your Google Calendar. Notely keeps no local
  copy of events: every read is a Google Calendar API call scoped to the
  visible month, and creating, editing, or deleting an event writes straight
  to Google. Supports start/end time, one-time vs. repeating events, and
  event color.
- **Dashboard** — a resizable widget grid (notes, tasks, calendar, scratchpad).
- **Optional MCP integration** — lets an MCP client (e.g. Claude Desktop)
  read and manage your notes, tasks, and calendar. This is a separate,
  opt-in channel; Notely itself has no built-in AI chat feature.

Notes, notebooks, and task lists are stored locally in the browser (SQLite
via OPFS). Calendar data is never stored locally — Google Calendar is the
only source of truth for it.

## Running it

### As the actual extension (required for the calendar)

The calendar uses `chrome.identity` for Google OAuth, which only works when
Notely is genuinely loaded as an extension — not from a plain web server.

1. In Chrome, go to `chrome://extensions`, enable **Developer mode**, click
   **Load unpacked**, and select this `code/` folder.
2. Click the Notely icon to open it in a tab.
3. Go to **Settings → Google Calendar → Connect** to enable reading and
   writing events.

> Forking this repo? The committed `manifest.json` `key` and Google OAuth
> `client_id` are tied to this specific build. Loading it unpacked gives
> your copy the same extension ID (via `key`), so the existing OAuth client
> may work as-is — but if you change the key or publish under a different
> identity, you'll need your own Google Cloud OAuth client (Chrome
> extension type) registered to that ID.

### Browser-only preview (notes & tasks only, no calendar)

```bash
node server.js
```

Then open http://localhost:3000. This is a plain dev server for iterating
on the notes/tasks UI — it sets the COOP/COEP headers OPFS needs for
persistent SQLite storage, but it isn't an extension context, so
`chrome.identity` isn't available and the calendar view won't work here.

## Optional: Claude Desktop / MCP integration

Lets an MCP-compatible client call tools against your notes, tasks, and
calendar (list/add/delete notes, tasks, task lists, and events; manage
dashboard widgets). Requires Python 3 (via the Windows `py` launcher) and
Node.js.

1. Load the extension unpacked (above) and note its ID from
   `chrome://extensions`.
2. `cd native-host` then `.\install.ps1 -ExtensionId <your-extension-id>`
   — registers `bridge.py` as Chrome's native messaging host for
   `com.notely.bridge` and points it at your Python install.
3. `cd mcp-server && npm install`, then point your MCP client (e.g.
   Claude Desktop's config) at `node mcp-server/index.js`.
4. Restart Chrome, reload the Notely extension, and keep a Notely tab open
   — tool calls are relayed into that open tab.

The bridge listens on `127.0.0.1:3779`; native-host's other Node bridge
(`bridge.js`) is unused leftover from an earlier approach and isn't wired
up to anything — `bridge.bat` runs `bridge.py` directly.
