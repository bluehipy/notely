#!/usr/bin/env python3
"""
Notely Native Messaging Bridge
Chrome launches this script via connectNative('com.notely.bridge').

Bridges between:
  - Chrome (stdin/stdout): Native Messaging protocol (4-byte LE length + UTF-8 JSON)
  - MCP server(s) (TCP):   listens on 127.0.0.1:3779, newline-delimited JSON

The bridge OWNS the TCP server. MCP server processes connect to it as clients.
Multiple MCP clients can coexist without conflict.

Protocol (TCP):
  MCP → bridge:  {"id":"1","name":"list_tasks","input":{}} + \n  (tool call)
  Bridge → MCP:  {"id":"1","result":{...}} + \n                  (result)
"""

import sys
import os
import json
import struct
import threading
import socket
import time

# Windows requires binary mode on stdin/stdout to avoid \n -> \r\n corruption
if sys.platform == 'win32':
    import os, msvcrt
    msvcrt.setmode(sys.stdin.fileno(),  os.O_BINARY)
    msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)

MCP_HOST = '127.0.0.1'
MCP_PORT = 3779

# ── Native Messaging I/O ──────────────────────────────────────────

def read_nm_message():
    """Block until one complete Native Messaging frame arrives on stdin."""
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    length = struct.unpack('<I', header)[0]
    body   = sys.stdin.buffer.read(length)
    return json.loads(body.decode('utf-8'))


def write_nm_message(msg):
    """Write one Native Messaging frame to stdout."""
    data = json.dumps(msg, separators=(',', ':')).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ── In-flight call tracking ───────────────────────────────────────
# id -> (threading.Event, result_holder dict, mcp_socket)

_inflight      = {}
_inflight_lock = threading.Lock()


# ── Read loop: extension → bridge (via Native Messaging stdin) ────

def read_loop():
    while True:
        msg = read_nm_message()
        if msg is None:
            # stdin closed — Chrome ended the native messaging session; exit cleanly
            os._exit(0)
        call_id = str(msg.get('id', ''))
        with _inflight_lock:
            entry = _inflight.get(call_id)
        if entry:
            event, holder, _sock = entry
            holder['result'] = msg.get('result')
            event.set()


# ── MCP client handler ────────────────────────────────────────────

def handle_mcp_client(conn):
    """Handle one MCP server connection. Runs in its own thread."""
    buf = b''
    try:
        while True:
            chunk = conn.recv(4096)
            if not chunk:
                break
            buf += chunk

            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue

                call_id = str(msg['id'])
                event   = threading.Event()
                holder  = {}

                with _inflight_lock:
                    _inflight[call_id] = (event, holder, conn)

                # Push call to extension via Native Messaging
                write_nm_message({'id': msg['id'], 'tool': msg['name'], 'args': msg['input']})

                # Wait for extension response (read_loop sets the event)
                if event.wait(timeout=12):
                    result = holder.get('result', {'error': 'no result'})
                else:
                    result = {'error': 'Extension timed out after 12 s'}

                with _inflight_lock:
                    _inflight.pop(call_id, None)

                # Send result back to the MCP server that made the call
                response = json.dumps({'id': msg['id'], 'result': result},
                                      separators=(',', ':')) + '\n'
                try:
                    conn.sendall(response.encode('utf-8'))
                except Exception:
                    break

    except Exception:
        pass
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ── TCP server: MCP clients connect here ─────────────────────────

def tcp_server_loop():
    """Listen for MCP server connections. Each gets its own thread."""
    while True:
        try:
            server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            server.bind((MCP_HOST, MCP_PORT))
            server.listen(5)
            break
        except OSError:
            try:
                server.close()
            except Exception:
                pass
            time.sleep(1)

    while True:
        try:
            conn, _addr = server.accept()
            threading.Thread(target=handle_mcp_client, args=(conn,), daemon=True).start()
        except Exception:
            time.sleep(0.5)


if __name__ == '__main__':
    threading.Thread(target=tcp_server_loop, daemon=True).start()
    # read_loop runs on the main thread; it calls os._exit(0) when stdin closes
    read_loop()
