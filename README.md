# NOVAA — site, comptes et messages

Site vitrine de NOVA : quatre pages, un formulaire de contact qui enregistre réellement les
briefs, et un système de comptes autonome (inscription, connexion, déconnexion, session
persistante) stocké dans une base SQLite sur le volume persistant.

Aucun service tiers : pas de Firebase, pas de Supabase, pas de fournisseur d'identité.

## Pages

- `/` — accueil : hero, manifeste, sélection de projets, chiffres, appel à l'action
- `/work` — archive : filtres par discipline, neuf études de cas ouvrables en modale
- `/studio` — studio : position, équipe, capacités, processus, principes, distinctions
- `/contact` — brief : formulaire validé côté client et côté serveur, infos directes, FAQ
- `/login` — connexion
- `/register` — création de compte
- `/account` — espace personnel (redirige vers `/login` sans session)

Les pages partagent `public/assets/base.css` (thème et composants) et `public/assets/site.js`
(préchargeur, curseur, fond WebGL, particules, révélations au scroll, audio, accordéons,
transition de page, bascule du lien de navigation `Log in` → `Account`).

## Stack

| Élément | Choix | Raison |
| --- | --- | --- |
| Serveur | Node.js 24 + Express 4 | `node:sqlite` est stable à partir de Node 24 |
| Base | SQLite (`node:sqlite`, `DatabaseSync`) | zéro dépendance native, un seul fichier |
| Mots de passe | `crypto.scryptSync` (N=16384, r=8, p=1, 64 octets) | disponible dans la stdlib |
| Sessions | token aléatoire 256 bits, hash SHA-256 en base, cookie `HttpOnly` | révocable côté serveur |
| Fichiers | volume persistant monté sur `/data` | la racine du conteneur est en lecture seule |

`node:sqlite` n'existe pas avant Node 24 : `package.json` déclare `"engines": {"node": ">=24.0.0"}`.

## Lancer en local

```bash
npm install
npm start
# http://localhost:3000
```

Sans variables d'environnement, la base est créée dans `./data/novaa.db`.

Pour tester sur http sans HTTPS, le cookie doit être non-`Secure` :

```bash
# PowerShell
$env:DATA_DIR="$env:TEMP\novaa-dev"; $env:COOKIE_SECURE="false"; npm start
```

## Variables d'environnement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `3000` | port d'écoute (le serveur écoute sur `0.0.0.0`) |
| `DATA_DIR` | `./data` | dossier de la base **et** du fichier de suivi des démarrages |
| `NODE_ENV` | — | `production` active le cookie `Secure` par défaut |
| `COOKIE_SECURE` | `NODE_ENV=production` | force le drapeau `Secure` du cookie de session |
| `ADMIN_TOKEN` | — | active `/api/admin/*` ; sans lui l'API admin répond `503` |

Générer un jeton d'administration :

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## API

### Authentification

| Méthode | Route | Corps | Réponses |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | `{name?, email, password}` | `201` + cookie, `409` email déjà pris, `422` invalide, `429` trop de comptes |
| `POST` | `/api/auth/login` | `{email, password, remember?}` | `200` + cookie, `401` identifiants faux, `429` trop d'essais |
| `POST` | `/api/auth/logout` | — | `200`, supprime la session en base et efface le cookie |
| `GET` | `/api/auth/me` | — | `{ok:true, user}` ou `{ok:true, user:null}` |

- Mot de passe : 10 à 200 caractères, jamais stocké en clair.
- Email : normalisé en minuscules, unicité insensible à la casse (`COLLATE NOCASE`).
- Session : 24 h par défaut, 30 jours si `remember: true`. Cookie `novaa_sid`,
  `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` en production.
- Le token est stocké **haché** (SHA-256) : une copie de la base ne permet pas de rejouer une session.

### Contact

`POST /api/contact` reçoit du JSON :

```json
{
  "name": "Iris",
  "email": "iris@example.com",
  "company": "Studio",
  "budget": "25-50k",
  "scope": ["Website", "Realtime / WebGL"],
  "message": "Texte du brief, vingt caractères minimum."
}
```

Réponses : `201 {"ok":true}`, `422` validation échouée, `429` au-delà de cinq envois par
adresse sur dix minutes, `400` si le champ piège `website` est rempli.

Les messages vont dans la table `contact_messages`. Au premier démarrage, un ancien
`data/contact.log` (JSON Lines) est importé automatiquement puis renommé
`contact.log.imported` — l'import ne se rejoue donc pas.

### Administration

Les deux routes exigent `x-admin-token: <ADMIN_TOKEN>` ou `Authorization: Bearer <ADMIN_TOKEN>`.

| Méthode | Route | Effet |
| --- | --- | --- |
| `GET` | `/api/admin/messages?limit=50` | derniers briefs (1 à 200) |
| `POST` | `/api/admin/backup` | sauvegarde cohérente via `VACUUM INTO` |

