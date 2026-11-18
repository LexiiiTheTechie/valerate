VALERATE SUITE - macOS PORTABLE EDITION
=======================================

Everything needed to run Valerate is in this folder. You do NOT need to
install Rust or Docker. A bundled Node.js binary is included.


WHAT'S INSIDE
-------------
  Valerate Control Center.app   Control center (or valerate-dashboard binary)
  client/Valerate Messenger.app   Native desktop chat client (or bare binary)
  offline-app/                  The offline LAN server + built-in web client
  node/node                     Bundled Node.js runtime
  Start Valerate.command        One-click launcher (control center)
  Start Server Only.command     Run just the server for browser access
  Generate Certificates.command Create TLS certs for HTTPS / camera+mic
  Reset Password.command        Reset a user password
  start-server.sh               Server launcher (used by Start Server Only)
  README-macOS.txt              This file


QUICK START
-----------
1. Double-click "Start Valerate.command"
   (If macOS blocks it: Right-click → Open, or run:
    xattr -cr "/path/to/Valerate-macOS")
2. In the control center, click "Start Offline Server".
3. Click "Launch New Client Instance" to open the native desktop app.
4. Enter a username and a password of 12+ characters, then Create Account.


FILE UPLOADS / PROFILE PICTURES
-------------------------------
Sign in first, then use Edit Profile to choose a picture, or the paperclip
in chat to attach files. Uploads require an active session (you must be
signed in). The desktop client talks to the LAN server over HTTP(S); keep
the Server URL pointed at the host (default http://localhost:8080).


RUN FROM ANY DEVICE (PHONE / TABLET / OTHER MAC)
------------------------------------------------
1. On the host Mac, run "Start Server Only.command" (or start the server
   from the control center). The console prints lines such as:
       http://192.168.1.50:8080
2. On any device on the same Wi-Fi/Ethernet network, open that URL.
3. Sign in or create an account.


VOICE / VIDEO CALLS
-------------------
Browsers require HTTPS before they allow camera and microphone access.
1. Run "Generate Certificates.command" once on the host.
2. Trust offline-app/certs/rootCA.pem in Keychain Access (or use the
   sudo security command printed by the generator).
3. Connect over the https:// address (port 8443).


WHERE DATA IS STORED
--------------------
  offline-app/data/       SQLite database, vault files, audit log
  offline-app/uploads/    Chat attachments and profile pictures


SECURITY NOTES
--------------
- Defaults to HTTP on port 8080 for local/trusted LAN use.
- For HTTPS, generate certs and unset ALLOW_HTTP (or set ALLOW_HTTP=0).
- Passwords are hashed with scrypt; session tokens expire automatically.
