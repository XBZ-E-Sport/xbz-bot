// Charge les variables d'un fichier .env EN LOCAL. Sur Render, les variables
// viennent déjà de la plateforme → dotenv est alors sans effet (aucun risque).
require("dotenv").config({ quiet: true });

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
// 1 Mo : les champs libres du formulaire (expérience, motivation) ne sont pas
// bornés côté site — la limite express par défaut (100 ko) renverrait un 413.
app.use(express.json({ limit: "1mb" }));
// Formulaire du panel (/panel) → corps encodé en urlencoded.
app.use(express.urlencoded({ extended: true }));

const startedAt = Date.now();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  Events
} = require("discord.js");

// =====================
// CONFIG
// =====================
const STAFF_CHANNEL_ID = "1522304854310256680";
const ESPORT_CHANNEL_ID = "1527664119682044135";
const LOG_CHANNEL_ID = "1522335394522333275";
const STAFF_ROLE_ID = "1524308311820730398";
const RECRUIT_CATEGORY_ID = "1524308791410294794";
// Salon des messages support. À défaut → salon staff.
const SUPPORT_CHANNEL_ID = process.env.SUPPORT_CHANNEL_ID || STAFF_CHANNEL_ID;

// Couleur de l'embed selon la catégorie de candidature
const CATEGORY_COLORS = {
  "XBZ Esport": 0x0066ff, // bleu
  "XBZ Staff": 0xa05aff, // violet
};

// Tronque une valeur pour respecter la limite Discord (1024 car. par field)
const clamp = (s, max = 1024) => (s && s.length > max ? s.slice(0, max - 1) + "…" : s);

// Construit un field d'embed SÛR : jamais vide, jamais trop long.
// (Discord refuse TOUT l'embed si un seul field dépasse 1024 caractères ou est
// vide — les formulaires du site ne limitent pas la taille des textes libres.)
// (Discord refuse aussi l'embed entier au-delà de 6000 caractères : d'où un
// plafond serré sur les champs courts, large sur les deux textes libres.)
const field = (name, value, inline = false, max = inline ? 256 : 1024) => ({
  name,
  value: clamp(String(value ?? "").trim() || "N/A", max),
  inline,
});

// Séparateur invisible pour aligner les colonnes de l'embed.
const SPACER = { name: "​", value: "​", inline: true };

// URL du site (sans slash final) → lien « Back-office » sous les candidatures.
const SITE_URL = (process.env.SITE_URL || "").replace(/\/+$/, "");
const adminUrl = /^https?:\/\//.test(SITE_URL) ? `${SITE_URL}/admin` : null;

// =====================
// MONITORING (#12)
// Le bot envoie ses erreurs au MÊME webhook Discord que le site
// (DISCORD_ERROR_WEBHOOK_URL) : un seul salon pour toutes les alertes.
// Même format d'embed et même anti-flood (1 signature / 60 s) que le site.
// =====================
const ERROR_WEBHOOK = process.env.DISCORD_ERROR_WEBHOOK_URL || "";
const recentErrors = new Map();

