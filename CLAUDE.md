@.claude/conventions.md

# Fusain

## Description

Atelier de dessin tactile (iPad, mobile, bureau) centré sur le dessin à la trame, en noir et blanc haute
résolution. Il reprend le moteur de Pixel Studio et sert de base à un mode BD : un projet est un document
structuré **pages → cases → calques**, plus des bulles et des textes. Un dessin commencé sur un appareil se
reprend sur un autre. Plus tard : un jeu où l'on dessine (il passerait alors à `game-system`).

- **Catégorie : primaire.** Toutes les fonctionnalités avancées des conventions sont attendues.
- **Cible : mobile et bureau** (tactile d'abord, iPad en tête).
- **Production : https://supershivas.github.io/fusain/** (GitHub Pages, déployé à chaque push sur `main`).
- **Objectif v1.0.0 :** dessiner une page de 4 cases avec trames sur iPad, la reprendre sur un autre appareil, l'exporter en PDF.
- L'IA n'écrit pas d'images : elle n'intervient que par l'import d'un **découpage JSON** (pages, cases, plans,
  dialogues) généré hors de l'app. Format et exemple : `js/portable.js` (`DECOUPAGE_EXEMPLE`).

## Stack

- Vanilla JS en modules ES, sans build ni dépendance (`python3 -m http.server`). Polices Google et icônes Tabler (webfont) par CDN.
- Hébergement : GitHub Pages (`.github/workflows/pages.yml`).
- Données : cache local IndexedDB (copie de travail) + Supabase (projet existant), tables préfixées `fusain_`.
  Schéma, règles RLS et bucket : `supabase/fusain.sql`, à exécuter une fois à la main.
  - `fusain_projects` : une ligne par projet, `data` = description sans pixels.
  - Storage, bucket privé `fusain` : un PNG par calque, `<uid>/<projet>/<calque>.png`.
- Authentification : lien magique par email (Supabase Auth). L'URL du site doit figurer dans les « Redirect URLs » du projet
  Supabase. Pour saisir le code à 6 chiffres (iPad en PWA), le modèle d'email doit contenir `{{ .Token }}`.
- URL et clé anon du projet Supabase : saisies dans Réglages, gardées en `localStorage` (paramètre d'appareil), **jamais commitées**.

## Structure

- `index.html`, `labo.html`, `css/` (`style.css`, `labo.css`, `mobile.css` synchronisé), `sw.js`, `manifest.webmanifest`.
- `js/model.js` — document (projet, page, case, calque, bulle), formats, dispositions. Pixels d'un calque : octets 0 = transparent, 1 = encre, 2 = blanc.
- `js/raster.js` — moteur 1-bit : undo **par différences de tuiles 64 px** (`UndoStack`), pinceau, formes, remplissage, composition.
- `js/tramas.js` — tuiles 1-bit (bibliothèque + trames perso par projet), dithering d'image. `dither.js` : matrices de Bayer (venues de Pixel Studio).
- `js/bubbles.js` — bulles vectorielles (aperçu et PDF partagent le code) : forme (ellipse, rectangle à angles réglables, nuage, tracé à main levée), marge intérieure, trait en mm, queue (pointe, flèche, bulles). Les réglages vides retombent sur le modèle du type (`props`). Contour imparfait : bruit déterministe tiré de `b.id` et `b.seed`. `js/fonts.js` : 26 polices Google (feuille de `index.html`) + polices importées (IndexedDB, par appareil) ; toute police doit être chargée (`loadFont`) avant un rendu sur canevas. `js/export.js` — rendu de page, PNG, PDF écrit à la main.
- Gouttières : `gutterHandles` / `resizeGutter` (`editor.js`) regroupent les cases qui bordent une même gouttière ; `reshape` garde le dessin à sa place sur la page. Copie de case : `copyPanelTo`.
- `js/view.js` (rendu et zoom), `input.js` (Pointer Events, rejet de la paume, pincer), `tools.js` (outils au pointeur), `editor.js` (état et actions annulables).
- `js/store.js` (IndexedDB, PNG 2 bits via `png.js`), `sync.js` (Supabase par `fetch`), `portable.js` (export/import JSON, découpage).
- `js/home.js`, `editor-ui.js`, `settings.js`, `ui-core.js`, `toast.js`, `main.js` (routage `#/p/<id>`), `app-update.js` (copié du design system).

## Exceptions aux conventions

- **Temps réel** : entre onglets par `BroadcastChannel` ; entre appareils par sondage (au retour au premier plan et toutes les 60 s),
  pas par Supabase Realtime.
- **Atelier** (section 8 quater) : non créé, il n'a pas été demandé (l'app est elle-même un atelier). **Labo** : `labo.html`, sujets Trames et Bulles.
- **Parité visuelle** : pas de barre latérale comme Idée et Source ; en-tête, boutons, modales et toasts suivent les tokens.
- Les trames personnalisées sont stockées **par projet** (dans `data.tramas`), pas dans une bibliothèque globale.

## Pièges connus

- Seule la **page ouverte** a ses pixels en mémoire (`loadPage` / `unloadPage`). Ne jamais lire `layer.data` d'une page non chargée ;
  l'historique est vidé à chaque changement de page.
- `UndoStack.touch()` doit précéder toute écriture dans un calque (il capture la tuile d'origine et marque le calque `dirty`).
  Après un changement de pixels, appeler `invalidate(panel, rect)` (vue) et `markChanged()` (enregistrement).
- Écrire l'enregistrement projet avec `updateRecord` (une transaction) : l'éditeur et la synchronisation y écrivent tous deux.
- Une page A4 à 300 dpi fait 2480 × 3508 px (8,7 Mpx) : sous la limite de 16 Mpx des canevas de Safari. Ne pas dépasser 300 dpi.
- L'encodage PNG par `canvas.toBlob` est très lent sur grand format : `png.js` écrit le PNG indexé lui-même (`CompressionStream`, repli sur le canevas).
- Pas de `hover` hors `@media (hover: hover)` (iOS prend le premier toucher pour un survol).
- Tests faits avec Playwright hors dépôt (aucun `package.json`) : dessin souris/stylet/tactile, undo, sync contre un faux Supabase, PDF vérifié avec `pdftoppm`.
