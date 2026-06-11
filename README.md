# Nova Shuttle — tap-to-board platform

**One tap. Green light. Go.** A boarding platform for campus shuttles:
students show a rotating QR pass (or tap an NFC card sticker), a validator at the
bus door flashes green or red with the rider's photo, and the logistics office gets
a live console of every boarding — with zero effort from drivers.

Beyond the gate, it's a **logistics intelligence platform**: every tap feeds a
demand-by-hour heatmap, per-trip utilisation, channel mix, and a plain-English
**fleet recommendation** ("peak at 17:00 needs a second bus; the 14:00 run is
nearly empty — stretch the interval") in the console's *Logistics intelligence*
tab. Press **Load demo data** in the console header to see a believable full day
instantly.

Students can also **Add the pass to their phone** (PWA): it installs to the home
screen like an app on both iPhone and Android — Android/Chrome gets the native
install prompt, iOS gets a guided 3-step sheet. The pass shell opens offline; the
QR code itself is always fetched live so a stale code can never board.

Built for SP Jain · Nova Towers, but **brand, fleet, capacity, and prices are all
configuration** (`config` in `data/db.json`) — any campus, shuttle service, or gated
community with the same problem can run it.

## Run it on the laptop (easiest)

Double-click **`START-NOVA.bat`** (one folder up). It starts the server and opens
the site. That's it.

Or from a terminal:

```
cd nova-shuttle
node server.js
```

Then open **http://localhost:3000**.

### Demo logins

| Who | Where | Credentials |
|---|---|---|
| Student | `pass.html` | ID `NS-101` … `NS-108`, PIN `1234` |
| Admin | `admin.html` | password `nova-admin` (override with the `ADMIN_PASS` env var) |
| Validator | `validator.html` | no login — it's the kiosk at the door |

**Phone:** join the laptop's Wi-Fi and open the address printed in the server window
(e.g. `http://192.168.x.x:3000/pass.html`).
**Camera note:** browsers only allow the camera on `localhost` or HTTPS — so run the
validator on the laptop, or deploy (below) and the camera works on every device.

The database is one file, `data/db.json`. Delete it to reset the demo — or use the
**Reset** button in the console header (clears trips and passes, keeps students).

## Run it with Docker (one command, anywhere)

If Docker Desktop is installed, the entire platform runs identically on any
machine — laptop, server, or the college's IT box:

```
cd nova-shuttle
docker compose up
```

Then open **http://localhost:3000**. The database persists in `./data` across
restarts; change `ADMIN_PASS` in `docker-compose.yml` for real use. (Or without
compose: `docker build -t nova-shuttle . && docker run -p 3000:3000 nova-shuttle`.)

## Put it on GitHub and deploy

Streamlit can't host this — Streamlit runs Python data apps, and this is a
multi-device Node web app (camera kiosk + phone pass + console). The equivalent
free host for Node is **Render** (or Railway). One-time setup:

```
git remote add origin https://github.com/<you>/nova-shuttle.git
git push -u origin main
```

Then on [render.com](https://render.com): **New → Web Service → connect the repo**.
Render reads `render.yaml` / `package.json` and deploys automatically. You get a
public HTTPS URL like `https://nova-shuttle.onrender.com` — which means the
validator camera works on any phone or tablet, not just localhost.

Notes: the free tier sleeps after idle (first visit takes ~30 s to wake), and the
demo database resets on redeploy — both fine for an MVP. Set `ADMIN_PASS` in
Render's environment settings.

## 5-minute class demo script

1. **Happy path.** Sign in as `NS-102` (Sara) on the phone, hold the QR to the
   validator → green flash, her photo, beep. ~2 seconds, driver only glances.
2. **The window trick.** Pass the phone to a friend, scan again →
   red: *"Already boarded this trip."* Anti-passback.
3. **The screenshot trick.** A QR from a minute ago scans red:
   *"Code expired — open your live pass."* It rotates every 30 s.
4. **The freeloader.** Sign in as `NS-107` (Omar, lives nearby) → red: *"No valid
   pass."* Buy a Day pass (AED 8) in two taps → green. A sneak just became a customer.
5. **The office view.** Admin console: every tap logged, every red explained,
   boardings per trip charted, revenue counted. Hit **End trip** on the validator
   to show the per-trip reset.
6. **Dead phone?** Manual ID check-in on the validator — logged and marked `manual`.
7. **The logistics finale.** Console → **Load demo data** → *Logistics
   intelligence* tab: the demand heatmap shows the 08:00 and 17:00 rushes, and the
   fleet recommendation says exactly where to add a bus and where to cut one.
   That's the slide that turns a turnstile into a logistics platform.

## How the security works

- The QR encodes `NOVA1 | student-id | time-slot | signature` — the signature is an
  HMAC from a per-student secret, same maths as a banking OTP, new every 30 s.
  Verification needs **no internet**.
- Forged code → bad signature → red. Old screenshot → expired slot → red.
  Borrowed pass → the *owner's* photo confronts the driver. Window pass-back →
  one green per trip → red. Unknown QR → "Not a Nova pass."
- Every green **and** red is stored with time, bus, channel (qr / nfc / manual) and
  reason. Enforcement moves to the office; drivers never argue.

### NFC card stickers (option B)

The current student card is laminated paper — no chip. An **NTAG NFC sticker**
(≈ AED 1–2 each) on the back of the card turns it into a tap card:

- The validator already supports it: on an Android device, Chrome's Web NFC reads
  the sticker serial automatically (an "NFC reader active" badge appears).
- Admin assigns a sticker to a student in the console ("+ assign" in the Students
  table). Tap → same green/red + photo + anti-passback as QR.
- Honest trade-off: a bare sticker serial is static, so it's weaker than the
  rotating QR — photo-on-scan and anti-passback still catch misuse. Treat it as
  the convenience fallback, QR as the primary.

## Why no Redis (yet)

All hot data (roster, secrets, current trip) lives in server memory — a scan
round-trip is ~2–5 ms, which is already faster than a network hop to Redis would
be. Persistence is an async debounced write to disk, so the scan path never waits.
Redis earns its place when there are **multiple server instances or buses syncing
to shared state** (e.g. campus-wide anti-passback across validators) — the storage
layer here is isolated in `loadDb`/`saveDb`, so swapping it in later is a small,
contained change. "Redis-ready, not Redis-burdened" is the architecture line.

## From MVP to production

| Area | MVP today | Production step |
|---|---|---|
| Login | ID + PIN | School e-mail / SSO; validator gets a device key |
| Validator | Any browser + camera | AED 100–400 per bus: retired Android phone on a mount (NFC + camera in one) |
| Offline | Server-verified | Validator caches roster + verifies signatures offline, syncs over 4G |
| Payments | Simulated | Payment gateway or charge-to-student-account for AED 5 / 8 / 30 passes |
| Data | One JSON file | Hosted DB (+ Redis for shared real-time state at multi-site scale) |
| Tracking | Simulated animation | Phone in each bus shares live location to the pass page |
| Tenancy | One school via config | Multi-tenant: each org gets its own brand, fleet, prices |