async function reportError(message, { stack, path, extra } = {}) {
  console.error("❌", message, path ? `(${path})` : "");
  if (!ERROR_WEBHOOK) return;

  const signature = `${path ?? ""}:${message}`;
  const now = Date.now();
  if (now - (recentErrors.get(signature) ?? 0) < 60_000) return; // déjà signalé
  if (recentErrors.size > 300) recentErrors.clear(); // garde-fou mémoire
  recentErrors.set(signature, now);

  const fields = [{ name: "Source", value: "bot", inline: true }];
  if (path) fields.push({ name: "Chemin", value: clamp(path, 200), inline: true });
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v == null || v === "") continue;
    fields.push({ name: clamp(k, 40), value: clamp(String(v), 200), inline: true });
  }

  try {
    await fetch(ERROR_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "XBZ · Erreurs",
        embeds: [
          {
            title: clamp(`🚨 ${message}`, 240),
            description: stack ? "```\n" + clamp(String(stack), 1500) + "\n```" : undefined,
            color: 0xff4444,
            fields,
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error("[monitor] envoi Discord échoué :", e.message);
  }
}

// =====================
// SUPABASE (connexion BDD)
// Le bot lit/écrit la table `candidatures` (statut) via la clé service_role.
// Non configuré → `supabase` = null : le bot fonctionne mais ne synchronise
// pas la BDD (les boutons éditent seulement le message Discord).
// =====================
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : null;

if (!supabase) {
  console.warn("⚠️ Supabase non configuré (SUPABASE_URL / SUPABASE_SECRET_KEY) — synchro BDD désactivée.");
}

// Action bouton → valeur de `candidatures.statut` (aligné sur le back-office).
const STATUS_MAP = { accept: "accepte", refuse: "refuse", interview: "entretien" };

// Un vrai id de candidature est un UUID (les anciens messages utilisaient
// `XBZ-<timestamp>` → on ne tente pas d'update BDD dans ce cas).
const isUuid = (s) =>
  typeof s === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// =====================
// SÉCURITÉ : secret partagé
// Le site envoie l'en-tête `x-xbz-secret`. Si BOT_SHARED_SECRET est défini côté
// bot, on rejette toute requête qui ne correspond pas. Non défini → on laisse
// passer (compat), mais c'est FORTEMENT recommandé de le définir.
// =====================
function checkSecret(req, res, next) {
  const secret = process.env.BOT_SHARED_SECRET;
  if (secret && req.get("x-xbz-secret") !== secret) {
    console.warn("🚫 Requête rejetée (secret invalide)");
    return res.status(401).send("Unauthorized");
  }
  next();
}

// =====================
// DISCORD BOT
// =====================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds
  ]
});

// `Events.ClientReady` vaut "clientReady" depuis discord.js 14.26 : écrire
// "ready" en dur déclenche un DeprecationWarning et cassera en v15.
client.once(Events.ClientReady, () => {
  console.log("🟢 BOT CONNECTÉ :", client.user.tag);
  console.log(supabase ? "💾 Supabase connecté" : "💾 Supabase non configuré");
  if (adminUrl) console.log("📂 Back-office :", adminUrl);
});

