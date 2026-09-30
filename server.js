// Serveur MCP BranShee — expose l'agenda, les clients et le catalogue à n8n.
//
// Application AUTONOME : son propre processus PM2, son propre port, son propre
// bloc nginx. Elle ne partage rien avec BranShee (port 3000) : elle lui parle
// par HTTP, comme le ferait l'application mobile. Un plantage ici ne touche pas
// BranShee, et son déploiement ne le redémarre pas.
//
// Deux transports, parce que les versions de n8n ne parlent pas toutes le même :
//   • POST /mcp   — HTTP Streamable (transport MCP actuel, n8n récent)
//   • GET  /sse   — Server-Sent Events + POST /messages (n8n plus ancien)
require("dotenv").config();

const express = require("express");
const crypto = require("crypto");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { SSEServerTransport } = require("@modelcontextprotocol/sdk/server/sse.js");
const { OUTILS } = require("./tools");
const { BransheeError } = require("./branshee");

const PORT = Number(process.env.PORT) || 3020;
const MCP_TOKEN = process.env.MCP_TOKEN;
// Interrupteur de sûreté : tant qu'un workflow n'est pas éprouvé, on peut
// n'exposer que la lecture. Aucun outil d'écriture n'est alors même annoncé,
// donc le modèle ne peut pas décider de l'appeler.
const LECTURE_SEULE = String(process.env.MCP_READ_ONLY || "").toLowerCase() === "true";

if (!MCP_TOKEN || MCP_TOKEN.length < 16) {
  console.error("[mcp] MCP_TOKEN manquant ou trop court (16 caractères min). Sans lui, n'importe qui piloterait l'agenda. Voir .env.example.");
  process.exit(1);
}

/** Comparaison à temps constant : ne laisse pas deviner le jeton caractère par caractère. */
function jetonValide(fourni) {
  if (!fourni) return false;
  const a = Buffer.from(fourni);
  const b = Buffer.from(MCP_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lireJeton(req) {
  const h = req.headers.authorization || "";
  if (h.startsWith("Bearer ")) return h.slice(7).trim();
  // n8n permet aussi une en-tête personnalisée : on accepte les deux formes
  // plutôt que d'imposer laquelle configurer.
  return req.headers["x-mcp-token"] || null;
}

function exigeAuth(req, res, next) {
  if (!jetonValide(lireJeton(req))) {
    return res.status(401).json({ error: "unauthorized", message: "Jeton MCP absent ou invalide." });
  }
  next();
}

/** Construit une instance de serveur MCP avec le catalogue d'outils. */
function creerServeur() {
  const serveur = new McpServer(
    { name: "branshee", version: "1.0.0" },
    {
      instructions:
        "Outils de gestion d'un établissement BranShee (prise de rendez-vous). " +
        "Avant de créer un rendez-vous, appeler `lister_creneaux_libres` pour proposer une heure réellement " +
        "disponible, et `lister_prestations` pour obtenir l'identifiant de la prestation. " +
        "Les dates s'écrivent AAAA-MM-JJ et les heures HH:MM.",
    },
  );

  const exposes = OUTILS.filter((o) => !LECTURE_SEULE || !o.ecrit);

  for (const outil of exposes) {
    serveur.registerTool(
      outil.nom,
      {
        title: outil.titre,
        description: outil.description,
        inputSchema: outil.schema,
        annotations: {
          readOnlyHint: !outil.ecrit,
          destructiveHint: !!outil.ecrit,
          openWorldHint: true,
        },
      },
      async (args) => {
        try {
          const resultat = await outil.executer(args || {});
          return { content: [{ type: "text", text: JSON.stringify(resultat, null, 2) }] };
        } catch (e) {
          // Erreur RENVOYÉE au modèle plutôt que levée : il peut alors corriger
          // ses arguments (créneau pris, e-mail manquant…) et réessayer, au
          // lieu de voir le workflow s'arrêter sur une exception opaque.
          const detail = e instanceof BransheeError
            ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ""}`
            : e.message;
          console.error(`[mcp] ${outil.nom} a échoué :`, detail);
          return { isError: true, content: [{ type: "text", text: `Échec de ${outil.nom} : ${detail}` }] };
        }
      },
    );
  }

  return { serveur, nbOutils: exposes.length };
}

const app = express();
app.set("trust proxy", 1);

app.get("/healthz", (_req, res) =>
  res.json({
    ok: true,
    service: "branshee-mcp",
    outils: OUTILS.filter((o) => !LECTURE_SEULE || !o.ecrit).length,
    lectureSeule: LECTURE_SEULE,
  }),
);

// ── Transport 1 : HTTP Streamable (recommandé) ───────────────────────────────
// Sans session : chaque requête crée son serveur et sa connexion, puis les
// ferme. C'est le mode le plus robuste derrière un proxy, et il évite qu'une
// session orpheline garde de la mémoire indéfiniment.
app.post("/mcp", exigeAuth, express.json({ limit: "1mb" }), async (req, res) => {
  const { serveur } = creerServeur();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); serveur.close(); });
  try {
    await serveur.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("[mcp] erreur transport HTTP :", e.message);
    if (!res.headersSent) res.status(500).json({ error: "mcp_transport", message: e.message });
  }
});

// Ces deux méthodes n'ont pas de sens en mode sans session : on répond
// explicitement plutôt que de laisser un client attendre.
app.get("/mcp", exigeAuth, (_req, res) =>
  res.status(405).json({ error: "method_not_allowed", message: "Utilisez POST /mcp, ou GET /sse pour le transport SSE." }));
app.delete("/mcp", exigeAuth, (_req, res) => res.status(405).end());

// ── Transport 2 : SSE (n8n plus ancien) ──────────────────────────────────────
const sessionsSse = new Map();

app.get("/sse", exigeAuth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const { serveur } = creerServeur();
  sessionsSse.set(transport.sessionId, { transport, serveur });
  res.on("close", () => {
    sessionsSse.delete(transport.sessionId);
    serveur.close();
  });
  try {
    await serveur.connect(transport);
  } catch (e) {
    console.error("[mcp] erreur transport SSE :", e.message);
    sessionsSse.delete(transport.sessionId);
  }
});

app.post("/messages", exigeAuth, async (req, res) => {
  const sessionId = String(req.query.sessionId || "");
  const session = sessionsSse.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: "unknown_session", message: "Session SSE inconnue ou expirée." });
  }
  try {
    await session.transport.handlePostMessage(req, res);
  } catch (e) {
    console.error("[mcp] erreur message SSE :", e.message);
    if (!res.headersSent) res.status(500).json({ error: "mcp_message", message: e.message });
  }
});

const httpServer = app.listen(PORT, "127.0.0.1", () => {
  const { nbOutils } = creerServeur();
  console.log(`[mcp] branshee-mcp écoute sur 127.0.0.1:${PORT}`);
  console.log(`[mcp] ${nbOutils} outils exposés${LECTURE_SEULE ? " (LECTURE SEULE)" : ""}`);
});
// Le SSE garde des connexions ouvertes longtemps : sans ça, nginx ou un
// équilibreur peut les couper au bout de 2 minutes.
httpServer.keepAliveTimeout = 65000;
httpServer.headersTimeout = 70000;

process.on("unhandledRejection", (e) => console.error("[mcp] unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("[mcp] uncaughtException", e));
