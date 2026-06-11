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

/* ---------------- database (one JSON file) ---------------- */

function avatar(initials, bg) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160">` +
    `<rect width="160" height="160" rx="24" fill="${bg}"/>` +
    `<text x="80" y="103" font-family="Arial, sans-serif" font-size="64" font-weight="bold" fill="#ffffff" text-anchor="middle">${initials}</text></svg>`;
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

function newSecret() { return crypto.randomBytes(16).toString('hex'); }

function seedDb() {
  const mk = (id, name, type, initials, bg) => ({
    id, name, type, secret: newSecret(), pin: '1234', cardUid: null,
    photo: avatar(initials, bg), createdAt: new Date().toISOString()
  });
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
      mk('NS-102', 'Sara Khan', 'resident', 'SK', '#0E7C66'),
      mk('NS-103', 'Rohan Mehta', 'resident', 'RM', '#B0532A'),
      mk('NS-104', 'Fatima Ali', 'resident', 'FA', '#22577A'),
      mk('NS-105', 'Daniel Fernandes', 'resident', 'DF', '#7A2257'),
      mk('NS-106', 'Priya Nair', 'resident', 'PN', '#3A5A40'),
      mk('NS-107', 'Omar Hassan', 'external', 'OH', '#555B6E'),
      mk('NS-108', 'Lily Chen', 'external', 'LC', '#8E5572')
    ],
    passes: [],   // purchased passes for external students
    trips: []     // every trip with its taps (the audit trail)
  };
}

let db;
function loadDb() {
  if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(DBF)) {
    db = JSON.parse(fs.readFileSync(DBF, 'utf8'));
    for (const s of db.students) {           // migrate older databases
      if (!s.pin) s.pin = '1234';
      if (s.cardUid === undefined) s.cardUid = null;
    }
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

const SESSIONS = new Map();   // token -> { kind: 'student'|'admin', sid? }

function makeToken(payload) {
  const t = crypto.randomBytes(24).toString('hex');
  SESSIONS.set(t, payload);
  return t;
}
function session(req) {
  const h = req.headers.authorization || '';
  return SESSIONS.get(h.replace(/^Bearer\s+/i, '')) || null;
}

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
  trip.taps.push({ time: new Date().toISOString(), sid, result, reason, via: via || 'qr' });
  saveDb();
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

/* ---------------- http plumbing ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
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
    /* ---- open endpoints ---- */
    if (p === '/api/info') {
      return sendJson(res, 200, {
        brand: db.config.brand, org: db.config.org,
        ips: lanIps(), port: PORT, prices: db.config.prices,
        capacity: db.config.capacity, buses: db.config.buses
      });
    }

    if (p === '/api/login' && req.method === 'POST') {
      const b = await readBody(req);
      const s = db.students.find(x => x.id.toUpperCase() === String(b.sid || '').trim().toUpperCase());
      if (!s || s.pin !== String(b.pin || '').trim()) return sendJson(res, 401, { error: 'Wrong student ID or PIN' });
      return sendJson(res, 200, {
        token: makeToken({ kind: 'student', sid: s.id }),
        student: { id: s.id, name: s.name, photo: s.photo, type: s.type }
      });
    }

    if (p === '/api/admin/login' && req.method === 'POST') {
      const b = await readBody(req);
      if (String(b.password || '') !== ADMIN_PASS) return sendJson(res, 401, { error: 'Wrong password' });
      return sendJson(res, 200, { token: makeToken({ kind: 'admin' }) });
    }

    /* ---- validator (kiosk) endpoints — open in the MVP, device-keyed in production ---- */
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
        prices: db.config.prices
      });
    }

    if (p === '/api/buy' && req.method === 'POST') {
      if (!me) return sendJson(res, 401, { error: 'Sign in first' });
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
        pin: s.pin, cardUid: s.cardUid, status: passStatus(s)
      })));
    }

    if (p === '/api/students' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const b = await readBody(req);
      if (!b.name || !String(b.name).trim()) return sendJson(res, 400, { error: 'Name required' });
      const n = 100 + db.students.length + 1;
      const initials = String(b.name).trim().split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const s = {
        id: 'NS-' + n, name: String(b.name).trim(),
        type: b.type === 'resident' ? 'resident' : 'external',
        secret: newSecret(),
        pin: String(Math.floor(1000 + Math.random() * 9000)),
        cardUid: null,
        photo: (typeof b.photo === 'string' && b.photo.startsWith('data:image')) ? b.photo : avatar(initials, '#3a3a4a'),
        createdAt: new Date().toISOString()
      };
      db.students.push(s); saveDb();
      return sendJson(res, 200, { ok: true, id: s.id, pin: s.pin });
    }

    if (p === '/api/assign-card' && req.method === 'POST') {
      if (!isAdmin) return sendJson(res, 401, { error: 'Admin sign-in required' });
      const b = await readBody(req);
      const s = db.students.find(x => x.id === b.sid);
      if (!s) return sendJson(res, 404, { error: 'unknown student' });
      s.cardUid = String(b.uid || '').replace(/[^a-fA-F0-9]/g, '').toLowerCase() || null;
      saveDb();
      return sendJson(res, 200, { ok: true, cardUid: s.cardUid });
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
        exceptions: taps.filter(t => t.result === 'red').slice(0, 20).map(t => ({ ...t, name: name(t.sid) }))
      });
    }

    /* ---- static files ---- */
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUB, path.normalize(file).replace(/^([.][.][\\/])+/, ''));
    if (full.startsWith(PUB) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
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
