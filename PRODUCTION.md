# Nova Shuttle — production checklist

The MVP is architected so that going live is **two connections**: a database and
the door hardware. Everything else — auth, guardrails, live events, analytics,
the assistant — is already in the codebase.

## 1 · Connect the database

Today all state lives in `data/db.json`, read/written through exactly two
functions in `server.js`: `loadDb()` and `saveDb()`. That is the entire storage
surface.

1. Create a PostgreSQL database and run **`schema.sql`** (multi-tenant ready:
   organizations → buses/students → trips → taps).
2. Replace the bodies of `loadDb`/`saveDb` with queries (or introduce a small
   `store.js` adapter). The in-memory shapes match the tables 1:1.
3. Move student photos from data-URLs to object storage (S3 / Supabase storage)
   and store `photo_url`.
4. Note the schema enforces anti-passback at the database level too:
   a unique index allows only one green per student per trip.

## 2 · Connect the hardware

Per bus (~AED 150–450 total):

| Part | What to buy | Why |
|---|---|---|
| Validator screen | A retired Android phone or any tablet on a pole mount | Runs `validator.html` in Chrome — camera (QR) + Web NFC in one |
| RFID reader | Any **USB keyboard-wedge** reader (ACR122U-class, ~AED 50–120) | Plug into the validator; taps type the card UID — zero drivers, already supported |
| Cards | NTAG213 stickers (~AED 1–2) on the existing paper cards, or PVC cards | Assigned/blocked from the console |
| Power | 12 V→USB adapter from the bus | Phones idle at ~2 W |

**Pair each validator:** set `VALIDATOR_KEY=<long-random-string>` in the server
environment, then on each validator tap "⚙ device key" and paste the same value.
From that moment, scan calls without the key are rejected and audited.

## 3 · Environment

| Variable | Purpose |
|---|---|
| `PORT` | Server port (injected by Render/Railway automatically) |
| `ADMIN_PASS` | Console password — set a strong one |
| `VALIDATOR_KEY` | Device key validators must present (leave unset only for demos) |

## 4 · Guardrails already running

- PINs stored as **salted scrypt hashes** — a leaked database exposes no PINs;
  admin issues a new PIN ("reset" in the console), shown exactly once
- Sessions expire (students 12 h, admin 8 h) and are swept server-side
- **Rate limits**: student login 10/5 min, admin login 5/5 min (audited),
  purchases 8/min, global API flood guard 600/min per IP
- Security headers on every response: CSP, `X-Frame-Options: DENY`,
  `nosniff`, no-referrer
- **Audit journal** for every privileged action (logins, failed logins,
  enrollment, card assign/block/unblock, PIN resets, data resets) — visible in
  the console, capped server-side
- Live event stream is **tiered**: anonymous clients receive seat counts only;
  rider identities flow only to admin-token streams

## 5 · Scale-up sequence (when, not if)

1. **Multiple buses/validators** → shared anti-passback state: move sessions +
   live trip state to Redis (the storage layer is already isolated)
2. **Payments** → swap the simulated `/api/buy` for a gateway (Stripe/Telr) and
   store `payment_ref` on passes
3. **SSO** → replace ID+PIN login with the school's Microsoft/Google tenant
4. **Live GPS** → the driver phone posts coordinates; the pass page tracker is
   already wired for live data via `/api/events`
5. **Chatbot** → swap the rule engine for a Claude-powered concierge; the chat
   UI, action plumbing (buy/block/inform) and guardrails stay as-is
