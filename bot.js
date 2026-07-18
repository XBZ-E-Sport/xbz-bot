const express = require("express");
const cors = require("cors");

const app = express();

app.use(cors());
app.use(express.json());

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

// Couleur de l'embed selon la catégorie de candidature
const CATEGORY_COLORS = {
  "XBZ Esport": 0x0066ff, // bleu
  "XBZ Staff": 0xa05aff, // violet
};

// Tronque une valeur pour respecter la limite Discord (1024 car. par field)
const clamp = (s, max = 1024) => (s && s.length > max ? s.slice(0, max - 1) + "…" : s);
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
app.post("/recrutement", async (req, res) => {
  try {

    console.log("🔥 REQUÊTE REÇUE :", req.body);

    const data = req.body;
    console.log("📂 CATÉGORIE :", data.categorie, "| 🎯 RÔLE :", data.role);
    console.log("🎮 JEU :", data.jeu);
    console.log("🔗 RL TRACKER :", data.rltracker);

    // ID unique propre
    const id = `XBZ-${Date.now()}`;

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
      { name: "\u200B", value: "\u200B", inline: true },
      { name: "👤 Nom", value: data.nom || "N/A", inline: true },
      { name: "🎂 Âge", value: data.age || "N/A", inline: true },
      { name: "\u200B", value: "\u200B", inline: true },
      { name: "💬 Discord", value: data.discord || "N/A", inline: true },
      { name: "🎮 Pseudo", value: data.pseudo || "N/A", inline: true },
      {
        name: "🌍 Pays (résidence / naissance)",
        value: `${data.pays1 || "N/A"} / ${data.pays2 || "N/A"}`,
        inline: false,
      },
    ];

    // Champs spécifiques à l'Esport (jeu / rang / RL Tracker)
    if (isEsport) {
      fields.push({ name: "🕹 Jeu", value: data.jeu, inline: true });
      fields.push({ name: "🏆 Rang", value: data.rang || "N/A", inline: true });

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
🏆 Rang : ${data.rang || "N/A"}
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
🌍 Pays : ${data.pays1 || "N/A"} / ${data.pays2 || "N/A"}${esportLog}

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
// HOME ROUTE
// =====================
app.get("/", (req, res) => {
  res.send("XBZ BOT ONLINE ✔");
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
// =====================
client.login(process.env.TOKEN);
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const [action, id] = interaction.customId.split("_");

  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);

    // =====================
    // ACCEPT
    // =====================
    if (action === "accept") {
      await interaction.update({
        content: `🟢 CANDIDATURE **${id}** ACCEPTÉE par ${interaction.user.tag}`,
        components: []
      });

      if (logChannel) {
        logChannel.send(`✔ Candidature **${id}** ACCEPTÉE`);
      }
      return;
    }

    // =====================
    // REFUSE
    // =====================
    if (action === "refuse") {
      await interaction.update({
        content: `🔴 CANDIDATURE **${id}** REFUSÉE par ${interaction.user.tag}`,
        components: []
      });

      if (logChannel) {
        logChannel.send(`❌ Candidature **${id}** REFUSÉE`);
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
          `🟡 CANDIDATURE **${id}** EN ENTREVUE\n\n` +
          `👤 Demandé par ${interaction.user.tag}\n` +
          `⏳ Statut : EN ATTENTE D'ENTRETIEN`,
        components: [newRow]
      });

      if (logChannel) {
        logChannel.send(`🟡 Entretien demandé pour **${id}**`);
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