// =====================
// API RECRUTEMENT
// =====================
app.post("/recrutement", checkSecret, async (req, res) => {
  try {

    console.log("🔥 REQUÊTE REÇUE :", req.body);

    const data = req.body;
    console.log("📂 CATÉGORIE :", data.categorie, "| 🎯 RÔLE :", data.role);
    console.log("🎮 JEU :", data.jeu);
    console.log("🔗 RL TRACKER :", data.rltracker);

    // ID de la candidature : on utilise le vrai id BDD (UUID) envoyé par le site.
    // Repli sur un id local si absent (anciens appels) → pas de synchro BDD.
    const id = isUuid(data.id) ? data.id : `XBZ-${Date.now()}`;

    // Candidature Esport uniquement si un jeu est renseigné
    const isEsport = Boolean(data.jeu && data.jeu.trim());

    // Routage : salon Esport dédié si configuré, sinon salon staff par défaut
    const targetChannelId =
      isEsport && ESPORT_CHANNEL_ID ? ESPORT_CHANNEL_ID : STAFF_CHANNEL_ID;

    const channel = await client.channels.fetch(targetChannelId).catch(() => null);
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

    if (!channel) {
      await reportError("Salon recrutement introuvable", {
        path: "/recrutement",
        extra: { salon: targetChannelId },
      });
      return res.status(500).json({ ok: false, error: "Channel not found" });
    }

    if (!logChannel) {
      console.log("❌ Salon LOG introuvable");
    } else {
      console.log("✅ Salon LOG trouvé");
    }
    // =========================
    // EMBED RECRUTEMENT (PROPRE)
    // =========================

    const fields = [
      field("📂 Catégorie", data.categorie, true),
      field("🎯 Rôle", data.role, true),
      SPACER,
      field("👤 Nom", data.nom, true),
      field("🎂 Âge", data.age, true),
      SPACER,
      field("💬 Discord", data.discord, true),
      field("🎮 Pseudo", data.pseudo, true),
      field("🌍 Pays de résidence", data.pays1, false, 256),
    ];

    // Champs spécifiques à l'Esport (jeu / roster souhaité / RL Tracker)
    if (isEsport) {
      fields.push(field("🕹 Jeu", data.jeu, true));
      // Le site envoie la clé `rang` (contrat historique) qui contient le
      // ROSTER souhaité. On accepte aussi `roster` si le contrat évolue.
      fields.push(field("🎯 Roster souhaité", data.roster ?? data.rang, true));

      if (data.jeu.trim() === "Rocket League") {
        const tracker = String(data.rltracker ?? "").trim();
        fields.push({
          name: "🔗 RL Tracker",
          value: tracker.startsWith("http")
            ? `[Voir le profil RL Tracker](${clamp(tracker, 900)})`
            : "Non renseigné",
          inline: false,
        });
      }
    }

    fields.push(field("📜 Expérience", data.exp));
    fields.push(field("🧠 Motivation", data.motiv));

    const embed = new EmbedBuilder()
      .setTitle("🦇 NOUVELLE CANDIDATURE XBZ")
      .setColor(CATEGORY_COLORS[data.categorie] ?? 0x0066ff)
      .setDescription(`🆔 ID : **${id}**`)
      .addFields(fields)
      .setFooter({ text: "XBZ Recrutement System" })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`accept_${id}`)
        .setLabel("✅ Accepter")
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId(`refuse_${id}`)
        .setLabel("❌ Refuser")
        .setStyle(ButtonStyle.Danger),

      new ButtonBuilder()
        .setCustomId(`interview_${id}`)
        .setLabel("🟡 Entretien")
        .setStyle(ButtonStyle.Secondary)
    );

    // Lien direct vers le back-office du site (si SITE_URL est défini).
    if (adminUrl) {
      row.addComponents(
        new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(adminUrl).setLabel("📂 Back-office")
      );
    }

    const posted = await channel.send({
      embeds: [embed],
      components: [row]
    });

    // Mémorise le message : c'est ce qui permettra au back-office de refléter
    // un changement de statut SUR CE message précis (voir POST /statut).
    if (supabase && isUuid(id)) {
      const { error: linkError } = await supabase
        .from("candidatures")
        .update({ discord_message_id: posted.id, discord_channel_id: posted.channelId })
        .eq("id", id);
      if (linkError) {
        console.warn("⚠️ Lien message Discord non enregistré :", linkError.message);
      }
    }
    // =====================
    // LOGS COMPLETS
    // =====================

    if (logChannel) {
      const esportLog = isEsport
        ? `\n🕹 Jeu : ${data.jeu}
🎯 Roster souhaité : ${data.roster ?? data.rang ?? "N/A"}
🔗 RL Tracker : ${
            data.rltracker && data.rltracker.startsWith("http")
              ? data.rltracker
              : "Non renseigné"
          }`
        : "";

      // Discord refuse un message > 2000 caractères → on tronque.
      // Isolé dans son propre try : un log raté ne doit PAS faire échouer
      // la requête du site alors que la candidature est déjà postée.
      const logContent =
`📩 **Nouvelle candidature reçue**

🆔 ID : ${id}

📂 Catégorie : ${data.categorie || "N/A"}
🎯 Rôle : ${data.role || "N/A"}

👤 Nom : ${data.nom || "N/A"}
🎂 Âge : ${data.age || "N/A"}
💬 Discord : ${data.discord || "N/A"}
🎮 Pseudo : ${data.pseudo || "N/A"}
🌍 Pays de résidence : ${data.pays1 || "N/A"}${esportLog}

📜 Expérience :
${data.exp || "N/A"}

🧠 Motivation :
${data.motiv || "N/A"}`;

      try {
        await logChannel.send({ content: clamp(logContent, 1900) });
        console.log("📜 LOG ENVOYÉ");
      } catch (e) {
        await reportError(`Log candidature non envoyé : ${e.message}`, { path: "/recrutement" });
      }
    }
    console.log("📨 CANDIDATURE ENVOYÉE SUR DISCORD");

    return res.status(200).json({ ok: true, id });

  } catch (err) {
    await reportError(`Candidature non postée : ${err.message}`, {
      stack: err.stack,
      path: "/recrutement",
    });
    return res.status(500).json({ ok: false, error: "ERROR" });
  }
});

