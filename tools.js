// Catalogue des outils MCP exposés à n8n.
//
// Chaque outil est une façade mince au-dessus d'une route /api/v1 existante :
// pas de logique métier ici, uniquement la description (pour que le modèle
// choisisse le bon outil) et la validation des entrées.
//
// Les outils qui ÉCRIVENT sont marqués `destructive` dans leurs annotations —
// un client MCP peut s'en servir pour demander confirmation. n8n ne le fait
// pas aujourd'hui : c'est la raison d'être de MCP_READ_ONLY (voir server.js),
// qui permet de n'exposer que la lecture tant qu'un workflow n'est pas sûr.

const { z } = require("zod");
const { api } = require("./branshee");

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ");
const HEURE = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Heure attendue au format HH:MM");
const ID = z.string().regex(/^[a-f0-9]{24}$/i, "Identifiant BranShee invalide (24 caractères hexadécimaux)");

/**
 * @typedef Outil
 * @property {string} nom
 * @property {string} titre
 * @property {string} description  Lue par le modèle : dire QUAND s'en servir.
 * @property {object} schema       Formes zod des arguments.
 * @property {boolean} ecrit       true = modifie des données.
 * @property {(a:object)=>Promise<any>} executer
 */

/** @type {Outil[]} */
const OUTILS = [
  // ── Agenda ───────────────────────────────────────────────────────────────
  {
    nom: "lister_rendez_vous",
    titre: "Rendez-vous d'une journée ou d'une période",
    description:
      "Liste les rendez-vous. Donner `date` pour une seule journée, ou `from` et `to` pour une période. " +
      "Utile pour « quels sont mes RDV demain », un récapitulatif du matin, ou compter le remplissage.",
    schema: {
      date: DATE.optional().describe("Jour unique (AAAA-MM-JJ). Par défaut : aujourd'hui."),
      from: DATE.optional().describe("Début de période, à utiliser avec `to`."),
      to: DATE.optional().describe("Fin de période, à utiliser avec `from`."),
      employee: z.string().optional().describe("Identifiant d'un employé pour ne voir que son agenda."),
    },
    ecrit: false,
    executer: (a) => api("GET", "/bookings", { query: a }),
  },
  {
    nom: "lister_rendez_vous_a_venir",
    titre: "Prochains rendez-vous",
    description:
      "Les prochains rendez-vous à partir de maintenant, dans l'ordre chronologique. " +
      "Pour un rappel « qu'est-ce qui arrive », sans avoir à choisir une date.",
    schema: { limit: z.number().int().min(1).max(100).optional().describe("Nombre maximum (défaut 20).") },
    ecrit: false,
    executer: (a) => api("GET", "/bookings/upcoming", { query: a }),
  },
  {
    nom: "obtenir_rendez_vous",
    titre: "Détail d'un rendez-vous",
    description: "Tous les détails d'un rendez-vous : client, prestation, employé, paiement, notes.",
    schema: { id: ID.describe("Identifiant du rendez-vous.") },
    ecrit: false,
    executer: (a) => api("GET", `/bookings/${a.id}`),
  },
  {
    nom: "lister_creneaux_libres",
    titre: "Créneaux disponibles un jour donné",
    description:
      "Les créneaux réservables pour une date. Donner `serviceId` OU `duration` pour que la durée soit " +
      "prise en compte. À appeler AVANT de créer un rendez-vous, pour proposer une heure qui existe vraiment.",
    schema: {
      date: DATE.describe("Jour à examiner."),
      serviceId: ID.optional().describe("Prestation souhaitée (détermine la durée)."),
      duration: z.number().int().min(5).max(600).optional().describe("Durée en minutes, si aucune prestation."),
      employeeId: ID.optional().describe("Limiter à un employé."),
    },
    ecrit: false,
    executer: (a) => api("GET", "/bookings/slots", { query: a }),
  },
  {
    nom: "creer_rendez_vous",
    titre: "Créer un rendez-vous",
    description:
      "Crée un rendez-vous et envoie la confirmation au client (e-mail, et SMS/WhatsApp si l'établissement " +
      "les a activés). Nom, e-mail, date et heure sont obligatoires. Vérifier d'abord `lister_creneaux_libres` : " +
      "l'API refuse un créneau déjà occupé.",
    schema: {
      date: DATE.describe("Jour du rendez-vous."),
      startTime: HEURE.describe("Heure de début (HH:MM)."),
      name: z.string().min(1).describe("Prénom du client."),
      email: z.string().email().describe("E-mail du client — obligatoire, il reçoit la confirmation."),
      surname: z.string().optional().describe("Nom de famille."),
      phone: z.string().optional().describe("Téléphone (nécessaire pour un rappel SMS)."),
      serviceId: ID.optional().describe("Prestation réservée."),
      duration: z.number().int().min(5).max(600).optional().describe("Durée en minutes si pas de prestation."),
      employeeId: ID.optional().describe("Employé assigné."),
      message: z.string().optional().describe("Message ou note du client."),
    },
    ecrit: true,
    executer: (a) => api("POST", "/bookings", { body: a }),
  },
  {
    nom: "modifier_rendez_vous",
    titre: "Modifier un rendez-vous",
    description:
      "Change les informations d'un rendez-vous (client, message, notes internes, statut). " +
      "Ne transmettre que les champs à modifier.",
    schema: {
      id: ID.describe("Identifiant du rendez-vous."),
      name: z.string().optional(),
      surname: z.string().optional(),
      email: z.string().email().optional(),
      phone: z.string().optional(),
      message: z.string().optional().describe("Message visible du client."),
      adminNotes: z.string().optional().describe("Notes internes, invisibles du client."),
      status: z.enum(["confirmed", "pending", "canceled"]).optional(),
    },
    ecrit: true,
    executer: ({ id, ...reste }) => api("PATCH", `/bookings/${id}`, { body: reste }),
  },
  {
    nom: "annuler_rendez_vous",
    titre: "Annuler un rendez-vous",
    description:
      "Annule un rendez-vous et prévient le client. Le créneau redevient réservable. " +
      "Action irréversible : à ne déclencher que sur demande explicite.",
    schema: {
      id: ID.describe("Identifiant du rendez-vous."),
      reason: z.string().optional().describe("Motif, transmis au client."),
    },
    ecrit: true,
    executer: ({ id, ...reste }) => api("PATCH", `/bookings/${id}/cancel`, { body: reste }),
  },
  {
    nom: "marquer_absent",
    titre: "Marquer un client absent (no-show)",
    description: "Marque un rendez-vous comme « client non venu ». Sert aux statistiques de fiabilité.",
    schema: { id: ID.describe("Identifiant du rendez-vous.") },
    ecrit: true,
    executer: (a) => api("PATCH", `/bookings/${a.id}/no-show`, { body: {} }),
  },
  {
    nom: "bloquer_creneau",
    titre: "Bloquer un créneau (absence)",
    description:
      "Pose une absence : le créneau cesse d'être réservable par les clients. " +
      "Pour une pause, un rendez-vous personnel, une fermeture ponctuelle.",
    schema: {
      date: DATE.describe("Jour de l'absence."),
      startTime: HEURE.describe("Début (HH:MM)."),
      endTime: HEURE.describe("Fin (HH:MM)."),
      employeeId: ID.optional().describe("Employé concerné. Vide = tout l'établissement."),
      note: z.string().optional().describe("Motif affiché dans l'agenda (ex : dentiste)."),
    },
    ecrit: true,
    executer: (a) => api("POST", "/bookings/block", { body: a }),
  },

  // ── Clients ──────────────────────────────────────────────────────────────
  {
    nom: "lister_clients",
    titre: "Liste des clients",
    description: "Les clients de l'établissement. `search` filtre par nom, e-mail ou téléphone.",
    schema: {
      search: z.string().optional().describe("Recherche sur nom, e-mail ou téléphone."),
      limit: z.number().int().min(1).max(200).optional(),
    },
    ecrit: false,
    executer: (a) => api("GET", "/clients", { query: a }),
  },
  {
    nom: "obtenir_client",
    titre: "Fiche d'un client",
    description:
      "Fiche complète : coordonnées, historique des rendez-vous, dossier de suivi. " +
      "L'identifiant est celui d'un de ses rendez-vous (`bookingId`), comme dans l'application.",
    schema: { bookingId: ID.describe("Identifiant d'un rendez-vous de ce client.") },
    ecrit: false,
    executer: (a) => api("GET", `/clients/${a.bookingId}`),
  },
  {
    nom: "ajouter_note_dossier",
    titre: "Ajouter une note au dossier d'un client",
    description:
      "Ajoute une entrée datée au dossier de suivi : compte rendu de séance, observation, tâche à faire. " +
      "Réservé au professionnel, jamais visible du client.",
    schema: {
      bookingId: ID.describe("Identifiant d'un rendez-vous de ce client."),
      title: z.string().optional().describe("Titre de l'entrée."),
      note: z.string().optional().describe("Contenu."),
      todo: z.string().optional().describe("À faire la prochaine fois."),
      date: DATE.optional().describe("Date de l'entrée (défaut : aujourd'hui)."),
    },
    ecrit: true,
    executer: ({ bookingId, ...reste }) => api("POST", `/clients/${bookingId}/dossier/entries`, { body: reste }),
  },
  {
    nom: "bloquer_client",
    titre: "Bloquer ou débloquer un client",
    description:
      "Un client bloqué ne peut plus réserver en ligne. Passer `blocked: false` pour le débloquer.",
    schema: {
      bookingId: ID.describe("Identifiant d'un rendez-vous de ce client."),
      blocked: z.boolean().describe("true = bloquer, false = débloquer."),
      reason: z.string().optional().describe("Motif interne."),
    },
    ecrit: true,
    executer: ({ bookingId, ...reste }) => api("PATCH", `/clients/${bookingId}/block`, { body: reste }),
  },

  // ── Catalogue ────────────────────────────────────────────────────────────
  {
    nom: "lister_prestations",
    titre: "Prestations proposées",
    description:
      "Le catalogue : nom, durée, prix, couleur, employés habilités. " +
      "Nécessaire pour obtenir un `serviceId` avant de créer un rendez-vous.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/services"),
  },
  {
    nom: "lister_equipe",
    titre: "Membres de l'équipe",
    description: "Les employés réservables, avec leur identifiant — utile pour cibler un agenda.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/team"),
  },

  // ── Disponibilités ───────────────────────────────────────────────────────
  {
    nom: "obtenir_horaires",
    titre: "Horaires d'ouverture",
    description: "Les horaires de travail de la semaine, jour par jour.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/schedule"),
  },
  {
    nom: "lister_conges",
    titre: "Congés et fermetures",
    description: "Les journées de congé et fermetures enregistrées.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/timeoff"),
  },
  {
    nom: "ajouter_conge",
    titre: "Ajouter un congé",
    description:
      "Marque une journée (ou une plage) comme non travaillée : plus aucune réservation possible dessus.",
    schema: {
      date: DATE.describe("Jour de début."),
      endDate: DATE.optional().describe("Dernier jour, pour une plage."),
      reason: z.string().optional().describe("Motif."),
    },
    ecrit: true,
    executer: (a) => api("POST", "/timeoff", { body: a }),
  },

  // ── Pilotage ─────────────────────────────────────────────────────────────
  {
    nom: "obtenir_tableau_de_bord",
    titre: "Chiffres clés",
    description:
      "Statistiques de l'établissement : rendez-vous du jour, à venir, chiffre d'affaires, remplissage. " +
      "À utiliser pour un récapitulatif quotidien ou hebdomadaire.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/dashboard"),
  },
  {
    nom: "obtenir_credits_sms",
    titre: "Quota et solde SMS",
    description:
      "SMS inclus consommés ce mois, solde prépayé restant, réglages d'envoi. " +
      "Utile pour alerter avant d'être à court et que les rappels retombent sur l'e-mail.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/billing/sms"),
  },
  {
    nom: "lister_etablissements",
    titre: "Établissements accessibles",
    description:
      "Les établissements auxquels le compte connecté a accès, avec leur identifiant — " +
      "à renseigner dans BRANSHEE_COMPANY_ID pour cibler le bon agenda.",
    schema: {},
    ecrit: false,
    executer: () => api("GET", "/establishments"),
  },
];

module.exports = { OUTILS };
