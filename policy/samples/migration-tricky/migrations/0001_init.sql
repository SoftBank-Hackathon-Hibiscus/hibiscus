CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT
);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  body TEXT
);