// =====================
// API SUPPORT
// Reçoit les messages du formulaire de contact et les poste sur Discord.
// =====================
app.post("/support", checkSecret, async (req, res) => {
  try {
    console.log("✉️ SUPPORT REÇU :", req.body);
    const data = req.body;

    const channel = await client.channels.fetch(SUPPORT_CHANNEL_ID).catch(() => null);
    if (!channel) {
      await reportError("Salon support introuvable", {
        path: "/support",
        extra: { salon: SUPPORT_CHANNEL_ID },
      });
      return res.status(500).json({ ok: false, error: "Channel not found" });
    }

    const embed = new EmbedBuilder()
      .setTitle("✉️ NOUVEAU MESSAGE SUPPORT")
      .setColor(0x00bfff)
      .addFields(
        field("👤 Nom", data.nom, true),
        field("📧 Email", data.email, true),
        field("🏷 Sujet", data.sujet, true),
        field("💬 Message", data.message)
      )
      .setFooter({ text: "XBZ Support System" })
      .setTimestamp();

    // `id` optionnel : si le site l'envoie un jour, il s'affiche (rétro-compatible).
    if (data.id) embed.setDescription(`🆔 ID : **${clamp(String(data.id), 100)}**`);

    await channel.send({ embeds: [embed] });
    console.log("📨 MESSAGE SUPPORT ENVOYÉ SUR DISCORD");

    return res.status(200).json({ ok: true });
  } catch (err) {
    await reportError(`Message support non posté : ${err.message}`, {
      stack: err.stack,
      path: "/support",
    });
    return res.status(500).json({ ok: false, error: "ERROR" });
  }
});

// =====================
// API STATUT (back-office → Discord)
// Le site appelle cette route quand le staff change un statut depuis /admin :
// le message Discord d'origine est réécrit pour refléter la décision, au lieu
// de rester indéfiniment avec ses boutons « Accepter / Refuser ».
// =====================
const STATUT_VIEWS = {
  accepte: { emoji: "🟢", label: "ACCEPTÉE", final: true },
  refuse: { emoji: "🔴", label: "REFUSÉE", final: true },
  entretien: { emoji: "🟡", label: "EN ENTRETIEN", final: false },
  en_attente: { emoji: "⏳", label: "REMISE EN ATTENTE", final: false },
};

app.post("/statut", checkSecret, async (req, res) => {
  try {
    const { id, statut, by } = req.body ?? {};
    const view = STATUT_VIEWS[statut];

    if (!isUuid(id) || !view) {
      return res.status(400).json({ ok: false, error: "id ou statut invalide" });
    }
    if (!supabase) {
      return res.status(503).json({ ok: false, error: "Supabase non configuré" });
    }

    // Où se trouve le message d'origine ?
    const { data, error } = await supabase
      .from("candidatures")
      .select("discord_message_id, discord_channel_id")
      .eq("id", id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data?.discord_message_id) {
      // Candidature antérieure à cette fonctionnalité : rien à réécrire.
      console.log("ℹ️ Pas de message Discord lié à", id);
      return res.status(200).json({ ok: true, updated: false, reason: "no_message" });
    }

    const channel = await client.channels.fetch(data.discord_channel_id).catch(() => null);
    const message = channel ? await channel.messages.fetch(data.discord_message_id).catch(() => null) : null;

    if (!message) {
      console.warn("⚠️ Message Discord introuvable (supprimé ?) pour", id);
      return res.status(200).json({ ok: true, updated: false, reason: "message_gone" });
    }

    const who = String(by ?? "le back-office").slice(0, 100);
    await message.edit({
      content: `${view.emoji} CANDIDATURE **${id}** ${view.label} par ${who} · via le back-office`,
      components: candidatureButtons(id, { compact: view.final }),
    });

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) {
      await logChannel.send(`${view.emoji} **${id}** → ${view.label} (back-office, ${who})`).catch(() => {});
    }

    console.log(`🔄 Statut reflété sur Discord : ${id} → ${statut}`);
    return res.status(200).json({ ok: true, updated: true });
  } catch (err) {
    await reportError(`Statut non reflété sur Discord : ${err.message}`, {
      stack: err.stack,
      path: "/statut",
    });
    return res.status(500).json({ ok: false, error: "ERROR" });
  }
});

