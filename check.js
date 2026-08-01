#!/usr/bin/env node
// =====================================================================
//  XBZ · check.js — diagnostic complet du bot
//
//  Usage :
//    node check.js                    → vérifie config + Supabase + Discord
//    node check.js --url <URL>        → teste aussi l'API HTTP d'un bot en marche
//    node check.js --url <URL> --smoke → + envoie une VRAIE candidature de test
//                                        sur Discord (message visible !)
//
//  Ce script ne modifie AUCUNE donnée : il lit, et teste les permissions
//  d'écriture sur 0 ligne (update sur un id inexistant).
//  Aucun secret n'est affiché (longueurs uniquement).
// =====================================================================

require("dotenv").config({ quiet: true });

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : undefined;
};
const URL_TARGET = getArg("--url");
const SMOKE = args.includes("--smoke");

const CHANNELS = {
  "Staff (STAFF_CHANNEL_ID)": "1522304854310256680",
  "Esport (ESPORT_CHANNEL_ID)": "1527664119682044135",
  "Logs (LOG_CHANNEL_ID)": "1522335394522333275",
  "Support (SUPPORT_CHANNEL_ID)": process.env.SUPPORT_CHANNEL_ID || "1522304854310256680",
};

const STATUTS = ["accepte", "refuse", "entretien"];
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

let fails = 0;
let warns = 0;
const ok = (m) => console.log("  ✅", m);
const warn = (m) => (warns++, console.log("  ⚠️ ", m));
const bad = (m) => (fails++, console.log("  ❌", m));
const title = (t) => console.log(`\n${t}\n${"─".repeat(t.length)}`);
const present = (v) => (v ? `défini (${String(v).length} caractères)` : "ABSENT");

