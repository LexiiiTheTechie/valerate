// ==============================================================================
// AIR-GAP OFFLINE WEBSOCKET SIGNALING & EVENT DISPATCHER
// Pure Node.js built-in WebSocket server implementation (RFC 6455)
// Zero external npm packages required
// ==============================================================================
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

class PureWebSocketServer extends EventEmitter {
  constructor(server, options = {}) {
    super();
    this.clients = new Set();
    this.originCheck = typeof options.originCheck === 'function' ? options.originCheck : null;

    server.on('upgrade', (req, socket, head) => {
      const upgradeHeader = (req.headers['upgrade'] || '').toLowerCase();
      if (upgradeHeader !== 'websocket') {
        socket.destroy();
        return;
      }

      // Reject cross-site WebSocket upgrades. Native clients that do not send
      // an Origin header are still allowed; browsers always send one.
      if (this.originCheck && !this.originCheck(req)) {
        try {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        } catch (_) { /* ignore */ }
        socket.destroy();
        return;
      }

      const clientKey = req.headers['sec-websocket-key'];
      if (!clientKey) {
        socket.destroy();
        return;
      }

      const hash = crypto
        .createHash('sha1')
        .update(clientKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

      const headers = [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${hash}`
      ];

      socket.write(headers.join('\r\n') + '\r\n\r\n');

      const ws = new PureWebSocket(socket, req);
      this.clients.add(ws);

      ws.on('close', () => {
        this.clients.delete(ws);
        this.emit('clientDisconnected', ws);
      });

      this.emit('connection', ws, req);
    });
  }

  broadcast(data, filterFn = null) {
    const raw = typeof data === 'string' ? data : JSON.stringify(data);
    for (const client of this.clients) {
      if (client.readyState === 1 && (!filterFn || filterFn(client))) {
        client.send(raw);
      }
    }
  }
}

class PureWebSocket extends EventEmitter {
  constructor(socket, req) {
    super();
    this.socket = socket;
    this.req = req;
    this.readyState = 1; // 1 = OPEN
    this.buffer = Buffer.alloc(0);

    // Prevent uncaught ECONNRESET when client disconnects or closes window
    this.on('error', (err) => {
      // Gracefully handle socket reset without crashing process
      this._onClose();
    });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('end', () => this._onClose());
    socket.on('error', (err) => {
      this._onClose();
    });
  }

  send(data) {
    if (this.readyState !== 1) return;
    try {
      const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
      const len = payload.length;
      let header;

      if (len <= 125) {
        header = Buffer.from([0x81, len]);
      } else if (len <= 65535) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
      }

      this.socket.write(Buffer.concat([header, payload]));
    } catch (err) {
      this._onClose();
    }
  }

  close() {
    if (this.readyState === 1) {
      this.readyState = 2; // CLOSING
      const frame = Buffer.from([0x88, 0x00]);
      this.socket.write(frame, () => {
        this.socket.end();
      });
    }
  }

  _onClose() {
    if (this.readyState !== 3) {
      this.readyState = 3; // CLOSED
      this.emit('close');
    }
  }

  // Maximum WebSocket message payload size: 10 MB
  static get MAX_MESSAGE_BYTES() { return 10 * 1024 * 1024; }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];
      const opcode = firstByte & 0x0f;
      const isMasked = (secondByte & 0x80) !== 0;
      let payloadLen = secondByte & 0x7f;
      let offset = 2;

      if (payloadLen === 126) {
        if (this.buffer.length < 4) return;
        payloadLen = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (this.buffer.length < 10) return;
        payloadLen = Number(this.buffer.readBigUInt64BE(2));
        offset = 10;
      }

      // Reject oversized frames to prevent memory exhaustion
      if (payloadLen > PureWebSocket.MAX_MESSAGE_BYTES) {
        console.warn(`[WS] Oversized frame (${payloadLen} bytes) — closing connection.`);
        this.close();
        return;
      }

      // RFC 6455 requires client-to-server frames to be masked.
      if (!isMasked) {
        console.warn('[WS] Unmasked client frame — closing connection.');
        this.close();
        return;
      }

      const maskKeyLength = isMasked ? 4 : 0;
      const totalFrameLen = offset + maskKeyLength + payloadLen;
      if (this.buffer.length < totalFrameLen) return;

      let maskKey = null;
      if (isMasked) {
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLen));
      if (isMasked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      this.buffer = this.buffer.subarray(totalFrameLen);

      if (opcode === 0x08) {
        // Close frame
        this.close();
      } else if (opcode === 0x09) {
        // Ping -> respond with Pong
        const pong = Buffer.from([0x8a, 0x00]);
        this.socket.write(pong);
      } else if (opcode === 0x01 || opcode === 0x02) {
        // Text or Binary frame
        const msgStr = payload.toString('utf8');
        try {
          const parsed = JSON.parse(msgStr);
          this.emit('message', parsed, msgStr);
        } catch {
          this.emit('message', { type: 'raw', payload: msgStr }, msgStr);
        }
      }
    }
  }
}

module.exports = { PureWebSocketServer };