// =====================
// HOME ROUTE
// =====================
app.get("/", (req, res) => {
  res.send("XBZ BOT ONLINE ✔");
});

// =====================
// SANTÉ (JSON) — pour un monitoring externe (UptimeRobot, Better Stack…).
// Renvoie l'état réel de la connexion Discord, pas juste "le serveur répond".
// =====================
app.get("/health", (_req, res) => {
  const discordOk = client.isReady();
  res.status(discordOk ? 200 : 503).json({
    ok: discordOk,
    discord: discordOk ? client.user.tag : "déconnecté",
    supabase: Boolean(supabase),
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    node: process.version,
  });
});

// =====================
// PANEL DE SUPERVISION (/panel)
// Intégré ICI (et non dans un fichier à part) pour tourner dans le MÊME
// process que le bot : le bouton redémarre donc vraiment le bot.
// Sécurité : mot de passe via PANEL_PASSWORD. Absent → redémarrage désactivé.
// =====================
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "";

// Comparaison à temps constant (évite une attaque temporelle sur le mot de passe).
function passwordOk(input) {
  if (!PANEL_PASSWORD) return false;
  const a = Buffer.from(String(input ?? ""));
  const b = Buffer.from(PANEL_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]),
  );

function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`;
}

function panelPage(message = "") {
  const discordOk = client.isReady();
  const warnMsg = PANEL_PASSWORD ? "" : "⚠️ PANEL_PASSWORD non défini → redémarrage désactivé.";
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
  .status { font-weight:700; font-size:14px; }
  dl { display:grid; grid-template-columns:auto 1fr; gap:6px 14px; margin:20px 0; font-size:13px; }
  dt { color:#8ea1b5; }
  dd { margin:0; color:#c9d6e3; }
  input, button { width:100%; padding:11px 14px; border-radius:10px; border:0; font-size:14px; }
  input { background:#0d0d13; color:#fff; margin-bottom:10px; outline:none; }
  button { background:linear-gradient(90deg,#00bfff,#0066ff); color:#04141f; font-weight:800;
           cursor:pointer; transition:filter .15s; }
  button:hover { filter:brightness(1.1); }
  .msg { margin-top:12px; font-size:13px; color:#ffd27f; min-height:16px; }
</style></head>
<body><main class="card">
  <h1>XBZ · PANEL</h1>
  <p class="status" style="color:${discordOk ? "#22e0a3" : "#ff7a7a"}">
    ● ${discordOk ? "Bot en ligne" : "Bot déconnecté"}
  </p>
  <dl>
    <dt>Discord</dt><dd>${discordOk ? escapeHtml(client.user.tag) : "—"}</dd>
    <dt>Supabase</dt><dd>${supabase ? "connecté" : "non configuré"}</dd>
    <dt>Uptime</dt><dd>${formatUptime(Date.now() - startedAt)}</dd>
    <dt>Node</dt><dd>${escapeHtml(process.version)}</dd>
  </dl>
  <form method="POST" action="/panel/restart">
    <input name="password" type="password" placeholder="Mot de passe" autocomplete="off"
           ${PANEL_PASSWORD ? "" : "disabled"} />
    <button type="submit" ${PANEL_PASSWORD ? "" : "disabled"}>🔄 Redémarrer le bot</button>
  </form>
  <p class="msg">${escapeHtml(message || warnMsg)}</p>
</main></body></html>`;
}

