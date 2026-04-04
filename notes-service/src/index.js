const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const { BlobServiceClient } = require("@azure/storage-blob");

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3002;
const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://localhost:3001";
const BLOB_CONTAINER = process.env.BLOB_CONTAINER || "notes";

// ── Blob client (Azurite locally, real Azure Blob on AKS) ─────────────────────
// Uses connection string — same code works for both Azurite and real Azure Blob.
// Locally: BLOB_CONNECTION_STRING points to Azurite
// On AKS:  BLOB_CONNECTION_STRING points to real Azure Storage account
const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.BLOB_CONNECTION_STRING
);

// ── PostgreSQL connection pools ────────────────────────────────────────────────
// adminPool connects to default "postgres" DB to create notesdb if missing.
const adminPool = new Pool({
  host:     process.env.PG_HOST     || "localhost",
  port:     process.env.PG_PORT     || 5432,
  database: "postgres",
  user:     process.env.PG_USER     || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
});

// pool connects to notesdb for all app queries.
const pool = new Pool({
  host:     process.env.PG_HOST     || "localhost",
  port:     process.env.PG_PORT     || 5432,
  database: process.env.PG_DB       || "notesdb",
  user:     process.env.PG_USER     || "postgres",
  password: process.env.PG_PASSWORD || "postgres",
});

// ── Create database + table if they don't exist ───────────────────────────────
async function initDB() {
  const dbName = process.env.PG_DB || "notesdb";

  const exists = await adminPool.query(
    "SELECT 1 FROM pg_database WHERE datname = $1", [dbName]
  );
  if (exists.rows.length === 0) {
    await adminPool.query("CREATE DATABASE " + dbName);
    console.log("[notes-service] created database: " + dbName);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notes (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL,
      title      TEXT NOT NULL,
      blob_key   TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log("[notes-service] database ready");
}

// ── Ensure blob container exists ──────────────────────────────────────────────
async function initBlob() {
  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);
  await containerClient.createIfNotExists();
  console.log("[notes-service] blob container ready");
}

// ── Auth middleware ────────────────────────────────────────────────────────────
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "missing or malformed Authorization header" });
  }

  const token = authHeader.split(" ")[1];
  try {
    const { data } = await axios.post(AUTH_SERVICE_URL + "/verify", { token });
    if (!data.valid) return res.status(401).json({ error: "invalid token" });
    req.username = data.username;
    next();
  } catch {
    res.status(503).json({ error: "auth service unavailable" });
  }
}

// ── Helper: upload content to blob storage ────────────────────────────────────
async function uploadBlob(blobKey, content) {
  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);
  const blockBlobClient = containerClient.getBlockBlobClient(blobKey);
  await blockBlobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: "text/plain" },
  });
}

// ── Helper: download content from blob storage ────────────────────────────────
async function downloadBlob(blobKey) {
  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);
  const blockBlobClient = containerClient.getBlockBlobClient(blobKey);
  const response = await blockBlobClient.download(0);
  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// ── Helper: delete blob ───────────────────────────────────────────────────────
async function deleteBlob(blobKey) {
  const containerClient = blobServiceClient.getContainerClient(BLOB_CONTAINER);
  const blockBlobClient = containerClient.getBlockBlobClient(blobKey);
  await blockBlobClient.deleteIfExists();
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "notes-service", db: "connected" });
  } catch {
    res.status(503).json({ status: "error", db: "disconnected" });
  }
});

// ── Get all notes ─────────────────────────────────────────────────────────────
app.get("/notes", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, title, blob_key, created_at, updated_at FROM notes WHERE username = $1 ORDER BY created_at DESC",
      [req.username]
    );

    const notes = await Promise.all(
      result.rows.map(async (row) => {
        const content = await downloadBlob(row.blob_key);
        return {
          id:        row.id,
          title:     row.title,
          content,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          username:  req.username,
        };
      })
    );

    res.json(notes);
  } catch (err) {
    console.error("[GET /notes] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Create a note ─────────────────────────────────────────────────────────────
app.post("/notes", authenticate, async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: "title and content are required" });
  }

  const id      = uuidv4();
  const blobKey = req.username + "/" + id + ".txt";

  try {
    await uploadBlob(blobKey, content);

    await pool.query(
      "INSERT INTO notes (id, username, title, blob_key) VALUES ($1, $2, $3, $4)",
      [id, req.username, title, blobKey]
    );

    res.status(201).json({
      id,
      title,
      content,
      username:  req.username,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[POST /notes] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Update a note ─────────────────────────────────────────────────────────────
app.put("/notes/:id", authenticate, async (req, res) => {
  const { title, content } = req.body;

  try {
    const result = await pool.query(
      "SELECT blob_key FROM notes WHERE id = $1 AND username = $2",
      [req.params.id, req.username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "note not found" });
    }

    const { blob_key } = result.rows[0];

    if (content) await uploadBlob(blob_key, content);

    await pool.query(
      "UPDATE notes SET title = COALESCE($1, title), updated_at = NOW() WHERE id = $2 AND username = $3",
      [title || null, req.params.id, req.username]
    );

    res.json({ id: req.params.id, title, content, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("[PUT /notes] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Delete a note ─────────────────────────────────────────────────────────────
app.delete("/notes/:id", authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT blob_key FROM notes WHERE id = $1 AND username = $2",
      [req.params.id, req.username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "note not found" });
    }

    await deleteBlob(result.rows[0].blob_key);
    await pool.query("DELETE FROM notes WHERE id = $1", [req.params.id]);

    res.json({ deleted: true });
  } catch (err) {
    console.error("[DELETE /notes] error:", err.message);
    res.status(500).json({ error: "internal server error" });
  }
});

// ── Start with retry ──────────────────────────────────────────────────────────
async function start() {
  let retries = 10;
  while (retries > 0) {
    try {
      await initDB();
      await initBlob();
      break;
    } catch (err) {
      retries--;
      console.log("[notes-service] waiting for DB/Blob... (" + retries + " retries left): " + err.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => {
    console.log("[notes-service] listening on port " + PORT);
  });
}

start();