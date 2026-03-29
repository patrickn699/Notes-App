const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-in-prod";
const PORT = process.env.PORT || 3001;

// ── PostgreSQL connection pool ─────────────────────────────────────────────────
// Pool manages multiple connections — reuses them instead of opening a new one
// per request. All config comes from env vars injected by K8s Secret/ConfigMap.
const pool = new Pool({
  host:     process.env.PG_HOST     || "localhost",
  port:     process.env.PG_PORT     || 5432,
  database: process.env.PG_DB       || "authdb",
  user:     process.env.PG_USER     || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
});

// ── Create users table if it doesn't exist ────────────────────────────────────
// This runs once on startup. In production you'd use a migration tool like
// Flyway or Liquibase, but for learning this is fine.
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username   TEXT PRIMARY KEY,
      hash       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[auth-service] database ready");
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "auth-service", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// ── Register ──────────────────────────────────────────────────────────────────
app.post("/register", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password)      return res.status(400).json({ error: "username and password are required" });
  if (username.length < 3)         return res.status(400).json({ error: "username must be at least 3 characters" });
  if (password.length < 6)         return res.status(400).json({ error: "password must be at least 6 characters" });

  try {
    const existing = await pool.query(
      "SELECT username FROM users WHERE username = $1",
      [username]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: "username already taken" });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, hash) VALUES ($1, $2)",
      [username, hash]
    );

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
    res.status(201).json({ token, username });
  } catch (err) {
    console.error("[register] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Login ─────────────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  try {
    const result = await pool.query(
      "SELECT username, hash FROM users WHERE username = $1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.hash);
    if (!valid) {
      return res.status(401).json({ error: "invalid credentials" });
    }

    const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
    res.json({ token, username });
  } catch (err) {
    console.error("[login] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Verify token (called by notes-service) ────────────────────────────────────
app.post("/verify", (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token required" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, username: decoded.username });
  } catch {
    res.status(401).json({ valid: false, error: "invalid or expired token" });
  }
});

// ── Start with DB retry ───────────────────────────────────────────────────────
async function start() {
  let retries = 10;
  while (retries > 0) {
    try {
      await initDB();
      break;
    } catch (err) {
      retries--;
      console.log("[auth-service] waiting for DB... (" + retries + " retries left)");
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => {
    console.log("[auth-service] listening on port " + PORT);
  });
}

start();
