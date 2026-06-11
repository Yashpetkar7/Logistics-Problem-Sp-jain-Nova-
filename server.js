/*
 * Nova Shuttle — boarding platform server
 * Zero dependencies: plain Node.js (http, fs, crypto).
 * Run with:  node server.js   → http://localhost:3000
 * Deploy:    any Node host (Render/Railway) — respects process.env.PORT
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const DBF = path.join(DATA, 'db.json');

const PORT = Number(process.env.PORT) || 3000;
const SLOT_SECONDS = 30;      // QR rotates every 30 s
const SLOT_DRIFT = 1;         // accept ±1 slot for clock drift
const ADMIN_PASS = process.env.ADMIN_PASS || 'nova-admin';
const DEVICE_KEY = process.env.VALIDATOR_KEY || null;  // set in production: validators must present it
const TTL_STUDENT = 12 * 3600 * 1000;   // student session: 12 h
const TTL_ADMIN = 8 * 3600 * 1000;      // admin session: 8 h

/* ---------------- guardrails: rate limiting ---------------- */

const BUCKETS = new Map();    // key -> { n, reset }
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = BUCKETS.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; BUCKETS.set(key, b); }
  return ++b.n > max;
}
setInterval(() => {           // sweep stale buckets
  const now = Date.now();
  for (const [k, b] of BUCKETS) if (now > b.reset) BUCKETS.delete(k);
}, 60000).unref();

function ip(req) { return req.socket.remoteAddress || '?'; }

/* ---------------- database (one JSON file) ---------------- */

