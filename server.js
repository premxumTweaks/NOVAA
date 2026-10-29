const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const inboxFile = path.join(dataDir, "contact.log");

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

/* ---------------- contact inbox ---------------- */

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip);

  if (!entry || now > entry.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return false;
  }

  entry.count += 1;
  return entry.count > MAX_PER_WINDOW;
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of hits) {
    if (now > entry.resetAt) hits.delete(ip);
  }
}, WINDOW_MS).unref();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_RE, "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

app.post("/api/contact", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";

  if (rateLimited(ip)) {
    return res.status(429).json({ ok: false, error: "Too many messages from this address. Try again later or email hello@nova.studio." });
  }

  const body = req.body || {};

  // Honeypot: real users never see this field.
  if (clean(body.website, 200) !== "") {
    return res.status(400).json({ ok: false, error: "The brief could not be validated." });
  }

  const entry = {
    name: clean(body.name, 80),
    email: clean(body.email, 160),
    company: clean(body.company, 120),
    budget: clean(body.budget, 40),
    scope: Array.isArray(body.scope)
      ? body.scope.slice(0, 8).map((item) => clean(item, 40)).filter(Boolean)
      : [],
    message: clean(body.message, 4000)
  };

  if (entry.name.length < 2) {
    return res.status(422).json({ ok: false, error: "A name is required." });
  }
  if (!EMAIL_RE.test(entry.email)) {
    return res.status(422).json({ ok: false, error: "That email does not look valid." });
  }
  if (entry.message.length < 20) {
    return res.status(422).json({ ok: false, error: "Give us at least a couple of sentences about the project." });
  }

  const line = JSON.stringify({
    at: new Date().toISOString(),
    ip,
    ...entry
  }) + "\n";

  try {
    await fs.promises.appendFile(inboxFile, line, "utf8");
  } catch (err) {
    console.error("contact inbox write failed:", err);
    return res.status(500).json({ ok: false, error: "Could not store the brief. Email hello@nova.studio instead." });
  }

  console.log("contact: new brief from " + entry.email + " (" + entry.name + ")");
  return res.status(201).json({ ok: true });
});

/* ---------------- pages ---------------- */

app.use(express.static(publicDir, {
  index: "index.html",
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

const pages = {
  "/": "index.html",
  "/work": "work.html",
  "/studio": "studio.html",
  "/contact": "contact.html"
};

for (const [route, file] of Object.entries(pages)) {
  app.get(route, (_req, res) => {
    res.sendFile(path.join(publicDir, file));
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

/* ---------------- fallbacks ---------------- */

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ ok: false, error: "Unknown endpoint." });
  }
  res.status(404).sendFile(path.join(publicDir, "404.html"));
});

app.use((err, req, res, _next) => {
  console.error("unhandled error:", err);
  if (req.path.startsWith("/api/")) {
    return res.status(500).json({ ok: false, error: "Server error." });
  }
  res.status(500).type("text/plain").send("Server error.");
});

/* ---------------- boot ---------------- */

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`NOVAA is available on http://localhost:${PORT}`);
  console.log("Pages: /, /work, /studio, /contact");
});

function shutdown(signal) {
  console.log(`\n${signal} received, closing server.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
