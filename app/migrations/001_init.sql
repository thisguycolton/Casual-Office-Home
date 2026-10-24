-- Users, sessions and the file/folder model. File CONTENT is never stored here, only a storage key.
CREATE TABLE users (
  id            TEXT PRIMARY KEY,                 -- uuid
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,                    -- argon2id
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash     TEXT PRIMARY KEY,                   -- sha256 of the cookie token; the token itself is never stored
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  user_agent  TEXT,
  ip          TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);

-- One-time password reset tokens, created by an administrator (no email service is assumed).
CREATE TABLE password_resets (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE files (
  id              TEXT PRIMARY KEY,               -- uuid, stable identity
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES files(id) ON DELETE CASCADE,   -- NULL = top level
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('folder','document','spreadsheet','presentation','pdf','image','text','other')),
  mime            TEXT NOT NULL,
  storage_key     TEXT,                           -- NULL for folders
  size            INTEGER NOT NULL DEFAULT 0,
  sha256          TEXT,
  version         INTEGER NOT NULL DEFAULT 1,     -- bumped on every content write; used as If-Match
  starred         INTEGER NOT NULL DEFAULT 0,
  trashed_at      INTEGER,                        -- set on the item AND all its descendants
  trashed_root    INTEGER NOT NULL DEFAULT 0,     -- 1 for the item the user actually deleted
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  last_opened_at  INTEGER,
  CHECK ((kind = 'folder') = (storage_key IS NULL))
);
CREATE INDEX files_owner_parent ON files(owner_id, parent_id);
CREATE INDEX files_owner_trash  ON files(owner_id, trashed_at);
CREATE INDEX files_owner_opened ON files(owner_id, last_opened_at);
-- Names are unique per folder among live (non-trashed) items.
CREATE UNIQUE INDEX files_unique_live_name
  ON files(owner_id, COALESCE(parent_id, ''), name COLLATE NOCASE) WHERE trashed_at IS NULL;

-- Previous contents kept so a bad editor save is recoverable.
CREATE TABLE file_versions (
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  size        INTEGER NOT NULL,
  sha256      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (file_id, version)
);

CREATE TABLE audit_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  user_id TEXT,
  action  TEXT NOT NULL,
  target  TEXT,
  ip      TEXT
);
