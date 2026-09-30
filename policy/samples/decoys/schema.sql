CREATE TABLE stats (
  id INTEGER PRIMARY KEY,
  contact_count INTEGER NOT NULL DEFAULT 0,
  ticket_no TEXT NOT NULL,
  updated_at TEXT
);
