-- VoteChain display cache (Storage Layer, Section 3.3.5).
-- The blockchain is the authoritative record; these tables are rebuilt from contract events by
-- src/indexer.js and hold session tokens, cached summaries and the notification queue.

CREATE TABLE IF NOT EXISTS indexer_state (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chain_events (
  id            BIGSERIAL PRIMARY KEY,
  block_number  BIGINT NOT NULL,
  block_time    TIMESTAMPTZ,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  contract      TEXT NOT NULL,
  name          TEXT NOT NULL,
  level         SMALLINT,
  unit_id       BIGINT,
  actor         TEXT,
  args          JSONB NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_unit_idx ON chain_events (level, unit_id, block_number DESC);
CREATE INDEX IF NOT EXISTS chain_events_name_idx ON chain_events (name, block_number DESC);

CREATE TABLE IF NOT EXISTS stakeholders (
  address           TEXT PRIMARY KEY,
  category          TEXT NOT NULL,
  level             SMALLINT,
  unit_id           BIGINT,
  party_id          BIGINT,
  registered_block  BIGINT,
  revoked           BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS stakeholders_scope_idx ON stakeholders (level, unit_id) WHERE NOT revoked;

CREATE TABLE IF NOT EXISTS parties (
  id       BIGINT PRIMARY KEY,
  name     TEXT NOT NULL,
  acronym  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
  idx       INTEGER PRIMARY KEY,
  party_id  BIGINT NOT NULL,
  name      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lgas (
  id    BIGINT PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wards (
  id      BIGINT PRIMARY KEY,
  lga_id  BIGINT NOT NULL,
  name    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS polling_units (
  id                 BIGINT PRIMARY KEY,
  ward_id            BIGINT NOT NULL,
  code               TEXT NOT NULL,
  name               TEXT NOT NULL,
  registered_voters  BIGINT NOT NULL DEFAULT 0,
  cancelled          BOOLEAN NOT NULL DEFAULT false,
  cancellation_cid   TEXT
);

-- current status of every result unit (level 0 = PU, 1 = ward, 2 = LGA, 3 = state)
CREATE TABLE IF NOT EXISTS unit_status (
  level          SMALLINT NOT NULL,
  unit_id        BIGINT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'Open',
  round          INTEGER NOT NULL DEFAULT 0,
  figures_hash   TEXT,
  updated_block  BIGINT,
  updated_at     TIMESTAMPTZ,
  PRIMARY KEY (level, unit_id)
);

-- every set of figures ever put on-chain (one row per round)
CREATE TABLE IF NOT EXISTS results (
  level         SMALLINT NOT NULL,
  unit_id       BIGINT NOT NULL,
  round         INTEGER NOT NULL,
  figures_hash  TEXT NOT NULL,
  form_cid      TEXT,
  officer       TEXT,
  block_number  BIGINT,
  block_time    TIMESTAMPTZ,
  tx_hash       TEXT,
  PRIMARY KEY (level, unit_id, round)
);

CREATE TABLE IF NOT EXISTS signatures (
  level             SMALLINT NOT NULL,
  unit_id           BIGINT NOT NULL,
  round             INTEGER NOT NULL,
  agent             TEXT NOT NULL,
  party_id          BIGINT,
  objection         BOOLEAN NOT NULL DEFAULT false,
  objection_reason  TEXT,
  waived            BOOLEAN NOT NULL DEFAULT false,
  figures_hash      TEXT,
  block_number      BIGINT,
  block_time        TIMESTAMPTZ,
  tx_hash           TEXT,
  PRIMARY KEY (level, unit_id, round, agent)
);

CREATE TABLE IF NOT EXISTS disputes (
  id               BIGINT PRIMARY KEY,
  level            SMALLINT NOT NULL,
  unit_id          BIGINT NOT NULL,
  round            INTEGER NOT NULL,
  agent            TEXT NOT NULL,
  party_id         BIGINT,
  reason           TEXT,
  evidence_cid     TEXT,
  status           TEXT NOT NULL DEFAULT 'Raised',
  raised_at        TIMESTAMPTZ,
  resolution_kind  TEXT,
  resolved_by      TEXT,
  resolution_cid   TEXT,
  resolved_at      TIMESTAMPTZ,
  accepted_at      TIMESTAMPTZ,
  escalated_at     TIMESTAMPTZ,
  ruling_upheld    BOOLEAN,
  ruling_cid       TEXT,
  ruled_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS disputes_unit_idx ON disputes (level, unit_id);

CREATE TABLE IF NOT EXISTS mismatch_alerts (
  id               BIGSERIAL PRIMARY KEY,
  level            SMALLINT NOT NULL,
  unit_id          BIGINT NOT NULL,
  officer          TEXT NOT NULL,
  field            TEXT NOT NULL,
  candidate_index  INTEGER,
  declared         NUMERIC NOT NULL,
  computed         NUMERIC NOT NULL,
  attempt          INTEGER NOT NULL,
  block_number     BIGINT,
  block_time       TIMESTAMPTZ,
  tx_hash          TEXT,
  UNIQUE (tx_hash, level, unit_id, attempt)
);

CREATE TABLE IF NOT EXISTS audit_record (
  id                 INTEGER PRIMARY KEY DEFAULT 1,
  auditor            TEXT,
  state_result_hash  TEXT,
  report_cid         TEXT,
  approved_at        TIMESTAMPTZ,
  tx_hash            TEXT
);

CREATE TABLE IF NOT EXISTS declaration (
  id                      INTEGER PRIMARY KEY DEFAULT 1,
  publisher               TEXT,
  state_result_hash       TEXT,
  winner_candidate_index  INTEGER,
  winner_party_id         BIGINT,
  winner_votes            NUMERIC,
  tie                     BOOLEAN,
  declared_at             TIMESTAMPTZ,
  tx_hash                 TEXT
);

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  recipient   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  level       SMALLINT,
  unit_id     BIGINT,
  message     TEXT NOT NULL,
  payload     JSONB,
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read        BOOLEAN NOT NULL DEFAULT false,
  UNIQUE (recipient, kind, tx_hash, level, unit_id)
);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications (recipient, read, created_at DESC);

CREATE TABLE IF NOT EXISTS auth_nonces (
  address     TEXT PRIMARY KEY,
  nonce       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       TEXT PRIMARY KEY,
  address     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS ipfs_objects (
  cid        TEXT PRIMARY KEY,
  filename   TEXT,
  mime       TEXT,
  size       BIGINT,
  provider   TEXT,
  uploader   TEXT,
  purpose    TEXT,
  stored_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS credentials (
  id          BIGSERIAL PRIMARY KEY,
  did         TEXT NOT NULL,
  address     TEXT NOT NULL,
  category    TEXT NOT NULL,
  level       SMALLINT,
  unit_id     BIGINT,
  party_id    BIGINT,
  issuer      TEXT NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL,
  expires_at  TIMESTAMPTZ,
  signature   TEXT NOT NULL,
  payload     JSONB NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS credentials_address_idx ON credentials (address) WHERE NOT revoked;
