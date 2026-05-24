const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const { Pool } = require("pg");
const passport = require("passport");
const GitHubStrategy = require("passport-github2").Strategy;
const session = require("express-session");

const app = express();
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:8080", credentials: true }));

const JWT_SECRET    = process.env.JWT_SECRET      || "dev-secret-change-in-prod";
const PORT          = process.env.PORT             || 3001;
const FRONTEND_URL  = process.env.FRONTEND_URL     || "http://localhost:8080";
const GITHUB_ID     = process.env.GITHUB_CLIENT_ID    || "";
const GITHUB_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const BASE_URL      = process.env.BASE_URL         || "http://localhost:3001";

// ── Session (needed only for OAuth redirect flow, not for JWT auth) ───────────
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 5 * 60 * 1000 } // 5 min — just enough for OAuth flow
}));

app.use(passport.initialize());
app.use(passport.session());

// ── PostgreSQL ────────────────────────────────────────────────────────────────
const adminPool = new Pool({
  host: process.env.PG_HOST || "localhost", port: process.env.PG_PORT || 5432,
  database: "postgres", user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "postgres",
});

const pool = new Pool({
  host: process.env.PG_HOST || "localhost", port: process.env.PG_PORT || 5432,
  database: process.env.PG_DB || "authdb", user: process.env.PG_USER || "postgres", password: process.env.PG_PASSWORD || "postgres",
});

// ── Create users table ────────────────────────────────────────────────────────
// provider: 'local' for username/password, 'github' for OAuth
// provider_id: the GitHub user ID
// hash: null for OAuth users
async function initDB() {
  const dbName = process.env.PG_DB || "authdb";
  const exists = await adminPool.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
  if (exists.rows.length === 0) {
    await adminPool.query("CREATE DATABASE " + dbName);
    console.log("[auth-service] created database: " + dbName);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username     TEXT PRIMARY KEY,
      hash         TEXT,
      provider     TEXT NOT NULL DEFAULT 'local',
      provider_id  TEXT,
      email        TEXT,
      display_name TEXT,
      avatar_url   TEXT,
      created_at   TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[auth-service] database ready");
}

// ── Helper: generate JWT ──────────────────────────────────────────────────────
function issueToken(username) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "24h" });
}

// ── Passport GitHub strategy ──────────────────────────────────────────────────
// Called after GitHub redirects back with user profile
passport.use(new GitHubStrategy({
  clientID:     GITHUB_ID,
  clientSecret: GITHUB_SECRET,
  callbackURL:  BASE_URL + "/auth/github/callback",
  scope:        ["user:email"],
},
async (accessToken, refreshToken, profile, done) => {
  try {
    const providerId = String(profile.id);
    const email      = (profile.emails && profile.emails[0]) ? profile.emails[0].value : null;
    const displayName = profile.displayName || profile.username;
    const avatarUrl  = profile.photos ? profile.photos[0].value : null;
    // Use github_ prefix to avoid clashes with local usernames
    const username   = "github_" + profile.username;

    // Check if user already exists by provider_id
    const existing = await pool.query(
      "SELECT username FROM users WHERE provider = 'github' AND provider_id = $1",
      [providerId]
    );

    if (existing.rows.length > 0) {
      // Existing GitHub user — update their profile info
      await pool.query(
        "UPDATE users SET email = $1, display_name = $2, avatar_url = $3 WHERE provider_id = $4",
        [email, displayName, avatarUrl, providerId]
      );
      return done(null, { username: existing.rows[0].username });
    }

    // New GitHub user — create account
    await pool.query(
      "INSERT INTO users (username, hash, provider, provider_id, email, display_name, avatar_url) VALUES ($1, NULL, 'github', $2, $3, $4, $5)",
      [username, providerId, email, displayName, avatarUrl]
    );

    return done(null, { username });
  } catch (err) {
    return done(err);
  }
}));

// Passport session serialization — store only username in session
passport.serializeUser((user, done) => done(null, user.username));
passport.deserializeUser(async (username, done) => {
  try {
    const result = await pool.query("SELECT username FROM users WHERE username = $1", [username]);
    done(null, result.rows[0] || null);
  } catch (err) { done(err); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "auth-service", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// ── GitHub OAuth routes ───────────────────────────────────────────────────────
// Step 1: redirect user to GitHub
app.get("/auth/github",
  passport.authenticate("github", { scope: ["user:email"] })
);

// Step 2: GitHub redirects back here after user authorizes
app.get("/auth/github/callback",
  passport.authenticate("github", { failureRedirect: FRONTEND_URL + "?error=github_auth_failed" }),
  (req, res) => {
    // Issue JWT and redirect to frontend with token in query param
    const token = issueToken(req.user.username);
    res.redirect(FRONTEND_URL + "?token=" + token + "&username=" + encodeURIComponent(req.user.username));
  }
);

// ── Register (local) ──────────────────────────────────────────────────────────
app.post("/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)   return res.status(400).json({ error: "username and password are required" });
  if (username.length < 3)      return res.status(400).json({ error: "username must be at least 3 characters" });
  if (password.length < 6)      return res.status(400).json({ error: "password must be at least 6 characters" });
  if (username.startsWith("github_")) return res.status(400).json({ error: "username cannot start with 'github_'" });

  try {
    const existing = await pool.query("SELECT username FROM users WHERE username = $1", [username]);
    if (existing.rows.length > 0) return res.status(409).json({ error: "username already taken" });

    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      "INSERT INTO users (username, hash, provider) VALUES ($1, $2, 'local')",
      [username, hash]
    );

    res.status(201).json({ token: issueToken(username), username });
  } catch (err) {
    console.error("[register] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Login (local) ─────────────────────────────────────────────────────────────
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "username and password are required" });

  try {
    const result = await pool.query(
      "SELECT username, hash, provider FROM users WHERE username = $1",
      [username]
    );
    if (result.rows.length === 0) return res.status(401).json({ error: "invalid credentials" });

    const user = result.rows[0];
    if (user.provider !== "local") {
      return res.status(400).json({ error: "this account uses " + user.provider + " sign in" });
    }

    const valid = await bcrypt.compare(password, user.hash);
    if (!valid) return res.status(401).json({ error: "invalid credentials" });

    res.json({ token: issueToken(username), username });
  } catch (err) {
    console.error("[login] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Verify token ──────────────────────────────────────────────────────────────
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

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  let retries = 10;
  while (retries > 0) {
    try {
      await initDB();
      break;
    } catch (err) {
      retries--;
      console.log("[auth-service] waiting for DB... (" + retries + " retries left): " + err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => {
    console.log("[auth-service] listening on port " + PORT);
    console.log("[auth-service] GitHub SSO: " + (GITHUB_ID ? "enabled" : "disabled — set GITHUB_CLIENT_ID"));
  });
}

start();