(async () => {
  console.log("\n🦇 XBZ · Diagnostic du bot\n==========================");

  title("1. Environnement");
  const major = Number(process.versions.node.split(".")[0]);
  major >= 18
    ? ok(`Node ${process.version}`)
    : bad(`Node ${process.version} — il faut Node 18+ (fetch natif requis)`);

  for (const dep of ["discord.js", "express", "@supabase/supabase-js", "dotenv", "cors"]) {
    try {
      require.resolve(dep);
      ok(`dépendance ${dep}`);
    } catch {
      bad(`dépendance ${dep} manquante → lance : npm install`);
    }
  }

  title("2. Variables d'environnement");
  const TOKEN = process.env.TOKEN;
  TOKEN ? ok(`TOKEN ${present(TOKEN)}`) : bad("TOKEN ABSENT → le bot ne peut pas se connecter à Discord");

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
  if (SUPABASE_URL && SUPABASE_KEY) {
    ok(`SUPABASE_URL = ${SUPABASE_URL}`);
    ok(`SUPABASE_SECRET_KEY ${present(SUPABASE_KEY)}`);
  } else {
    warn("Supabase non configuré → les boutons Discord ne mettront PAS à jour la BDD");
  }

  process.env.BOT_SHARED_SECRET
    ? ok(`BOT_SHARED_SECRET ${present(process.env.BOT_SHARED_SECRET)} (doit être IDENTIQUE côté site)`)
    : warn("BOT_SHARED_SECRET absent → l'API du bot est ouverte à tout le monde");

  process.env.PANEL_PASSWORD
    ? ok(`PANEL_PASSWORD ${present(process.env.PANEL_PASSWORD)}`)
    : warn("PANEL_PASSWORD absent → le bouton de redémarrage du panel est désactivé");

  process.env.SUPPORT_CHANNEL_ID
    ? ok(`SUPPORT_CHANNEL_ID = ${process.env.SUPPORT_CHANNEL_ID}`)
    : warn("SUPPORT_CHANNEL_ID absent → les messages support iront dans le salon staff");

  /^https?:\/\//.test(process.env.SITE_URL || "")
    ? ok(`SITE_URL = ${process.env.SITE_URL}`)
    : warn("SITE_URL absent/invalide → pas de bouton « Back-office » sous les candidatures");

  process.env.DISCORD_ERROR_WEBHOOK_URL
    ? ok("DISCORD_ERROR_WEBHOOK_URL défini (mêmes alertes que le site)")
    : warn("DISCORD_ERROR_WEBHOOK_URL absent → les erreurs du bot restent dans les logs Render");

  title("3. Supabase (table candidatures)");
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    warn("ignoré (non configuré)");
  } else {
    try {
      const { createClient } = require("@supabase/supabase-js");
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });

      const { data, error } = await supabase
        .from("candidatures")
        .select("id, statut, roster, created_at")
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) {
        bad(`lecture impossible : ${error.message}`);
        if (/column .*roster/i.test(error.message)) {
          bad("→ la migration `roster` n'est pas appliquée sur ce projet Supabase");
        }
      } else {
        ok("lecture de `candidatures` OK (colonnes id, statut, roster présentes)");
        if (data.length) {
          ok(`dernière candidature : ${data[0].id} · statut « ${data[0].statut} »`);
        } else {
          warn("table vide — envoie une candidature de test depuis le site");
        }
      }

      const { error: upErr } = await supabase
        .from("candidatures")
        .update({ statut: STATUTS[0] })
        .eq("id", ZERO_UUID);
      upErr
        ? bad(`écriture refusée : ${upErr.message} (clé service_role attendue)`)
        : ok("droit d'écriture sur `statut` OK (test à vide, 0 ligne modifiée)");
    } catch (e) {
      bad(`Supabase injoignable : ${e.message}`);
    }
  }

  title("4. Discord (connexion + salons)");
  if (!TOKEN) {
    bad("ignoré : TOKEN absent");
  } else {
    const { Client, GatewayIntentBits, PermissionsBitField, Events } = require("discord.js");
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    try {
      await client.login(TOKEN);
      await new Promise((resolve, reject) => {
        if (client.isReady()) return resolve();
        const timer = setTimeout(() => reject(new Error("connexion trop longue (30 s)")), 30_000);
        client.once(Events.ClientReady, () => (clearTimeout(timer), resolve()));
      });
      ok(`connecté en tant que ${client.user.tag}`);
      ok(`serveurs : ${client.guilds.cache.map((g) => g.name).join(", ") || "aucun"}`);

      const needed = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.EmbedLinks,
      ];
      for (const [label, id] of Object.entries(CHANNELS)) {
        const ch = await client.channels.fetch(id).catch(() => null);
        if (!ch) {
          bad(`${label} : salon ${id} INTROUVABLE (mauvais id, ou bot absent du serveur)`);
          continue;
        }
        const me = await ch.guild.members.fetchMe().catch(() => null);
        const perms = me ? ch.permissionsFor(me) : null;
        const missing = perms ? needed.filter((f) => !perms.has(f)) : [];
        if (!perms) warn(`${label} : #${ch.name} trouvé, permissions non vérifiables`);
        else if (missing.length)
          bad(`${label} : #${ch.name} — permissions manquantes (voir/écrire/intégrer des liens)`);
        else ok(`${label} : #${ch.name} — écriture OK`);
      }
    } catch (e) {
      bad(`connexion Discord échouée : ${e.message}`);
      if (/token/i.test(e.message)) bad("→ TOKEN invalide ou régénéré : recopie-le depuis le portail Discord");
    } finally {
      await client.destroy().catch(() => {});
    }
  }

  title("5. API HTTP du bot");
  if (!URL_TARGET) {
    warn("ignoré — relance avec : node check.js --url http://localhost:3000");
  } else {
    const base = URL_TARGET.replace(/\/+$/, "");
    const secret = process.env.BOT_SHARED_SECRET;

    try {
      const r = await fetch(base + "/", { signal: AbortSignal.timeout(60000) });
      const body = await r.text();
      r.ok && body.includes("XBZ")
        ? ok(`GET / → ${r.status} « ${body.slice(0, 40)} »`)
        : bad(`GET / → ${r.status} (réponse inattendue)`);
    } catch (e) {
      bad(`GET / injoignable : ${e.message} — le bot tourne-t-il sur cette URL ?`);
    }

    try {
      const r = await fetch(base + "/health", { signal: AbortSignal.timeout(30000) });
      const h = await r.json();
      h.ok
        ? ok(`GET /health → Discord « ${h.discord} », Supabase ${h.supabase ? "connecté" : "non configuré"}, uptime ${h.uptimeSeconds}s`)
        : bad(`GET /health → ${r.status} : le serveur répond mais Discord est déconnecté`);
    } catch (e) {
      warn(`GET /health indisponible : ${e.message} (bot.js pas à jour ?)`);
    }

    if (secret) {
      try {
        const r = await fetch(base + "/recrutement", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-xbz-secret": "mauvais-secret" },
          body: JSON.stringify({ nom: "test" }),
          signal: AbortSignal.timeout(30000),
        });
        r.status === 401
          ? ok("POST /recrutement avec un mauvais secret → 401 (protection active)")
          : bad(`POST /recrutement avec un mauvais secret → ${r.status} (attendu 401 !)`);
      } catch (e) {
        bad(`test du secret impossible : ${e.message}`);
      }
    } else {
      warn("test du secret ignoré (BOT_SHARED_SECRET non défini ici)");
    }

    if (SMOKE) {
      const headers = { "Content-Type": "application/json", ...(secret ? { "x-xbz-secret": secret } : {}) };
      const tests = [
        [
          "/recrutement",
          {
            id: ZERO_UUID,
            categorie: "XBZ Esport",
            role: "Joueur",
            nom: "TEST diagnostic",
            age: "20",
            pays1: "France",
            discord: "test#0000",
            pseudo: "TEST",
            jeu: "Rocket League",
            rang: "Roster 2",
            rltracker: "https://rocketleague.tracker.network/",
            exp: "Message de test envoyé par check.js",
            motiv: "Vérifier la chaîne site → bot → Discord",
          },
        ],
        [
          "/recrutement",
          {
            categorie: "XBZ Staff",
            role: "Graphiste",
            nom: "TEST diagnostic (staff)",
            age: "25",
            pays1: "France",
            discord: "test#0000",
            pseudo: "TEST",
            exp: "Message de test envoyé par check.js",
            motiv: "Vérifier la branche Staff (sans jeu)",
          },
        ],
        [
          "/support",
          {
            nom: "TEST diagnostic",
            email: "test@xbz.gg",
            sujet: "Test check.js",
            message: "Message de test envoyé par check.js",
          },
        ],
      ];
      for (const [path, payload] of tests) {
        try {
          const r = await fetch(base + path, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(60000),
          });
          r.ok
            ? ok(`POST ${path} → ${r.status} — vérifie le message de test sur Discord`)
            : bad(`POST ${path} → ${r.status} ${await r.text().catch(() => "")}`);
        } catch (e) {
          bad(`POST ${path} échoué : ${e.message}`);
        }
      }
      console.log("  ℹ️  Sur la candidature de test, les boutons afficheront « BDD ⚠️ »");
      console.log("     (id inexistant en base) : c'est NORMAL pour ce test.");
    } else {
      warn("envoi réel ignoré — ajoute --smoke pour poster un message de test sur Discord");
    }
  }

  console.log(
    `\n==========================\n${fails ? "❌" : "✅"} ${fails} erreur(s), ${warns} avertissement(s)\n`,
  );
  process.exit(fails ? 1 : 0);
})();
