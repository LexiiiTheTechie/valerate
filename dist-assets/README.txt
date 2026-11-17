VALERATE SUITE - PORTABLE EDITION
=================================

Everything needed to run Valerate is in this folder. You do NOT need to
install Node.js, Rust, Docker, or any other dependency on Windows.


WHAT'S INSIDE
-------------
  valerate-dashboard.exe  Control center (start/stop server, launch clients,
                          live logs, wipe vault)
  client\offline-tauri-client.exe
                          Native desktop chat client
  offline-app\            The offline LAN server + built-in web client
  node\node.exe           Bundled Node.js runtime (Windows)
  Start Valerate.bat      One-click launcher (control center)
  Start Server Only.bat   Run just the server for browser access
  Generate Certificates.bat
                          Create TLS certs for HTTPS / camera+mic support
  start-server.sh         Server launcher for macOS / Linux (needs Node 22.5+)
  README.txt              This file


QUICK START (WINDOWS)
---------------------
1. Double-click "Start Valerate.bat".
2. In the control center, click "Start Offline Server".
3. Click "Launch New Client Instance" to open the native desktop app.
4. Enter a username and a password of 12+ characters, then Create Account.


RUN FROM ANY DEVICE (PHONE / TABLET / OTHER PC)
-----------------------------------------------
The server includes a full web app, so any device with a browser can use it.

1. On the host PC, run "Start Server Only.bat" (or start the server from the
   control center). The console prints lines such as:
       http://192.168.1.50:8080
2. On any phone, tablet, or other computer on the same Wi-Fi/Ethernet network,
   open that URL in a browser.
3. Sign in or create an account. Chat, channels, friends, file sharing, and
   the personal vault all work in the browser.

If other devices cannot connect:
  - Allow Node.js / Valerate through Windows Firewall (Private networks).
  - Make sure all devices are on the same network and client isolation is off.
  - Ports: 8080 (HTTP) and 8443 (HTTPS, if enabled).


DESKTOP CLIENT ON ANOTHER PC
----------------------------
Copy this whole folder to the other Windows PC, run "Start Valerate.bat",
launch the client, and set the Server URL to the host machine, for example:
    http://192.168.1.50:8080


VOICE / VIDEO CALLS
-------------------
Browsers require HTTPS before they allow camera and microphone access.
For calls from other devices:
1. Run "Generate Certificates.bat" once on the host PC (this can take a
   minute; it is never run automatically, so normal startup stays fast).
2. Install certs\rootCA.pem as a trusted root certificate on each device.
3. Start the server and use the https:// address printed by the server
   (port 8443) instead of http.
Desktop clients already accept the local certificate automatically.


WHERE DATA IS STORED
--------------------
  offline-app\data\       SQLite database, vault files, audit log
  offline-app\uploads\    Chat attachments
Copy those folders to back up or move an installation. To reset the personal
vault only, run the "Wipe Personal Vault DB" button in the control center.

ACCOUNTS: the downloadable ZIP ships with an EMPTY account database. On a
brand-new install, click "Create Account" (not "Sign In") for your first
login. To delete every account, chat, vault file and upload in one step, use
"Wipe ALL Server Data" in the control center (or delete the two folders above
while the server is stopped).


SECURITY NOTES
--------------
- The portable pack defaults to HTTP mode on port 8080 so it works without
  Administrator rights. Use it only on a trusted local network.
- For HTTPS, set ALLOW_HTTP=0 and install the generated root CA on clients.
- Passwords are hashed with scrypt; session tokens expire automatically.
