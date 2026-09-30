// Client de l'API mobile BranShee (/api/v1).
//
// Pourquoi passer par l'API plutôt que par MongoDB : toute la logique métier
// vit déjà derrière ces 92 routes — permissions par grade, quotas de forfait,
// détection de conflits, e-mails de confirmation, synchro Google Agenda,
// crédits SMS. Attaquer la base directement dupliquerait tout ça et, le jour
// où BranShee évolue, le MCP écrirait des données incohérentes en silence.
// Ici, si une règle change dans BranShee, le MCP la suit sans modification.
//
// Authentification : un vrai compte BranShee (identifiants dans .env). Le
// jeton d'accès vit 15 min, le jeton de rafraîchissement 60 jours ; on
// renouvelle automatiquement, et on ne rejoue une connexion complète que si le
// rafraîchissement échoue.

const BASE = (process.env.BRANSHEE_API_URL || "https://www.branshee.com/api/v1").replace(/\/+$/, "");
const EMAIL = process.env.BRANSHEE_EMAIL;
const PASSWORD = process.env.BRANSHEE_PASSWORD;
const COMPANY_ID = process.env.BRANSHEE_COMPANY_ID || "";
const TIMEOUT_MS = Number(process.env.BRANSHEE_TIMEOUT_MS) || 15000;

let accessToken = null;
let refreshToken = null;
let accessExpiresAt = 0; // ms epoch
let contexte = null; // { establishments, currentCompany… } renvoyé au login

class BransheeError extends Error {
  constructor(message, { status, code, details } = {}) {
    super(message);
    this.name = "BransheeError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function http(method, chemin, { body, query, token, timeoutMs = TIMEOUT_MS } = {}) {
  const url = new URL(BASE + chemin);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  // Établissement ciblé : l'API l'accepte en en-tête. Sans lui, elle prend
  // l'établissement par défaut du compte — ce qui, sur un compte qui en gère
  // plusieurs, écrirait dans le mauvais agenda sans rien signaler.
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (COMPANY_ID) headers["X-Company-Id"] = COMPANY_ID;

  const ctrl = new AbortController();
  const minuteur = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      signal: ctrl.signal,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    throw new BransheeError(
      e.name === "AbortError"
        ? `BranShee n'a pas répondu en ${timeoutMs} ms (${method} ${chemin}).`
        : `BranShee injoignable : ${e.message}`,
      { code: "network" },
    );
  } finally {
    clearTimeout(minuteur);
  }

  const texte = await res.text();
  let data;
  try { data = texte ? JSON.parse(texte) : {}; } catch { data = { raw: texte.slice(0, 500) }; }

  if (!res.ok) {
    throw new BransheeError(
      data.message || data.error || `HTTP ${res.status} sur ${method} ${chemin}`,
      { status: res.status, code: data.error, details: data },
    );
  }
  return data;
}

async function login() {
  if (!EMAIL || !PASSWORD) {
    throw new BransheeError(
      "BRANSHEE_EMAIL et BRANSHEE_PASSWORD manquants : le serveur MCP ne peut pas s'authentifier auprès de BranShee.",
      { code: "config" },
    );
  }
  const r = await http("POST", "/auth/login", { body: { email: EMAIL, password: PASSWORD } });
  if (r.twoFactorRequired) {
    // Volontairement fatal : un serveur sans interface ne peut pas saisir un
    // code à 6 chiffres. Mieux vaut le dire que boucler en échec.
    throw new BransheeError(
      "Ce compte BranShee a la double authentification activée : elle empêche une connexion automatique. Utilisez un compte dédié au MCP, sans 2FA.",
      { code: "2fa_required" },
    );
  }
  appliquerJetons(r);
  contexte = r.context || null;
  return r;
}

function appliquerJetons(r) {
  if (!r || !r.accessToken) throw new BransheeError("Réponse d'authentification inattendue.", { code: "auth" });
  accessToken = r.accessToken;
  if (r.refreshToken) refreshToken = r.refreshToken;
  // 60 s de marge : on renouvelle avant l'expiration plutôt que de découvrir
  // un 401 au milieu d'une action d'écriture.
  const dureeS = Number(r.expiresIn) || 15 * 60;
  accessExpiresAt = Date.now() + (dureeS - 60) * 1000;
}

async function jetonValide() {
  if (accessToken && Date.now() < accessExpiresAt) return accessToken;
  if (refreshToken) {
    try {
      appliquerJetons(await http("POST", "/auth/refresh", { body: { refreshToken } }));
      return accessToken;
    } catch {
      // Rafraîchissement refusé (mot de passe changé, session révoquée…) :
      // on retombe sur une connexion complète plutôt que d'échouer.
      accessToken = refreshToken = null;
    }
  }
  await login();
  return accessToken;
}

/** Appel authentifié. Un 401 isolé déclenche UNE reconnexion, puis on réessaie. */
async function api(method, chemin, options = {}) {
  const token = await jetonValide();
  try {
    return await http(method, chemin, { ...options, token });
  } catch (e) {
    if (e.status === 401) {
      accessToken = null;
      const neuf = await jetonValide();
      return http(method, chemin, { ...options, token: neuf });
    }
    throw e;
  }
}

/** Contexte du compte (établissements accessibles, permissions). */
async function getContexte() {
  if (!contexte) await login();
  return contexte;
}

module.exports = { api, login, getContexte, BransheeError, BASE, COMPANY_ID, EMAIL };