function avatar(initials, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">` +
    `<rect width="160" height="160" rx="24" fill="${bg}"/>` +
    `<text x="80" y="103" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function newSecret() { return crypto.randomBytes(16).toString('hex'); }

/* PINs are stored as salted scrypt hashes — a leaked db.json exposes no PINs */
function hashPin(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function setPin(student, pin) {
  student.pinSalt = crypto.randomBytes(8).toString('hex');
  student.pinHash = hashPin(pin, student.pinSalt);
  delete student.pin;
}
function checkPin(student, pin) {
  if (!student.pinHash) return false;
  const a = Buffer.from(hashPin(pin, student.pinSalt), 'hex');
  const b = Buffer.from(student.pinHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function seedDb() {
  const mk = (id, name, type, initials, bg) => {
    const s = {
      id, name, type, secret: newSecret(), cardUid: null, cardStatus: null,
      photo: avatar(initials, bg), createdAt: new Date().toISOString()
    };
    setPin(s, '1234');   // demo PIN — hashed at rest like production
    return s;
  };
  // Sara ships with a demo RFID card so the tap-card lane works out of the box
  const sara = mk('NS-102', 'Sara Khan', 'resident', 'SK', '#0E7C66');
  sara.cardUid = '04a25c1e'; sara.cardStatus = 'active';
  return {
    config: {
      brand: 'Nova Shuttle',
      org: 'SP Jain · Nova Towers',
      capacity: 26,
      buses: ['Bus 1', 'Bus 2', 'Bus 3'],
      prices: { single: 5, day: 8, week: 30 },   // AED — demo placeholders
      firstRun: '07:00', lastRun: '22:00', runEveryMin: 30
    },
    students: [
      mk('NS-101', 'Aarav Shah', 'resident', 'AS', '#6C4AB6'),
      sara,
      mk('NS-103', 'Rohan Mehta', 'resident', 'RM', '#B0532A'),
      mk('NS-104', 'Fatima Ali', 'resident', 'FA', '#22577A'),
      mk('NS-105', 'Daniel Fernandes', 'resident', 'DF', '#7A2257'),
      mk('NS-106', 'Priya Nair', 'resident', 'PN', '#3A5A40'),
      mk('NS-107', 'Omar Hassan', 'external', 'OH', '#555B6E'),
      mk('NS-108', 'Lily Chen', 'external', 'LC', '#8E5572')
    ],
    passes: [],   // purchased passes for external students
    trips: [],    // every trip with its taps (the audit trail)
    audit: []     // admin actions + security events
  };
}

/* every privileged action is journaled — capped so the file can't balloon */
function logAudit(action, detail) {
  db.audit.push({ time: new Date().toISOString(), action, detail: detail || '' });
  if (db.audit.length > 500) db.audit = db.audit.slice(-400);
  saveDb();
}

let db;
function loadDb() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(DBF)) {
    db = JSON.parse(fs.readFileSync(DBF, 'utf8'));
    for (const s of db.students) {           // migrate older databases
      if (s.cardUid === undefined) s.cardUid = null;
      if (s.cardStatus === undefined) s.cardStatus = s.cardUid ? 'active' : null;
      if (!s.pinHash) setPin(s, s.pin || '1234');   // hash any legacy plain PINs
    }
    if (!db.audit) db.audit = [];
    saveDbNow();
  } else {
    db = seedDb();
    saveDbNow();
  }
}
let saveTimer = null;
function saveDb() {           // debounced — keep the scan path in memory-speed
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDbNow, 250);
}
function saveDbNow() { fs.writeFileSync(DBF, JSON.stringify(db, null, 2)); }

/* ---------------- sessions (in-memory) ---------------- */

const SESSIONS = new Map();   // token -> { kind: 'student'|'admin', sid?, exp }

function makeToken(payload, ttl) {
  const t = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(t, { ...payload, exp: Date.now() + ttl });
  return t;
}
function getSession(token) {
  const s = SESSIONS.get(token);
  if (!s) return null;
  if (Date.now() > s.exp) { SESSIONS.delete(token); return null; }   // expired
  return s;
}
function session(req) {
  const h = req.headers.authorization || '';
  return getSession(h.replace(/^Bearer\s+/i, ''));
}
setInterval(() => {           // sweep expired sessions
  const now = Date.now();
  for (const [t, s] of SESSIONS) if (now > s.exp) SESSIONS.delete(t);
}, 300000).unref();

/* ---------------- live events (Server-Sent Events) ----------------
   Every screen subscribes to /api/events. Public clients get anonymous
   seat/state updates; an admin token upgrades the stream to rich events. */

const SSE_CLIENTS = new Set();   // { res, admin }

function broadcast(type, pub, adm) {
  for (const c of SSE_CLIENTS) {
    const data = c.admin ? (adm || pub) : pub;
    if (!data) continue;
    try { c.res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  }
}
setInterval(() => {              // heartbeat keeps proxies from closing streams
  for (const c of SSE_CLIENTS) { try { c.res.write(':hb\n\n'); } catch (e) {} }
}, 25000).unref();

/* ---------------- pass codes (TOTP-style) ---------------- */

function currentSlot() { return Math.floor(Date.now() / 1000 / SLOT_SECONDS); }

function signature(student, slot) {
  return crypto.createHmac('sha256', student.secret)
    .update(student.id + '|' + slot).digest('hex').slice(0, 10);
}

function payloadFor(student) {
  const slot = currentSlot();
  return `NOVA1|${student.id}|${slot}|${signature(student, slot)}`;
}

/* ---------------- entitlement ---------------- */

function activePass(sid) {
  const now = Date.now();
  return db.passes.find(p =>
    p.sid === sid && (
      (p.type === 'single' && p.ridesLeft > 0) ||
      ((p.type === 'day' || p.type === 'week') && now < new Date(p.expiresAt).getTime())
    ));
}

function passStatus(student) {
  if (student.type === 'resident') return { ok: true, label: 'Nova resident', detail: 'Shuttle included in your fees' };
  const p = activePass(student.id);
  if (!p) return { ok: false, label: 'No active pass', detail: 'Buy a pass below to ride' };
  if (p.type === 'single') return { ok: true, label: 'Single-ride pass', detail: `${p.ridesLeft} ride left` };
  const until = new Date(p.expiresAt);
  const when = p.type === 'day' ? 'today until midnight' : 'until ' + until.toLocaleDateString();
  return { ok: true, label: p.type === 'day' ? 'Day pass' : 'Weekly pass', detail: 'Valid ' + when };
}

/* ---------------- trips & scanning ---------------- */

function currentTrip(busId, autoStart) {
  let t = db.trips.find(t => t.busId === busId && !t.endedAt);
  if (!t && autoStart) {
    t = { id: 'T' + Date.now(), busId, startedAt: new Date().toISOString(), endedAt: null, taps: [] };
    db.trips.push(t);
  }
  return t;
}

function seatsLeft(trip) {
  const used = trip ? trip.taps.filter(t => t.result === 'green').length : 0;
  return Math.max(0, db.config.capacity - used);
}

function recordTap(trip, sid, result, reason, via) {
  const tap = { time: new Date().toISOString(), sid, result, reason, via: via || 'qr' };
  trip.taps.push(tap);
  saveDb();
  const boarded = trip.taps.filter(t => t.result === 'green').length;
  const denied = trip.taps.filter(t => t.result === 'red').length;
  const pub = { busId: trip.busId, boarded, denied, seatsLeft: Math.max(0, db.config.capacity - boarded), capacity: db.config.capacity };
  const who = sid ? (db.students.find(s => s.id === sid) || {}).name : null;
  broadcast('tap', pub, { ...pub, ...tap, name: who || sid || '—' });
}

function checkBoard(student, busId, via) {
  const trip = currentTrip(busId, true);

  // entitlement
  const st = passStatus(student);
  if (!st.ok) {
    recordTap(trip, student.id, 'red', 'No valid pass', via);
    return deny(student, 'No valid pass — buy one in the app');
  }
  // anti-passback: one green per student per trip
  if (trip.taps.some(t => t.sid === student.id && t.result === 'green')) {
    recordTap(trip, student.id, 'red', 'Already boarded this trip', via);
    return deny(student, 'Already boarded this trip');
  }
  // bus full
  if (seatsLeft(trip) <= 0) {
    recordTap(trip, student.id, 'red', 'Bus full', via);
    return deny(student, 'Bus is full — next run please');
  }
  // success — consume a single-ride if that is what they hold
  const p = activePass(student.id);
  if (p && p.type === 'single') { p.ridesLeft -= 1; }
  recordTap(trip, student.id, 'green', st.label, via);
  return {
    result: 'green', reason: st.label,
    student: { id: student.id, name: student.name, photo: student.photo, type: student.type },
    seatsLeft: seatsLeft(trip)
  };
}

function deny(student, reason) {
  return {
    result: 'red', reason,
    student: student ? { id: student.id, name: student.name, photo: student.photo, type: student.type } : null
  };
}

function handleScan(body) {
  const busId = body.busId || 'Bus 1';
  const parts = String(body.payload || '').trim().split('|');
  if (parts.length !== 4 || parts[0] !== 'NOVA1') {
    recordTap(currentTrip(busId, true), null, 'red', 'Unreadable / foreign code');
    return { result: 'red', reason: 'Not a Nova pass', student: null };
  }
  const [, sid, slotStr, sig] = parts;
  const student = db.students.find(s => s.id === sid);
  if (!student) {
    recordTap(currentTrip(busId, true), sid, 'red', 'Unknown student id');
    return { result: 'red', reason: 'Not enrolled', student: null };
  }
  const slot = parseInt(slotStr, 10);
  if (Math.abs(currentSlot() - slot) > SLOT_DRIFT) {
    recordTap(currentTrip(busId, true), sid, 'red', 'Expired code (old screenshot?)');
    return deny(student, 'Code expired — open your live pass');
  }
  if (signature(student, slot) !== sig) {
    recordTap(currentTrip(busId, true), sid, 'red', 'Bad signature (forged code)');
    return deny(student, 'Invalid code');
  }
  return checkBoard(student, busId, 'qr');
}

/* ---------------- schedule helper ---------------- */

function nextRuns() {
  const { firstRun, lastRun, runEveryMin } = db.config;
  const now = new Date();
  const [fh, fm] = firstRun.split(':').map(Number);
  const [lh, lm] = lastRun.split(':').map(Number);
  const runs = [];
  const d = new Date(now); d.setHours(fh, fm, 0, 0);
  const end = new Date(now); end.setHours(lh, lm, 0, 0);
  while (d <= end) {
    if (d >= now && runs.length < 3) runs.push(d.toTimeString().slice(0, 5));
    d.setMinutes(d.getMinutes() + runEveryMin);
  }
  while (runs.length < 3) runs.push('07:00');
  return runs;
}

/* ---------------- logistics analytics ---------------- */

function allTaps() {
  const out = [];
  for (const t of db.trips) for (const tap of t.taps) out.push({ ...tap, busId: t.busId, tripId: t.id, startedAt: t.startedAt });
  return out;
}

// The intelligence layer: turn boarding taps into fleet decisions.
function buildAnalytics() {
  const cap = db.config.capacity;
  const taps = allTaps();
  const greens = taps.filter(t => t.result === 'green');

  // demand by hour of day (0–23)
  const byHour = Array.from({ length: 24 }, (_, h) => ({ hour: h, boardings: 0, denied: 0 }));
  for (const t of taps) {
    const h = new Date(t.time).getHours();
    if (t.result === 'green') byHour[h].boardings++; else byHour[h].denied++;
  }
  const service = byHour.filter(x => x.boardings > 0 || x.denied > 0);
  const peak = byHour.reduce((m, x) => x.boardings > m.boardings ? x : m, byHour[0]);
  const quiet = service.length
    ? service.reduce((m, x) => x.boardings < m.boardings ? x : m, service[0])
    : { hour: null, boardings: 0 };

  // per-trip utilisation
  const tripStats = db.trips.map(t => {
    const g = t.taps.filter(x => x.result === 'green').length;
    return { id: t.id, busId: t.busId, startedAt: t.startedAt,
      boarded: g, denied: t.taps.filter(x => x.result === 'red').length,
      util: Math.round(100 * g / cap) };
  });
  const ran = tripStats.filter(t => t.boarded + t.denied > 0);
  const avgUtil = ran.length ? Math.round(ran.reduce((a, t) => a + t.util, 0) / ran.length) : 0;

  // channel mix + denial reasons
  const channel = { qr: 0, nfc: 0, manual: 0 };
  for (const g of greens) channel[g.via] = (channel[g.via] || 0) + 1;
  const reasons = {};
  for (const r of taps.filter(t => t.result === 'red')) reasons[r.reason] = (reasons[r.reason] || 0) + 1;

  // fleet recommendation: how many buses the peak hour actually needs,
  // and where we are over-serving a quiet window.
  const every = db.config.runEveryMin;
  const runsPerHour = Math.max(1, Math.round(60 / every));
  const seatsPerHourNow = runsPerHour * cap;
  const busesAtPeak = Math.max(1, Math.ceil(peak.boardings / cap));
  const recs = [];
  if (peak.boardings > seatsPerHourNow * 0.85)
    recs.push(`Peak demand at ${hh(peak.hour)} hits ${peak.boardings} riders/hr — above ${Math.round(seatsPerHourNow * 0.85)} comfortable seats. Add a run or a second bus in that window.`);
  else if (peak.boardings)
    recs.push(`Peak of ${peak.boardings} riders/hr at ${hh(peak.hour)} fits inside current capacity (${seatsPerHourNow} seats/hr). Fleet is right-sized at the top.`);
  if (quiet.hour !== null && quiet.boardings <= Math.max(1, cap * 0.25))
    recs.push(`${hh(quiet.hour)} runs nearly empty (${quiet.boardings} riders). Stretch the interval there to save a driver-shift and fuel.`);
  if (avgUtil && avgUtil < 45)
    recs.push(`Average bus leaves ${100 - avgUtil}% empty — consider a smaller vehicle off-peak or fewer runs.`);
  if (!recs.length) recs.push('Not enough boarding history yet — run a few trips (or load demo data) to see fleet recommendations.');

  return {
    capacity: cap, totalBoardings: greens.length, totalDenied: taps.length - greens.length,
    byHour, peakHour: peak.hour, peakBoardings: peak.boardings,
    avgUtil, busesAtPeak, seatsPerHourNow,
    channel, reasons,
    busiest: tripStats.slice().sort((a, b) => b.boarded - a.boarded).slice(0, 6),
    recommendations: recs
  };
}
function hh(h) { return h === null ? '—' : String(h).padStart(2, '0') + ':00'; }

// Synthetic-but-believable history so the dashboard has a story to tell on day one.
function seedDemoData() {
  const cap = db.config.capacity;
  const residents = db.students.filter(s => s.type === 'resident');
  const externals = db.students.filter(s => s.type === 'external');
  // give externals a pass so some of them board
  for (const e of externals.slice(0, 1)) {
    const ex = new Date(); ex.setHours(23, 59, 59, 999);
    db.passes.push({ id: 'P' + Math.random().toString(36).slice(2), sid: e.id, type: 'day',
      purchasedAt: new Date().toISOString(), expiresAt: ex.toISOString(), ridesLeft: null, priceAed: db.config.prices.day });
  }
  const demand = { 7: .5, 8: 1, 9: .85, 10: .4, 11: .3, 12: .45, 13: .4, 14: .35,
    15: .4, 16: .6, 17: .95, 18: .8, 19: .45, 20: .3, 21: .25 };
  const buses = db.config.buses;
  const now = new Date();
  for (const [hStr, load] of Object.entries(demand)) {
    const h = Number(hStr);
    const trips = h === 8 || h === 17 ? 2 : 1;     // double up at rush hour
    for (let r = 0; r < trips; r++) {
      const start = new Date(now); start.setHours(h, r * 25 + 5, 0, 0);
      const busId = buses[(h + r) % buses.length];
      const trip = { id: 'T' + start.getTime() + r, busId, startedAt: start.toISOString(),
        endedAt: new Date(start.getTime() + 18 * 60000).toISOString(), taps: [] };
      const riders = Math.max(2, Math.round(cap * load * (0.8 + Math.random() * 0.3)));
      const pool = residents.slice().sort(() => Math.random() - 0.5);
      let seated = 0;
      for (let i = 0; i < riders && seated < cap; i++) {
        const s = pool[i % pool.length];
        const t = new Date(start.getTime() + i * 9000);
        trip.taps.push({ time: t.toISOString(), sid: s.id, result: 'green',
          reason: 'Nova resident', via: Math.random() < 0.2 ? 'nfc' : 'qr' });
        seated++;
      }
      // a couple of denials at busy hours
      if (load > 0.6 && externals.length) {
        const e = externals[Math.floor(Math.random() * externals.length)];
        trip.taps.push({ time: new Date(start.getTime() + 60000).toISOString(), sid: e.id,
          result: 'red', reason: 'No valid pass', via: 'qr' });
      }
      db.trips.push(trip);
    }
  }
  saveDbNow();
}

/* ---------------- http plumbing ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2'
};

/* security headers on every response — clickjacking, MIME-sniffing, referrer leaks */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), microphone=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'"
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } });
  });
}

function lanIps() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/* ---------------- routes ---------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const ses = session(req);
  const isAdmin = ses && ses.kind === 'admin';
  const me = ses && ses.kind === 'student' ? db.students.find(s => s.id === ses.sid) : null;

  try {
    /* global flood guard — generous for kiosks, fatal for scripts */
    if (p.startsWith('/api/') && limited('g:' + ip(req), 600, 60000)) {
      return sendJson(res, 429, { error: 'Too many requests — slow down' });
    }

    /* ---- live event stream ---- */
    if (p === '/api/events') {
      const tok = url.searchParams.get('token') || '';
      const s = getSession(tok);
      const client = { res, admin: !!(s && s.kind === 'admin') };
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        'Connection': 'keep-alive', ...SEC_HEADERS
      });
      res.write(': connected\n\n');
      SSE_CLIENTS.add(client);
      req.on('close', () => SSE_CLIENTS.delete(client));
      return;
    }

    if (p === '/api/health') {
      const today = new Date().toDateString();
      let boardingsToday = 0;
      for (const t of db.trips) for (const tap of t.taps) {
        if (tap.result === 'green' && new Date(tap.time).toDateString() === today) boardingsToday++;
      }
      return sendJson(res, 200, {
        ok: true, version: 'v5', uptimeSec: Math.floor(process.uptime()),
        students: db.students.length, trips: db.trips.length, boardingsToday,
        liveClients: SSE_CLIENTS.size, deviceKeyRequired: !!DEVICE_KEY
      });
    }

    /* ---- open endpoints ---- */
    if (p === '/api/info') {
      return sendJson(res, 200, {
        brand: db.config.brand, org: db.config.org,
        ips: lanIps(), port: PORT, prices: db.config.prices,
        capacity: db.config.capacity, buses: db.config.buses,
        firstRun: db.config.firstRun, lastRun: db.config.lastRun, runEveryMin: db.config.runEveryMin
      });
    }

    if (p === '/api/login' && req.method === 'POST') {
      if (limited('login:' + ip(req), 10, 300000)) {
        return sendJson(res, 429, { error: 'Too many attempts — try again in a few minutes' });
      }
      const b = await readBody(req);
      const s = db.students.find(x => x.id.toUpperCase() === String(b.sid || '').trim().toUpperCase());
      if (!s || !checkPin(s, String(b.pin || '').trim())) {
        return sendJson(res, 401, { error: 'Wrong student ID or PIN' });
      }
      return sendJson(res, 200, {
        token: makeToken({ kind: 'student', sid: s.id }, TTL_STUDENT),
        student: { id: s.id, name: s.name, photo: s.photo, type: s.type }
      });
    }

    if (p === '/api/admin/login' && req.method === 'POST') {
      if (limited('alogin:' + ip(req), 5, 300000)) {
        logAudit('admin-login-throttled', 'from ' + ip(req));
        return sendJson(res, 429, { error: 'Too many attempts — wait 5 minutes' });
      }
      const b = await readBody(req);
      if (String(b.password || '') !== ADMIN_PASS) {
        logAudit('admin-login-failed', 'from ' + ip(req));
        return sendJson(res, 401, { error: 'Wrong password' });
      }
      logAudit('admin-login', 'from ' + ip(req));
      return sendJson(res, 200, { token: makeToken({ kind: 'admin' }, TTL_ADMIN) });
    }

    /* ---- validator (kiosk) endpoints ----
       Set VALIDATOR_KEY in the environment and every scan call must carry it
       (the validator page sends X-Device-Key from its saved setting). Unset = open demo. */
    const scanRoutes = ['/api/scan', '/api/scan-card', '/api/scan-manual', '/api/trip/new'];
    if (DEVICE_KEY && scanRoutes.includes(p) && req.headers['x-device-key'] !== DEVICE_KEY) {
      logAudit('scan-rejected', 'bad device key from ' + ip(req));
      return sendJson(res, 401, { error: 'Validator not authorised — set its device key' });
    }

    if (p === '/api/scan' && req.method === 'POST') {
      return sendJson(res, 200, handleScan(await readBody(req)));
    }

    if (p === '/api/scan-card' && req.method === 'POST') {
      const b = await readBody(req);
      const uid = String(b.uid || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase();
      const busId = b.busId || 'Bus 1';
      const s = db.students.find(x => x.cardUid === uid);
      if (!uid || !s) {
        recordTap(currentTrip(busId, true), null, 'red', 'Unregistered card tap', 'nfc');
        return sendJson(res, 200, { result: 'red', reason: 'Card not registered', student: null });
      }
      if (s.cardStatus === 'blocked') {
        recordTap(currentTrip(busId, true), s.id, 'red', 'Blocked card used', 'nfc');
        return sendJson(res, 200, deny(s, 'Card blocked — see the office'));
      }
      return sendJson(res, 200, checkBoard(s, busId, 'nfc'));
    }

    if (p === '/api/scan-manual' && req.method === 'POST') {
      const b = await readBody(req);
      const s = db.students.find(x => x.id === String(b.sid || '').trim().toUpperCase());
      if (!s) {
        recordTap(currentTrip(b.busId || 'Bus 1', true), b.sid || null, 'red', 'Manual: unknown id', 'manual');
        return sendJson(res, 200, { result: 'red', reason: 'Not enrolled', student: null });
      }
      return sendJson(res, 200, checkBoard(s, b.busId || 'Bus 1', 'manual'));
    }

    if (p === '/api/trip/new' && req.method === 'POST') {
      const b = await readBody(req);
      const busId = b.busId || 'Bus 1';
      const t = db.trips.find(t => t.busId === busId && !t.endedAt);
      if (t) t.endedAt = new Date().toISOString();
      const nt = currentTrip(busId, true);
      saveDb();
      broadcast('trip', { busId, boarded: 0, denied: 0, seatsLeft: db.config.capacity, capacity: db.config.capacity });
      return sendJson(res, 200, { ok: true, tripId: nt.id, seatsLeft: seatsLeft(nt) });
    }

    if (p === '/api/state') {
      const busId = url.searchParams.get('busId') || 'Bus 1';
      const t = currentTrip(busId, false);
      return sendJson(res, 200, {
        busId,
        tripStarted: t ? t.startedAt : null,
        boarded: t ? t.taps.filter(x => x.result === 'green').length : 0,
        denied: t ? t.taps.filter(x => x.result === 'red').length : 0,
        seatsLeft: t ? seatsLeft(t) : db.config.capacity,
        capacity: db.config.capacity
      });
    }

    /* ---- student endpoints (need student login) ---- */
    if (p === '/api/me') {
      if (!me) return sendJson(res, 401, { error: 'Sign in first' });
      return sendJson(res, 200, { id: me.id, name: me.name, photo: me.photo, type: me.type, status: passStatus(me) });
    }

    if (p === '/api/passcode') {
      if (!me) return sendJson(res, 401, { error: 'Sign in first' });
      const slotAge = Math.floor(Date.now() / 1000) % SLOT_SECONDS;
      const trip = currentTrip('Bus 1', false);
      return sendJson(res, 200, {
        payload: payloadFor(me),
        secondsLeft: SLOT_SECONDS - slotAge,
        slotSeconds: SLOT_SECONDS,
        status: passStatus(me),
        seatsLeft: trip ? seatsLeft(trip) : db.config.capacity,
        capacity: db.config.capacity,
        nextRuns: nextRuns(),
        prices: db.config.prices,
        card: { uid: me.cardUid, status: me.cardStatus }
      });
    }

    if (p === '/api/report-lost' && req.method === 'POST') {
      if (!me) return sendJson(res, 401, { error: 'Sign in first' });
      if (!me.cardUid) return sendJson(res, 404, { error: 'No card on file for your account' });
      me.cardStatus = 'blocked';
      saveDb();
      logAudit('card-blocked', me.id + ' (self-service: reported lost)');
      return sendJson(res, 200, { ok: true, cardStatus: 'blocked' });
    }

    if (p === '/api/buy' && req.method === 'POST') {
      if (!me) return sendJson(res, 401, { error: 'Sign in first' });
      if (limited('buy:' + me.id, 8, 60000)) return sendJson(res, 429, { error: 'Too many purchases — slow down' });
      const b = await readBody(req);
      const type = ['single', 'day', 'week'].includes(b.type) ? b.type : null;
      if (!type) return sendJson(res, 400, { error: 'bad pass type' });
      const now = new Date();
      const expires = new Date(now);
      if (type === 'day') expires.setHours(23, 59, 59, 999);
      if (type === 'week') expires.setDate(expires.getDate() + 7);
      db.passes.push({
        id: 'P' + Date.now(), sid: me.id, type,
        purchasedAt: now.toISOString(),
        expiresAt: type === 'single' ? null : expires.toISOString(),
        ridesLeft: type === 'single' ? 1 : null,
        priceAed: db.config.prices[type]
      });
      saveDb();
      return sendJson(res, 200, { ok: true, status: passStatus(me) });
    }

    /* ---- admin endpoints (need admin login) ---- */
    if (p === '/api/students' && req.method === 'GET') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      return sendJson(res, 200, db.students.map(s => ({
        id: s.id, name: s.name, type: s.type, photo: s.photo,
        cardUid: s.cardUid, cardStatus: s.cardStatus, status: passStatus(s)
      })));
    }

    if (p === '/api/students' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const b = await readBody(req);
      if (!b.name || !String(b.name).trim()) return sendJson(res, 400, { error: 'Name required' });
      const n = 100 + db.students.length + 1;
      const initials = String(b.name).trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      const s = {
        id: 'NS-' + n, name: String(b.name).trim().slice(0, 60),
        type: b.type === 'resident' ? 'resident' : 'external',
        secret: newSecret(),
        cardUid: null, cardStatus: null,
        photo: (typeof b.photo === 'string' && b.photo.startsWith('data:image')) ? b.photo : avatar(initials, '#3a3a4a'),
        createdAt: new Date().toISOString()
      };
      setPin(s, pin);                            // hash at rest; shown once below
      db.students.push(s); saveDb();
      logAudit('enroll', `${s.id} ${s.name} (${s.type})`);
      return sendJson(res, 200, { ok: true, id: s.id, pin });
    }

    if (p === '/api/reset-pin' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const b = await readBody(req);
      const s = db.students.find(x => x.id === b.sid);
      if (!s) return sendJson(res, 404, { error: 'unknown student' });
      const pin = String(Math.floor(1000 + Math.random() * 9000));
      setPin(s, pin); saveDb();
      logAudit('reset-pin', s.id);
      return sendJson(res, 200, { ok: true, pin });   // shown once, never stored in plain
    }

    if (p === '/api/assign-card' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const b = await readBody(req);
      const s = db.students.find(x => x.id === b.sid);
      if (!s) return sendJson(res, 404, { error: 'unknown student' });
      s.cardUid = String(b.uid || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase() || null;
      s.cardStatus = s.cardUid ? 'active' : null;
      saveDb();
      logAudit('assign-card', `${s.id} ← ${s.cardUid || '(cleared)'}`);
      return sendJson(res, 200, { ok: true, cardUid: s.cardUid });
    }

    if (p === '/api/card-status' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const b = await readBody(req);
      const s = db.students.find(x => x.id === b.sid);
      if (!s || !s.cardUid) return sendJson(res, 404, { error: 'no card on file' });
      if (!['active', 'blocked'].includes(b.status)) return sendJson(res, 400, { error: 'bad status' });
      s.cardStatus = b.status;
      saveDb();
      logAudit('card-' + b.status, s.id);
      return sendJson(res, 200, { ok: true, cardStatus: s.cardStatus });
    }

    if (p === '/api/admin/analytics') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      return sendJson(res, 200, buildAnalytics());
    }

    if (p === '/api/admin/seed-demo' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      seedDemoData();
      logAudit('seed-demo', db.trips.length + ' trips');
      return sendJson(res, 200, { ok: true, trips: db.trips.length });
    }

    if (p === '/api/admin/reset' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      db.trips = []; db.passes = []; saveDbNow();
      logAudit('reset-data', 'trips & passes cleared');
      return sendJson(res, 200, { ok: true });
    }

    if (p === '/api/admin/summary') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const today = new Date().toDateString();
      const todayTrips = db.trips.filter(t => new Date(t.startedAt).toDateString() === today);
      const taps = [];
      for (const t of db.trips) for (const tap of t.taps) taps.push({ ...tap, busId: t.busId, tripId: t.id });
      taps.sort((a, b) => new Date(b.time) - new Date(a.time));
      const name = sid => (db.students.find(s => s.id === sid) || {}).name || sid || '—';
      const todayTaps = taps.filter(t => new Date(t.time).toDateString() === today);
      const greens = todayTaps.filter(t => t.result === 'green');
      const perTrip = db.trips.slice(-10).map(t => ({
        label: t.busId.replace('Bus ', 'B') + ' ' + new Date(t.startedAt).toTimeString().slice(0, 5),
        green: t.taps.filter(x => x.result === 'green').length,
        red: t.taps.filter(x => x.result === 'red').length
      }));
      const revenue = db.passes.reduce((a, p) => a + (p.priceAed || 0), 0);
      return sendJson(res, 200, {
        stats: {
          ridersToday: new Set(greens.map(t => t.sid)).size,
          boardingsToday: greens.length,
          deniedToday: todayTaps.filter(t => t.result === 'red').length,
          tripsToday: todayTrips.length,
          passRevenueAed: revenue,
          enrolled: db.students.length
        },
        perTrip,
        recent: taps.slice(0, 30).map(t => ({ ...t, name: name(t.sid) })),
        exceptions: taps.filter(t => t.result === 'red').slice(0, 20).map(t => ({ ...t, name: name(t.sid) })),
        audit: db.audit.slice(-10).reverse()
      });
    }

    /* ---- static files ---- */
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUB, path.normalize(file).replace(/^([.][.][\\/])+/, ''));
    if (full.startsWith(PUB) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ...SEC_HEADERS });
      return fs.createReadStream(full).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  } catch (e) {
    sendJson(res, 500, { error: e.message });
  }
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.log(`\n  Port ${PORT} is already in use.`);
    console.log('  Close the other Nova Shuttle window, or run:  set PORT=3001 && node server.js\n');
    process.exit(1);
  }
  throw e;
});

loadDb();
server.listen(PORT, () => {
  console.log('');
  console.log('  Nova Shuttle is running');
  console.log('  -----------------------');
  console.log(`  On this laptop : http://localhost:${PORT}`);
  for (const ip of lanIps()) console.log(`  On your phone  : http://${ip}:${PORT}/pass.html  (same Wi-Fi)`);
  console.log('');
  console.log(`  Student demo login : NS-101 … NS-108, PIN 1234`);
  console.log(`  Admin demo login   : ${ADMIN_PASS}`);
  console.log('');
});
