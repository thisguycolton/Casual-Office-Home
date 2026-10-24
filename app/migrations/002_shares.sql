-- Per-file sharing with specific registered users. Files only (folders are not shareable); private by default.
CREATE TABLE file_shares (
  file_id    TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('viewer','editor')),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (file_id, user_id)
);
CREATE INDEX file_shares_user ON file_shares(user_id);
