# Open LearnHarness from your phone

LearnHarness runs on your computer. With remote access on, you can also use
it from your phone, through Tailscale, a free private network that joins only
your own devices. Nothing is put on the public internet.

You need:
- the computer that runs LearnHarness (web mode, `npm run dev` or `npm start`);
- your phone;
- one Tailscale account, the same one on both.

The desktop app has no remote access. Use web mode for this.

## 1. Install Tailscale on both devices

1. On the computer, install Tailscale from <https://tailscale.com/download> and
   sign in.
2. On the phone, install the Tailscale app (App Store or Google Play) and sign
   in with the **same** account.
3. In the Tailscale app on both devices, check that the other device is listed
   and shows as connected.

## 2. Set a password in LearnHarness

1. Start LearnHarness on the computer as usual and open it in the browser
   there (`http://127.0.0.1:3000`).
2. Open **Settings → General → Remote access**.
3. Type a password of at least 8 characters and press **Save**. The status
   line says "On".

You never need this password on the computer itself, only on other devices.
Saving a new password logs every other device out. **Turn off** removes the
password and logs every device out.

## 3. Share LearnHarness on your tailnet

In a terminal on the computer, run (use your port if it isn't 3000):

```bash
tailscale serve --bg 3000
```

Tailscale prints an address such as `https://my-laptop.tail1234.ts.net`. It
keeps serving after a restart until you run `tailscale serve --https=443 off`
(or `tailscale serve reset`).

If Tailscale asks you to enable HTTPS certificates for your tailnet, follow the
link it prints and turn them on (one click in the Tailscale admin console).

## 4. Open it on the phone

1. With Tailscale connected on the phone, open the `https://…ts.net` address in
   the phone's browser.
2. Enter the password. You stay logged in on that phone for 30 days, or until
   you tap **Settings → General → Log out** or change the password.

## What is safe, and what isn't

Safe:
- `tailscale serve` is reachable only by devices signed in to your tailnet. It
  uses a real HTTPS certificate, so the password and the login cookie are
  encrypted, and the cookie is marked Secure.
- LearnHarness itself still listens only on `127.0.0.1`. Other computers on
  your Wi-Fi cannot reach it.
- Every page, API call, live update and export from another device needs the
  login. The login cookie can't be read by scripts and isn't sent by other
  websites. Wrong passwords are rate-limited: five failures lock that device
  out for 15 minutes, and thirty failures in total lock everyone out for
  15 minutes.
- A logged-in phone can use the app but can't change or remove the password.
  Only the computer itself can.
- The password is stored only as a slow scrypt hash, in `web-login.json` in the
  data folder (readable only by your user).

Not safe, don't do it:
- **Tailscale Funnel** (`tailscale funnel`) puts the app on the public
  internet. Never use it for LearnHarness.
- **Other tunnels or reverse proxies** (ngrok, cloudflared, nginx, Caddy) are
  not supported. Some of them make requests look like they come from the
  computer itself, which LearnHarness trusts without a login.
- **Sharing your tailnet or this device** with other people gives them a path
  to the login page. Anyone you share with still needs the password, so pick
  one you don't use anywhere else.
- Anyone using the computer itself has full access without a password, as
  before. Lock the computer when you leave it.

## Other ways to listen (advanced)

`npm run dev` and `npm start` go through `scripts/web-server.mjs`, which
always listens on `127.0.0.1` unless told otherwise:

| Variable | Meaning |
|---|---|
| `LH_LISTEN_PORT` | Port, default `PORT` or 3000. |
| `LH_LISTEN_HOST` | Address. Default `127.0.0.1`. |
| `LH_LISTEN_ALL=1` | Also required for `0.0.0.0` or `::`. |

- Listening on anything except loopback needs a password set first; without
  one the server refuses to start.
- The only other addresses accepted are this computer's Tailscale IP
  (`tailscale ip -4`, a `100.x.y.z` address, or its `fd7a:115c:a1e0::` IPv6
  one). LAN and public addresses and hostnames are always refused.
- `LH_LISTEN_HOST=100.x.y.z` (direct, no `tailscale serve`) works on plain
  http, and the tailnet encrypts the traffic. Every browser, including the one
  on the computer, then needs the login, and the password can only be changed
  after restarting on `127.0.0.1`.
- `0.0.0.0` exposes the login page to your whole Wi-Fi network over plain http.
  Avoid it.

If you start Next directly (`npx next dev`), `LH_LISTEN_HOST` is not set, so
LearnHarness can't tell what it is listening on. It works as before on
loopback, and Settings refuses to set a password: start it with `npm run dev`
or `npm start` (or set `LH_LISTEN_HOST=127.0.0.1`) to turn remote access on.
If a password already exists from an earlier run, every request, local ones
too, needs the login.