### Santé

| Route | Contenu |
| --- | --- |
| `GET /health` | `ok`, `uptime`, `storage` (volume détecté), `schema`, `users` |
| `GET /health/storage` | `dataDir`, espace total/libre, taille de la base, compteur de démarrages, `previousBootAt` |

`/health/storage` est le contrôle à faire après un redéploiement : `boots` doit augmenter et
`previousBootAt` doit correspondre au démarrage précédent. C'est la preuve que le volume est
réellement persistant et pas un dossier éphémère du conteneur.

## Structure

```
public/
  index.html  work.html  studio.html  contact.html  404.html
  login.html  register.html  account.html
  assets/base.css  assets/site.js
lib/
  db.js          # SQLite, migrations, import legacy, sauvegardes, /data
  auth.js        # scrypt, sessions, cookies, rate limit, validation
scripts/
  backup.js      # sauvegarde CLI
server.js
Dockerfile
deplexo.yaml
.env.example
```

## Base de données

Fichier `DATA_DIR/novaa.db`, mode WAL. Schéma versionné par `PRAGMA user_version`
(actuellement v1) et migré automatiquement au démarrage.

- `users` — `id`, `email` (unique, NOCASE), `password_hash`, `display_name`, `created_at`, `updated_at`
- `sessions` — `id_hash` (SHA-256 du token), `user_id`, `created_at`, `expires_at`, `ip`, `user_agent`
- `contact_messages` — brief, `scope` en JSON, `ip`, `created_at`

Les sessions expirées sont purgées au démarrage puis toutes les heures.

## Sauvegardes

```bash
DATA_DIR=/data npm run backup
# ou
curl -X POST -H "x-admin-token: $ADMIN_TOKEN" https://<domaine>/api/admin/backup
```

Écrit dans `DATA_DIR/backups/`, conserve les 14 fichiers les plus récents. **Cette sauvegarde
reste sur le même volume** : elle protège d'une erreur de manipulation, pas de la perte du
worker. Copier régulièrement les fichiers `.db` hors de la plateforme.

## Déploiement sur Deplexo

`deplexo.yaml` décrit uniquement le build et le port ; le volume se configure dans le
dashboard, pas dans ce fichier.

```yaml
version: 1
type: web
build:
  framework: dockerfile
  dockerfile: Dockerfile
run:
  port: 3000
```

Étapes :

1. **Settings → Storage** : monter le volume persistant sur `/data`. C'est le seul réglage
   qui rend les comptes durables ; `deplexo.yaml` ne peut pas le déclarer.
2. **Settings → Environment** :
   - `NODE_ENV=production`
   - `DATA_DIR=/data`
   - `COOKIE_SECURE=true`
   - `ADMIN_TOKEN=<jeton généré>`
3. Pousser le dépôt, puis déployer.
4. Ouvrir `/health/storage` et vérifier `ok:true`, `dataDir:"/data"`, `schema:1`.
5. Créer un compte, redéployer, recharger `/account` : la session et le compte doivent survivre,
   et `boots` doit avoir augmenté de 1 avec `previousBootAt` renseigné.

### Contraintes de la plateforme prises en compte

- La racine du système de fichiers est en lecture seule : tout ce qui est écrit va dans `/data`.
  Un `DATA_DIR` non monté fait échouer le démarrage avec un message explicite plutôt que de
  perdre silencieusement les comptes.
- `/data` et `/tmp` sont montés `noexec` : aucun binaire n'est exécuté depuis ces dossiers.
- Le volume appartient à `root` au montage. Le serveur démarre en root uniquement pour
  changer le propriétaire de `DATA_DIR`, puis abandonne les privilèges (`setgid`/`setuid` 1000)
  avant d'ouvrir la base.
- Un volume par application, et il est perdu si l'application est supprimée ou déplacée de worker.

## Sécurité

- Mots de passe hachés avec scrypt et sel aléatoire par compte.
- Cookies `HttpOnly` + `SameSite=Lax`, `Secure` en production, pas de token lisible en JS.
- Sessions stockées hachées, révoquées côté serveur à la déconnexion.
- Limitation de débit : 30 connexions / 15 min par IP, 8 / 15 min par couple IP+email,
  10 inscriptions / heure par IP, 5 messages / 10 min par IP.
- Les requêtes `POST` d'API refusent une origine différente (`Origin` ≠ `Host` → `403`).
- En-têtes `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
  `Permissions-Policy` sur toutes les réponses.
- Corps JSON limité à 16 ko.

## Notes

- Les polices viennent de Google Fonts (Space Grotesk, JetBrains Mono).
- Le fond WebGL et les particules se désactivent avec `prefers-reduced-motion`.
- Le menu mobile est accessible via le bouton en haut à droite sous 760px.
- Les pages sont servies en `no-cache`, les assets avec un cache d'une heure.
