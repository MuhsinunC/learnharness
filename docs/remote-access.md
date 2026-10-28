# Open LearnHarness from your phone

LearnHarness runs on your computer. With remote access on, you can also use
it from your phone, through Tailscale, a free private network that joins only
your own devices. Nothing is put on the public internet.

You need:
- the computer that runs LearnHarness: **the desktop app**, or web mode
  started with `npm start` (never `npm run dev`, see below);
- your phone;
- one Tailscale account, the same one on both.

## 1. Install Tailscale on both devices

1. On the computer, install Tailscale from <https://tailscale.com/download> and
   sign in.
2. On the phone, install the Tailscale app (App Store or Google Play) and sign
   in with the **same** account.
3. In the Tailscale app on both devices, check that the other device is listed
   and shows as connected.

## 2. Set a password

**Desktop app:**
1. Open **Settings → General → Remote access**.
2. Type a password of at least 8 characters and press **Save**. The status
   line says "On".
3. Quit LearnHarness (⌘Q) and open it again. From then on it always uses the
   same port, 3757, so Tailscale can find it. If Settings still says to quit
   and reopen, another program is using port 3757: quit that program.
   (Advanced: start the app from Terminal with another port above 1023, for
   example
   `LH_REMOTE_PORT=3758 /Applications/LearnHarness.app/Contents/MacOS/LearnHarness`,
   and use that port in step 3.)

The app window itself never asks for the password.

**Web mode:** in Terminal, in the LearnHarness folder, run

```bash
npm run remote-access:set-password
```

It asks for the password twice and doesn't show what you type. It writes to
the same data folder `npm start` uses (`LH_DATA_DIR` if you set one, so set
it the same way for both). Then start
LearnHarness with `npm start` (after `npm run build`). From now on **every
browser logs in, the one on this computer too**: once a password exists,
LearnHarness can no longer tell a browser on this computer from a forwarded
one, so it trusts nobody without the password.

Changing the password: in the desktop app, just save a new one. In a
logged-in browser, type the current password next to the new one. Or run the
command above again. Every change logs every device out.

Turning it off: **Turn off** in Settings (a browser needs the current
password), or `npm run remote-access:off`. The desktop app goes back to a
random port the next time it opens.

## 3. Share LearnHarness on your tailnet

**Settings → General → Remote access** now shows the exact command and the
address for your phone. Open **Terminal** on the computer and run the command
once. For the desktop app it is:

```bash
tailscale serve --bg 3757
```

In web mode it is your `npm start` port instead (3000 unless you changed it
with `LH_LISTEN_PORT`).

On a Mac with the Tailscale app from the App Store or tailscale.com, the
`tailscale` command may be missing from Terminal. Use the full path instead:

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve --bg 3757
```

Tailscale prints an address such as `https://my-laptop.tail1234.ts.net`, the
same one Settings shows. It keeps serving, also after a restart, until you run
`tailscale serve --https=443 off` (or `tailscale serve reset`).

If Tailscale asks you to enable HTTPS certificates for your tailnet, follow the
link it prints and turn them on (one click in the Tailscale admin console).

## 4. Open it on the phone

1. With Tailscale connected on the phone, open the `https://…ts.net` address in
   the phone's browser.
2. Enter the password. You stay logged in on that phone for 30 days, or until
   you tap **Settings → General → Log out** or the password changes.

The computer must be awake with LearnHarness open (the desktop app running, or
`npm start` running) for the phone to reach it.

## What is safe, and what isn't

Safe:
- `tailscale serve` (plain `--bg <port>`, the HTTPS mode) is reachable only by
  devices signed in to your tailnet. It uses a real HTTPS certificate, so the
  password and the login cookie are encrypted, and the cookie is marked
  Secure.
- LearnHarness itself listens only on `127.0.0.1`. Other computers on your
  Wi-Fi cannot reach it, and it refuses any other address.
- Once a password exists, every page, API call, live update and attachment
  needs the login, whatever the request looks like. The only exception is the
  desktop app's own window, which proves itself with a private key made fresh
  at every launch; a phone never gets that key.
- The login cookie can't be read by scripts and isn't sent by other websites,
  and other websites can't submit the login or logout form. Wrong passwords
  are rate-limited: five failures lock that device out for 15 minutes, and
  thirty failures in total lock everyone out for 15 minutes.
- The first password can only be set in the desktop app or with the terminal
  command, never by a web page. Changing it from a browser needs the current
  password.
- A logged-in browser can use the app, but nothing that acts on the computer
  itself: the Claude Code connection (its program path, custom endpoint and
  token, sign-in), ChatGPT, Copilot and Grok sign-in, and attaching an image
  by its file path. It shows "Change this in the LearnHarness desktop app on
  the computer" instead (in web mode: turn remote access off with
  `npm run remote-access:off`, change it, then set the password again). In
  the desktop app, API keys too can only be changed in the app window. In
  web mode a browser may still save or delete an API key, because once a
  password exists every browser is logged in, the one on the computer too.
- The password is stored only as a slow scrypt hash, in `web-login.json` in the
  data folder (readable only by your user).

Not safe, don't do it:
- **`npm run dev` with remote access.** A development server has built-in
  tools (restart, debugger, opening files in your editor) that skip the login.
  LearnHarness ignores the password there, and you must never point
  `tailscale serve` at a development server; `npm run dev` refuses to start
  on a port that tailscale serve forwards.
- **Leaving `tailscale serve` on when you stop using remote access.** Serve
  keeps forwarding your tailnet to the port, whatever program holds it. If you
  turn remote access off, uninstall LearnHarness, or start another program on
  that port (3000 is a common default for developer tools), first run
  `tailscale serve --https=443 off`. Settings reminds you after **Turn off**.
- **Forwarding the port before you set a password.** Without a password,
  LearnHarness trusts requests that look like they come from this computer.
  Any plain TCP forwarder makes outside requests look exactly like that:
  `tailscale serve --tcp` or `--tls-terminated-tcp`, editor or IDE port
  forwarding (VS Code, Cursor), `ssh -R`, ngrok, cloudflared. Set the password
  first, and use only plain `tailscale serve --bg <port>`.
- **Tailscale Funnel** (`tailscale funnel`) puts the app on the public
  internet. Never use it for LearnHarness.
- **Sharing your tailnet or this device** with other people gives them a path
  to the login page. Anyone you share with still needs the password, so pick
  one you don't use anywhere else.
- Without a password, anyone using the computer itself has full access, as
  before. Lock the computer when you leave it.
- Remote access is only as private as your Tailscale account. Use a strong
  password or sign-in for that account, and remove devices you no longer use.

## Ports (web mode)

`npm run dev` and `npm start` go through `scripts/web-server.mjs`. It always
listens on `127.0.0.1`; `LH_LISTEN_PORT` (else `PORT`, else 3000) sets the
port. It refuses any other address (`LH_LISTEN_HOST`) and any `-H`/`-p`
option, because a phone reaches LearnHarness through `tailscale serve`, never
by LearnHarness listening on a network.

## Starting it from your own script

A script that starts LearnHarness for phone access must use a production
server, never `next dev`. From the LearnHarness folder:

```bash
npm ci                                   # once, and after every update
npm run build                            # after every update
export LH_DATA_DIR=/path/to/your/data    # the same folder for every step
npm run remote-access:set-password       # once
LH_LISTEN_PORT=3757 npm start            # keep your other exports (keys, ...) before this
tailscale serve --bg 3757                # once; it survives restarts
```

Then open the `https://…ts.net` address on the phone and log in. The browser
on the computer logs in too.
