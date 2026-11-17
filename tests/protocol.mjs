#!/usr/bin/env node
/**
 * End-to-end protocol test for the Valerate server.
 *
 * Exercises the same WebSocket + HTTP API used by the desktop and web clients.
 * Intended for a development server / throwaway database: it creates accounts
 * and uploads that are not removed afterwards.
 *
 *   node tests/protocol.mjs http://127.0.0.1:8080
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const WS_URL = BASE.replace(/^http/i, 'ws');
const PASSWORD = 'correct-horse-battery';
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ALICE = `alice-${suffix}`;
const BOB = `bob-${suffix}`;

let failures = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

class Client {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.addEventListener('open', () => resolve());
      this.ws.addEventListener('error', () => reject(new Error(`${this.name}: websocket error`)));
      this.ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.queue.push(msg);
        for (const waiter of [...this.waiters]) {
          if (waiter.predicate(msg)) {
            this.waiters.splice(this.waiters.indexOf(waiter), 1);
            clearTimeout(waiter.timer);
            waiter.resolve(msg);
          }
        }
      });
    });
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitFor(predicate, label, timeout = 5000) {
    const existing = this.queue.find(predicate);
    if (existing) {
      this.queue.splice(this.queue.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.name}: timed out waiting for ${label}`));
      }, timeout);
      this.waiters.push({ predicate, resolve, timer });
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function authenticate(client, username, isRegister) {
  client.send({ type: 'auth', username, password: PASSWORD, isRegister });
  return client.waitFor((m) => m.type === 'auth_response', 'auth_response');
}

async function main() {
  const alice = new Client('alice');
  const bob = new Client('bob');

  try {
    const root = await fetch(`${BASE}/`);
    const home = await root.text();
    check('web app served', root.status === 200 && /AirGap/i.test(home), `HTTP ${root.status}`);

    await alice.connect();
    await bob.connect();
    check('websocket connects', true);

    const aliceReg = await authenticate(alice, ALICE, true);
    check('register alice', aliceReg.success === true, aliceReg.error || 'ok');
    check(
      'auth returns channels',
      Array.isArray(aliceReg.channels) && aliceReg.channels.some((c) => c.id === 'general')
    );
    check('auth returns session token', typeof aliceReg.token === 'string' && aliceReg.token.length > 0);

    const bobReg = await authenticate(bob, BOB, true);
    check('register bob', bobReg.success === true, bobReg.error || 'ok');

    alice.send({ type: 'chat_message', channelId: 'general', text: 'hello from alice' });
    const aliceMsg = await alice.waitFor(
      (m) => m.type === 'new_message' && m.message?.text === 'hello from alice',
      'alice message'
    );
    const bobMsg = await bob.waitFor(
      (m) => m.type === 'new_message' && m.message?.text === 'hello from alice',
      'bob received message'
    );
    check('channel message stored and broadcast', Boolean(aliceMsg.message?.id) && Boolean(bobMsg.message?.id));

    bob.send({ type: 'friend_request_send', targetUser: ALICE });
    const request = await alice.waitFor((m) => m.type === 'friend_request_received', 'friend request');
    check('friend request delivered', (request.fromUser?.username || request.fromUser) === BOB);

    alice.send({ type: 'friend_request_accept', fromUser: BOB });
    const added = await bob.waitFor(
      (m) => m.type === 'friend_added' && m.friend?.username === ALICE,
      'friend added'
    );
    check('friend request accepted', Boolean(added.friend?.username));

    bob.send({ type: 'chat_message', channelId: `dm_${ALICE}_${BOB}`, text: 'secret dm' });
    const dm = await alice.waitFor((m) => m.type === 'new_message' && m.message?.text === 'secret dm', 'DM');
    check('direct message delivered', dm.message?.channelId === `dm_${ALICE}_${BOB}`);

    const upload = await fetch(`${BASE}/api/upload?filename=test-note.txt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceReg.token}` },
      body: 'hello upload',
    });
    const uploadJson = await upload.json().catch(() => ({}));
    check('chat file upload', upload.ok && typeof uploadJson.url === 'string', uploadJson.error || uploadJson.url);

    const vaultUpload = await fetch(`${BASE}/api/vault/upload?filename=vault-note.txt`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${aliceReg.token}` },
      body: 'secret vault data',
    });
    const vaultJson = await vaultUpload.json().catch(() => ({}));
    check('vault upload', vaultUpload.ok && typeof vaultJson.url === 'string', vaultJson.error || vaultJson.url);

    if (vaultJson.url) {
      // The client registers vault metadata after upload; ownership gates the
      // authenticated download.
      alice.send({
        type: 'personal_file_add_batch',
        files: [
          {
            id: `file_${suffix}`,
            fileName: 'vault-note.txt',
            folderPath: '/',
            fileSize: 17,
            fileUrl: `${BASE}${vaultJson.url}`,
            fileType: 'txt',
          },
        ],
      });
      const filesUpdate = await alice.waitFor(
        (m) => m.type === 'personal_files_updated',
        'vault metadata'
      );
      check('vault metadata registered', Array.isArray(filesUpdate.files) && filesUpdate.files.length > 0);

      const file = vaultJson.url.split('/').pop();
      const download = await fetch(`${BASE}/api/vault/${file}?token=${encodeURIComponent(aliceReg.token)}`);
      const body = await download.text();
      check(
        'vault download with token',
        download.status === 200 && body === 'secret vault data',
        `HTTP ${download.status}`
      );

      const unauthorised = await fetch(`${BASE}/api/vault/${file}`);
      check('vault download without token blocked', unauthorised.status === 401, `HTTP ${unauthorised.status}`);
    }

    const unauthorisedUpload = await fetch(`${BASE}/api/upload?filename=x.txt`, {
      method: 'POST',
      body: 'x',
    });
    check('upload without token blocked', unauthorisedUpload.status === 401, `HTTP ${unauthorisedUpload.status}`);

    alice.send({ type: 'update_profile', displayName: 'Alice T', bio: 'test bio' });
    const profile = await alice.waitFor((m) => m.type === 'profile_updated', 'profile update');
    check('profile update', profile.user?.displayName === 'Alice T');

    const aliceAgain = new Client('alice-again');
    await aliceAgain.connect();
    const login = await authenticate(aliceAgain, ALICE, false);
    check('login with saved password', login.success === true, login.error || 'ok');

    const aliceWrong = new Client('alice-wrong');
    await aliceWrong.connect();
    aliceWrong.send({ type: 'auth', username: ALICE, password: 'wrong-password-123', isRegister: false });
    const rejected = await aliceWrong.waitFor((m) => m.type === 'auth_response', 'bad login');
    check('wrong password rejected', rejected.success === false, rejected.error || 'accepted?!');

    aliceAgain.close();
    aliceWrong.close();
  } finally {
    alice.close();
    bob.close();
    await new Promise((resolve) => setTimeout(resolve, 300));
    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} TEST(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  }
}

main().catch((err) => {
  console.error('TEST ERROR:', err.message);
  process.exit(1);
});