app.get("/panel", (_req, res) => res.send(panelPage()));

// ⚠️ Le process s'arrête : c'est l'hébergeur (Render) qui le relance.
// En local, rien ne supervise le process → il faut relancer `node bot.js` à la main.
app.post("/panel/restart", (req, res) => {
  if (!passwordOk(req.body && req.body.password)) {
    return res.status(401).send(panelPage("❌ Mot de passe incorrect (ou panel non configuré)."));
  }
  res.send(panelPage("🔄 Redémarrage en cours…"));
  console.log("🔄 Redémarrage demandé via le panel");
  setTimeout(() => process.exit(1), 300); // laisse la réponse partir
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("🌐 SERVER ON PORT", PORT);
});

// =====================
// KEEP-ALIVE (Render free : empêche la mise en veille)
// Le bot se ping lui-même toutes les 10 min → Render voit du trafic et ne
// coupe pas le process, donc la connexion Discord reste active (boutons OK).
// RENDER_EXTERNAL_URL est fourni automatiquement par Render.
// =====================
const SELF_URL = process.env.RENDER_EXTERNAL_URL;
if (SELF_URL && typeof fetch === "function") {
  setInterval(() => {
    fetch(SELF_URL).catch(() => {});
  }, 10 * 60 * 1000);
  console.log("⏰ Keep-alive activé →", SELF_URL);
}

// =====================
// LOGIN DISCORD
// Un token absent/invalide provoquait un crash brut (unhandled rejection) :
// on affiche un message explicite avant de sortir.
// =====================
if (!process.env.TOKEN) {
  console.error("❌ TOKEN absent — crée un fichier .env (voir .env.example) ou ajoute la variable sur Render.");
  process.exit(1);
}

client.login(process.env.TOKEN).catch((err) => {
  console.error("❌ Connexion Discord impossible :", err.message);
  console.error("   → Vérifie TOKEN (portail Discord › Bot › Reset Token si besoin).");
  process.exit(1);
});

// Met à jour le statut d'une candidature en BDD (si Supabase configuré + vrai id).
// Renvoie : "ok" | "off" (pas de BDD ou id historique) | "missing" (ligne absente,
// ex. purgée par la rétention 24 mois) | "error".
async function updateCandidatureStatus(id, statut) {
  if (!supabase || !isUuid(id)) return "off";

  const { data, error } = await supabase
    .from("candidatures")
    .update({ statut })
    .eq("id", id)
    .select("id");

  if (error) {
    await reportError(`MAJ statut BDD échouée : ${error.message}`, {
      path: "interaction/bouton",
      extra: { id, statut },
    });
    return "error";
  }
  // 0 ligne touchée : la candidature n'existe plus (purge RGPD à 24 mois,
  // suppression manuelle…) → on le dit au staff plutôt que de mentir.
  if (!data || data.length === 0) {
    console.warn(`⚠️ Candidature introuvable en BDD : ${id}`);
    return "missing";
  }

  console.log(`💾 Statut BDD mis à jour : ${id} → ${statut}`);
  return "ok";
}

// Codes Discord signifiant « cette interaction est déjà traitée ou expirée » :
// 40060 (already acknowledged), 10062 (unknown interaction), 40062 (in progress).
// Ce n'est pas une panne : soit un second processus du bot tourne en parallèle,
// soit la couche REST a rejoué une requête déjà passée. On log sans alerter.
const ALREADY_HANDLED = new Set([40060, 10062, 40062]);
const isAlreadyHandled = (err) => ALREADY_HANDLED.has(err?.code);

