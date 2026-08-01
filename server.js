require("dotenv").config({ quiet: true });

const express = require("express");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PANEL_PORT || process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "";
const startedAt = Date.now();

app.use(express.urlencoded({ extended: true }));

function passwordOk(input) {
  if (!PANEL_PASSWORD) return false;
  const a = Buffer.from(String(input ?? ""));
  const b = Buffer.from(PANEL_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

function page(message = "") {
  const warn = PANEL_PASSWORD ? "" : "⚠️ PANEL_PASSWORD non défini → redémarrage désactivé.";
  return `<!doctype html>
<html lang="fr"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="theme-color" content="#070710" />
<title>XBZ · Panel</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         padding:24px; font-family: system-ui, -apple-system, sans-serif; color:#fff;
         background: linear-gradient(135deg,#070710 0%,#0b1b2e 55%,#06121f 100%); }
  .card { width:min(92vw,420px); background:rgba(255,255,255,.04);
          border:1px solid rgba(0,102,255,.25); border-radius:18px; padding:28px;
          box-shadow:0 20px 60px rgba(0,0,0,.4); }
  h1 { margin:0 0 6px; font-size:22px; font-weight:900; letter-spacing:.12em; }
  .status { color:#22e0a3; font-weight:700; font-size:14px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:20px 0; font-size:13px; }
  dt { color:#6f8296; }
  dd { margin:0; color:#c9d6e3; }
  form { margin-top:6px; }
  input, button { width:100%; padding:11px 14px; border-radius:10px; border:0; font-size:14px; }
  input { background:#0d0d13; color:#fff; margin-bottom:10px; outline:none; }
  button { background:linear-gradient(90deg,#00bfff,#0066ff); color:#04141f; font-weight:800;
           cursor:pointer; transition:filter .15s; }
  button:hover { filter:brightness(1.1); }
  .msg { margin-top:12px; font-size:13px; color:#ffd27f; min-height:16px; }
</style></head>
<body><main class="card">
  <h1>XBZ · PANEL</h1>
  <p class="status">● En ligne</p>
  <dl>
    <dt>Uptime</dt><dd>${formatUptime(Date.now() - startedAt)}</dd>
    <dt>Node</dt><dd>${escapeHtml(process.version)}</dd>
    <dt>Heure (UTC)</dt><dd>${new Date().toISOString()}</dd>
  </dl>
  <form method="POST" action="/restart">
    <input name="password" type="password" placeholder="Mot de passe" autocomplete="off"
           ${PANEL_PASSWORD ? "" : "disabled"} />
    <button type="submit" ${PANEL_PASSWORD ? "" : "disabled"}>🔄 Redémarrer</button>
  </form>
  <p class="msg">${escapeHtml(message || warn)}</p>
</main></body></html>`;
}

app.get("/", (_req, res) => res.send(page()));

app.get("/health", (_req, res) =>
  res.json({
    ok: true,
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    node: process.version,
  }),
);

app.post("/restart", (req, res) => {
  if (!passwordOk(req.body && req.body.password)) {
    return res.status(401).send(page("❌ Mot de passe incorrect (ou panel non configuré)."));
  }
  res.send(page("🔄 Redémarrage en cours…"));
  console.log("🔄 Redémarrage demandé via le panel");
  setTimeout(() => process.exit(1), 300);
});

app.listen(PORT, () => console.log("🌐 Panel XBZ actif sur le port", PORT));
