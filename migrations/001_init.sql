-- 初始化建表
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE,
  passwordHash TEXT,
  apiKey TEXT,
  token TEXT,
  level INTEGER DEFAULT 1,
  sessionVersion INTEGER DEFAULT 1,
  createdAt INTEGER
);

CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  userId TEXT,
  filename TEXT,
  mime TEXT,
  size INTEGER,
  width INTEGER,
  height INTEGER,
  createdAt INTEGER,
  autoDelete INTEGER DEFAULT 0,
  deleteAfterDays INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
