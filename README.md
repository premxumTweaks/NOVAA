# NOVAA — site multi-pages

Site vitrine de NOVA. Quatre pages réelles, une coquille partagée, un endpoint de contact qui écrit vraiment les messages.

## Pages

- `/` — accueil : hero, manifeste, sélection de projets, chiffres, appel à l'action
- `/work` — archive : filtres par discipline, neuf études de cas ouvrables en modale
- `/studio` — studio : position, équipe, capacités, processus, principes, distinctions
- `/contact` — brief : formulaire validé côté client et côté serveur, infos directes, FAQ

Les pages partagent `public/assets/base.css` (thème et composants) et `public/assets/site.js`
(préchargeur, curseur, fond WebGL, particules, révélations au scroll, audio, accordéons, transition de page).

## Lancer le site

1. Installe Node.js 18 ou plus récent.
2. Ouvre un terminal dans ce dossier.
3. Lance `npm install`.
4. Lance `npm start`.
5. Ouvre `http://localhost:3000`.

## Formulaire de contact

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

Réponse : `201 {"ok":true}` en cas de succès, `422` pour une validation échouée,
`429` au-delà de cinq envois par adresse sur dix minutes.

Les messages sont ajoutés en JSON Lines dans `data/contact.log` (un objet par ligne).

## Structure

```
public/
  index.html
  work.html
  studio.html
  contact.html
  404.html
  assets/
    base.css
    site.js
server.js
```

## Notes

- Les polices viennent de Google Fonts (Space Grotesk, JetBrains Mono).
- Le fond WebGL et les particules se désactivent avec `prefers-reduced-motion`.
- Le menu mobile est accessible via le bouton en haut à droite sous 760px.
- Les pages sont servies en `no-cache`, les assets avec un cache d'une heure.
