// Charge les variables d'un fichier .env EN LOCAL. Sur Render, les variables
// viennent déjà de la plateforme → dotenv est alors sans effet (aucun risque).
require("dotenv").config({ quiet: true });

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const app = express();

app.use(cors());
app.use(express.json());
// Formulaire du panel (/panel) → corps encodé en urlencoded.
app.use(express.urlencoded({ extended: true }));

const startedAt = Date.now();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
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

client.once("ready", () => {
  console.log("🟢 BOT CONNECTÉ :", client.user.tag);
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
      console.log("❌ Salon recrutement introuvable");
      return res.status(500).send("Channel not found");
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
      { name: "📂 Catégorie", value: data.categorie || "N/A", inline: true },
      { name: "🎯 Rôle", value: data.role || "N/A", inline: true },
      { name: "​", value: "​", inline: true },
      { name: "👤 Nom", value: data.nom || "N/A", inline: true },
      { name: "🎂 Âge", value: data.age || "N/A", inline: true },
      { name: "​", value: "​", inline: true },
      { name: "💬 Discord", value: data.discord || "N/A", inline: true },
      { name: "🎮 Pseudo", value: data.pseudo || "N/A", inline: true },
      {
        name: "🌍 Pays de résidence",
        value: data.pays1 || "N/A",
        inline: false,
      },
    ];

    // Champs spécifiques à l'Esport (jeu / roster souhaité / RL Tracker)
    if (isEsport) {
      fields.push({ name: "🕹 Jeu", value: data.jeu, inline: true });
      // `data.rang` : conservé pour compat, contient le ROSTER souhaité.
      fields.push({ name: "🎯 Roster souhaité", value: data.rang || "N/A", inline: true });

      if (data.jeu.trim() === "Rocket League") {
        fields.push({
          name: "🔗 RL Tracker",
          value:
            data.rltracker && data.rltracker.startsWith("http")
              ? `[Voir le profil RL Tracker](${data.rltracker})`
              : "Non renseigné",
          inline: false,
        });
      }
    }

    fields.push({ name: "📜 Expérience", value: clamp(data.exp) || "N/A" });
    fields.push({ name: "🧠 Motivation", value: clamp(data.motiv) || "N/A" });

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

    await channel.send({
      embeds: [embed],
      components: [row]
    });
    // =====================
    // LOGS COMPLETS
    // =====================

    if (logChannel) {
      const esportLog = isEsport
        ? `\n🕹 Jeu : ${data.jeu}
🎯 Roster souhaité : ${data.rang || "N/A"}
🔗 RL Tracker : ${
            data.rltracker && data.rltracker.startsWith("http")
              ? data.rltracker
              : "Non renseigné"
          }`
        : "";

      await logChannel.send({
        content:
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
${data.motiv || "N/A"}`
      });

      console.log("📜 LOG ENVOYÉ");
    }
    console.log("📨 CANDIDATURE ENVOYÉE SUR DISCORD");

    return res.status(200).send("OK");

  } catch (err) {
    console.error("❌ ERREUR API :", err);
    return res.status(500).send("ERROR");
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
      console.log("❌ Salon support introuvable");
      return res.status(500).send("Channel not found");
    }

    const embed = new EmbedBuilder()
      .setTitle("✉️ NOUVEAU MESSAGE SUPPORT")
      .setColor(0x00bfff)
      .addFields(
        { name: "👤 Nom", value: data.nom || "N/A", inline: true },
        { name: "📧 Email", value: data.email || "N/A", inline: true },
        { name: "🏷 Sujet", value: data.sujet || "N/A", inline: true },
        { name: "💬 Message", value: clamp(data.message) || "N/A" }
      )
      .setFooter({ text: "XBZ Support System" })
      .setTimestamp();

    await channel.send({ embeds: [embed] });
    console.log("📨 MESSAGE SUPPORT ENVOYÉ SUR DISCORD");

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ SUPPORT ERROR :", err);
    return res.status(500).send("ERROR");
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
// Renvoie true si l'update BDD a réussi.
async function updateCandidatureStatus(id, statut) {
  if (!supabase || !isUuid(id)) return false;
  const { error } = await supabase.from("candidatures").update({ statut }).eq("id", id);
  if (error) {
    console.error("❌ MAJ statut BDD échouée :", error.message);
    return false;
  }
  console.log(`💾 Statut BDD mis à jour : ${id} → ${statut}`);
  return true;
}

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, id] = interaction.customId.split("_");

  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

    // Synchronise la BDD (accept/refuse/interview → statut). L'échec BDD ne
    // bloque pas le retour Discord (on informe juste dans le message).
    const statut = STATUS_MAP[action];
    const synced = statut ? await updateCandidatureStatus(id, statut) : false;
    const dbNote = statut ? (synced ? " · BDD ✅" : (supabase && isUuid(id) ? " · BDD ⚠️" : "")) : "";

    // =====================
    // ACCEPT
    // =====================
    if (action === "accept") {
      await interaction.update({
        content: `🟢 CANDIDATURE **${id}** ACCEPTÉE par ${interaction.user.tag}${dbNote}`,
        components: []
      });

      if (logChannel) {
        logChannel.send(`✔ Candidature **${id}** ACCEPTÉE${dbNote}`);
      }
      return;
    }

    // =====================
    // REFUSE
    // =====================
    if (action === "refuse") {
      await interaction.update({
        content: `🔴 CANDIDATURE **${id}** REFUSÉE par ${interaction.user.tag}${dbNote}`,
        components: []
      });

      if (logChannel) {
        logChannel.send(`❌ Candidature **${id}** REFUSÉE${dbNote}`);
      }
      return;
    }

    // =====================
    // INTERVIEW (MODE ATTENTE)
    // =====================
    if (action === "interview") {

      const newRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`accept_${id}`)
          .setLabel("✅ Accepter")
          .setStyle(ButtonStyle.Success),

        new ButtonBuilder()
          .setCustomId(`refuse_${id}`)
          .setLabel("❌ Refuser")
          .setStyle(ButtonStyle.Danger)
      );

      await interaction.update({
        content:
          `🟡 CANDIDATURE **${id}** EN ENTREVUE${dbNote}\n\n` +
          `👤 Demandé par ${interaction.user.tag}\n` +
          `⏳ Statut : EN ATTENTE D'ENTRETIEN`,
        components: [newRow]
      });

      if (logChannel) {
        logChannel.send(`🟡 Entretien demandé pour **${id}**${dbNote}`);
      }

      return;
    }

  } catch (err) {
    console.error("❌ BUTTON ERROR :", err);

    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: "❌ Erreur bouton",
        ephemeral: true
      });
    }
  }
});
