-- Nova Shuttle — production database schema (PostgreSQL)
-- The MVP stores everything in data/db.json with the same shapes.
-- Point the storage layer at this schema and the data model carries over 1:1.

CREATE TABLE organizations (             -- multi-tenant: one row per campus/community
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  brand       TEXT NOT NULL DEFAULT 'Nova Shuttle',
  capacity    INT  NOT NULL DEFAULT 26,
  first_run   TIME NOT NULL DEFAULT '07:00',
  last_run    TIME NOT NULL DEFAULT '22:00',
  run_every_min INT NOT NULL DEFAULT 30,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE buses (
  id          SERIAL PRIMARY KEY,
  org_id      INT NOT NULL REFERENCES organizations(id),
  label       TEXT NOT NULL,                    -- 'Bus 1'
  device_key  TEXT,                             -- validator pairing key (hashed in app layer)
  UNIQUE (org_id, label)
);

CREATE TABLE students (
  id          TEXT PRIMARY KEY,                 -- 'NS-101'
  org_id      INT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('resident', 'external')),
  secret      TEXT NOT NULL,                    -- per-student HMAC secret for rotating QR
  pin_salt    TEXT NOT NULL,
  pin_hash    TEXT NOT NULL,                    -- scrypt(pin, salt) — never plaintext
  card_uid    TEXT UNIQUE,                      -- RFID/NFC serial, lowercase hex
  card_status TEXT CHECK (card_status IN ('active', 'blocked')),
  photo_url   TEXT,                             -- move data-URLs to object storage
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_students_card ON students(card_uid) WHERE card_uid IS NOT NULL;

CREATE TABLE passes (
  id           SERIAL PRIMARY KEY,
  student_id   TEXT NOT NULL REFERENCES students(id),
  type         TEXT NOT NULL CHECK (type IN ('single', 'day', 'week')),
  price_aed    NUMERIC(8,2) NOT NULL,
  rides_left   INT,                             -- single-ride passes only
  purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,                     -- day/week passes only
  payment_ref  TEXT                             -- gateway transaction id
);
CREATE INDEX idx_passes_student ON passes(student_id, expires_at);

CREATE TABLE trips (
  id          SERIAL PRIMARY KEY,
  bus_id      INT NOT NULL REFERENCES buses(id),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at    TIMESTAMPTZ
);
CREATE INDEX idx_trips_open ON trips(bus_id) WHERE ended_at IS NULL;

CREATE TABLE taps (                             -- the audit trail: every green AND red
  id          BIGSERIAL PRIMARY KEY,
  trip_id     INT NOT NULL REFERENCES trips(id),
  student_id  TEXT REFERENCES students(id),     -- NULL for unknown cards/codes
  result      TEXT NOT NULL CHECK (result IN ('green', 'red')),
  reason      TEXT NOT NULL,
  via         TEXT NOT NULL CHECK (via IN ('qr', 'nfc', 'manual')),
  tapped_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_taps_trip ON taps(trip_id);
CREATE INDEX idx_taps_time ON taps(tapped_at);
-- anti-passback at database level: one green per student per trip
CREATE UNIQUE INDEX idx_antipassback ON taps(trip_id, student_id) WHERE result = 'green';

CREATE TABLE audit_log (                        -- privileged actions
  id          BIGSERIAL PRIMARY KEY,
  org_id      INT REFERENCES organizations(id),
  action      TEXT NOT NULL,                    -- 'admin-login', 'card-blocked', 'reset-pin', …
  detail      TEXT,
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