/** Rangée de boutons d'une candidature (`compact` = décision prise). */
function candidatureButtons(id, { compact = false } = {}) {
  const row = new ActionRowBuilder();
  if (!compact) {
    row.addComponents(
      new ButtonBuilder().setCustomId(`accept_${id}`).setLabel("✅ Accepter").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`refuse_${id}`).setLabel("❌ Refuser").setStyle(ButtonStyle.Danger),
    );
  }
  if (adminUrl) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(adminUrl).setLabel("📂 Back-office"),
    );
  }
  return row.components.length ? [row] : [];
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, id] = interaction.customId.split("_");
  const statut = STATUS_MAP[action];
  if (!statut) return; // bouton inconnu (ou lien) → rien à faire

  // ÉTAPE 1 — accuser réception IMMÉDIATEMENT.
  // Discord n'accorde que 3 secondes : la requête Supabase qui suit pouvait
  // dépasser ce délai (Render endormi, base lente) et faire échouer le bouton.
  try {
    await interaction.deferUpdate();
  } catch (err) {
    if (isAlreadyHandled(err)) {
      console.warn(`↩️ Interaction déjà traitée (${err.code}) — ignorée : ${action} ${id}`);
      return;
    }
    await reportError(`Accusé de réception impossible : ${err.message}`, {
      stack: err.stack,
      path: "interaction/bouton",
      extra: { action, id, code: err.code },
    });
    return;
  }

  // ÉTAPE 2 — travail lent, sans contrainte de temps désormais.
  try {
    const sync = await updateCandidatureStatus(id, statut);
    const DB_NOTES = {
      ok: " · BDD ✅",
      missing: " · BDD ⚠️ candidature introuvable (purgée ?)",
      error: " · BDD ⚠️ erreur de synchro",
      off: "",
    };
    const dbNote = DB_NOTES[sync];
    const who = interaction.user.tag;

    const VIEWS = {
      accept: {
        content: `🟢 CANDIDATURE **${id}** ACCEPTÉE par ${who}${dbNote}`,
        components: candidatureButtons(id, { compact: true }),
        log: `✔ Candidature **${id}** ACCEPTÉE par ${who}${dbNote}`,
      },
      refuse: {
        content: `🔴 CANDIDATURE **${id}** REFUSÉE par ${who}${dbNote}`,
        components: candidatureButtons(id, { compact: true }),
        log: `❌ Candidature **${id}** REFUSÉE par ${who}${dbNote}`,
      },
      interview: {
        content:
          `🟡 CANDIDATURE **${id}** EN ENTREVUE${dbNote}\n\n` +
          `👤 Demandé par ${who}\n` +
          `⏳ Statut : EN ATTENTE D'ENTRETIEN`,
        // L'entretien n'est pas une décision finale : on garde Accepter/Refuser.
        components: candidatureButtons(id),
        log: `🟡 Entretien demandé pour **${id}** par ${who}${dbNote}`,
      },
    };

    const view = VIEWS[action];
    await interaction.editReply({ content: view.content, components: view.components });

    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (logChannel) await logChannel.send(view.log).catch(() => {});
  } catch (err) {
    if (isAlreadyHandled(err)) {
      console.warn(`↩️ Interaction déjà traitée (${err.code}) — ignorée : ${action} ${id}`);
      return;
    }
    await reportError(`Erreur bouton : ${err.message}`, {
      stack: err.stack,
      path: "interaction/bouton",
      extra: { action, id, code: err.code },
    });
  }
});

// =====================
// FILET DE SÉCURITÉ
// Toute erreur non rattrapée part vers le salon d'alertes (comme le site),
// au lieu de tuer le process en silence.
// =====================
client.on("error", (err) =>
  reportError(`Erreur client Discord : ${err.message}`, { stack: err.stack, path: "discord" }),
);

client.on("shardDisconnect", (event, shardId) =>
  console.warn(`🔌 Déconnecté de Discord (shard ${shardId}, code ${event?.code}) — reconnexion…`),
);

process.on("unhandledRejection", (reason) =>
  reportError(`Rejet de promesse non géré : ${reason?.message ?? reason}`, {
    stack: reason?.stack,
    path: "process",
  }),
);

process.on("uncaughtException", async (err) => {
  await reportError(`Exception non gérée : ${err.message}`, { stack: err.stack, path: "process" });
  process.exit(1); // Render relance le service
});
