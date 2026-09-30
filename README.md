# Serveur MCP BranShee

Expose l'agenda, les clients et le catalogue BranShee comme **outils MCP**,
utilisables depuis **n8n** (nœud *MCP Client Tool*) ou tout autre client MCP.

**21 outils** : 13 en lecture, 8 en écriture.

---

## Comment c'est construit

Le serveur **n'attaque pas la base de données**. Il appelle l'API REST que
BranShee expose déjà (`/api/v1`, celle de l'application mobile), avec un vrai
compte utilisateur.

C'est le choix important : toute la logique métier — permissions par grade,
quotas de forfait, détection de conflits, e-mails de confirmation, synchro
Google Agenda, crédits SMS — vit derrière ces routes. En écrivant dans Mongo
directement, il aurait fallu la dupliquer, et le jour où BranShee évolue, le
MCP écrirait des données incohérentes en silence. Ici, il suit automatiquement.

Conséquence utile : **le MCP ne peut rien faire que le compte configuré ne
puisse faire lui-même.** Les permissions de ce compte sont la limite réelle.

| | BranShee | MCP |
|---|---|---|
| Processus PM2 | `branshee` | `branshee-mcp` |
| Port | 3000 | 3020 |
| Domaine | branshee.com | mcp.branshee.com |

Application autonome : un plantage du MCP ne touche pas BranShee, et son
déploiement ne le redémarre pas.

---

## Les outils

### Agenda
| Outil | Rôle |
|---|---|
| `lister_rendez_vous` | RDV d'un jour ou d'une période |
| `lister_rendez_vous_a_venir` | Les prochains, par ordre chronologique |
| `obtenir_rendez_vous` | Détail d'un RDV |
| `lister_creneaux_libres` | Créneaux réservables — **à appeler avant de créer** |
| `creer_rendez_vous` ✏️ | Crée et envoie la confirmation au client |
| `modifier_rendez_vous` ✏️ | Coordonnées, message, notes, statut |
| `annuler_rendez_vous` ✏️ | Annule et prévient le client |
| `marquer_absent` ✏️ | No-show |
| `bloquer_creneau` ✏️ | Pose une absence |

### Clients
| Outil | Rôle |
|---|---|
| `lister_clients` | Liste, avec recherche |
| `obtenir_client` | Fiche + historique + dossier |
| `ajouter_note_dossier` ✏️ | Entrée datée dans le dossier de suivi |
| `bloquer_client` ✏️ | Empêche la réservation en ligne |

### Catalogue, disponibilités, pilotage
| Outil | Rôle |
|---|---|
| `lister_prestations` | Services, durées, prix, `serviceId` |
| `lister_equipe` | Employés réservables |
| `obtenir_horaires` | Horaires de la semaine |
| `lister_conges` / `ajouter_conge` ✏️ | Congés et fermetures |
| `obtenir_tableau_de_bord` | Chiffres clés |
| `obtenir_credits_sms` | Quota et solde SMS |
| `lister_etablissements` | Établissements accessibles + leurs identifiants |

✏️ = écrit des données.

---

## Configuration

Copier `.env.example` en `.env` :

| Variable | Rôle |
|---|---|
| `MCP_TOKEN` | Jeton que n8n devra présenter. **Seul verrou du serveur.** |
| `BRANSHEE_EMAIL` / `BRANSHEE_PASSWORD` | Compte BranShee utilisé. Ses permissions = ce que n8n peut faire. |
| `BRANSHEE_COMPANY_ID` | Établissement ciblé. Vide = celui par défaut. |
| `MCP_READ_ONLY` | `true` = aucun outil d'écriture n'est exposé. |

> ⚠ **Le compte ne doit pas avoir la double authentification.** Un serveur sans
> interface ne peut pas saisir un code à 6 chiffres : la connexion échouerait.
> Recommandé : un compte collaborateur dédié, avec un grade limité aux droits
> réellement nécessaires.

> ⚠ **`MCP_READ_ONLY=true` au départ.** Les outils d'écriture ne sont alors même
> pas annoncés, donc le modèle ne peut pas décider de les appeler. À basculer
> une fois le workflow éprouvé.

---

## Brancher n8n

Nœud **MCP Client Tool** :

| Champ | Valeur |
|---|---|
| **Endpoint** | `https://mcp.branshee.com/mcp` |
| **Server Transport** | `HTTP Streamable` |
| **Authentication** | `Bearer` → la valeur de `MCP_TOKEN` |

Si ta version de n8n ne propose que **SSE**, utiliser `https://mcp.branshee.com/sse`
(même jeton) : les deux transports sont servis.

Vérifier que ça répond :

```bash
curl -s https://mcp.branshee.com/healthz
# {"ok":true,"service":"branshee-mcp","outils":21,"lectureSeule":false}
```

### Exemples de workflows

- **Récapitulatif du matin** — Schedule 7 h → `obtenir_tableau_de_bord` +
  `lister_rendez_vous` (date du jour) → message Telegram.
- **Réservation par message** — Webhook → AI Agent avec le MCP →
  `lister_creneaux_libres` puis `creer_rendez_vous`.
- **Alerte crédits SMS** — Schedule quotidien → `obtenir_credits_sms` → si le
  solde est bas, e-mail.
- **Relance des absents** — `lister_rendez_vous` sur la semaine écoulée →
  filtrer les no-shows → `obtenir_client` → message.

---

## Dépannage

| Symptôme | Cause | Vérifier |
|---|---|---|
| n8n : `401` | Jeton absent ou faux | L'en-tête `Authorization: Bearer …` = `MCP_TOKEN` |
| Démarrage refusé | `MCP_TOKEN` trop court | 16 caractères minimum |
| Tous les outils échouent | Identifiants BranShee | `pm2 logs branshee-mcp` → message explicite |
| `2fa_required` | Le compte a la 2FA | Utiliser un compte dédié sans 2FA |
| Outils d'écriture absents | `MCP_READ_ONLY=true` | Passer à `false` + `pm2 restart` |
| Mauvais agenda | Compte multi-établissements | Renseigner `BRANSHEE_COMPANY_ID` (`lister_etablissements`) |
| `409` sur création | Créneau déjà pris | Appeler `lister_creneaux_libres` d'abord |

Voir `DEPLOIEMENT.md` pour la mise en ligne.
