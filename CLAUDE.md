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
- Types de calques `kind` : `ink`, `tram`, `draft`. Chaque outil vise le calque de sa sorte (`targetLayer` / `peekTarget`, `editor.js`) : encre → `ink` (ou `draft` s'il est actif), trame → `tram`, gomme → calque actif ; un calque manquant est créé. Bulles : `hidden`, `locked`, et `bubblesHidden` par page (non exportées si masquées).
- Réglages de l'outil : uniquement dans la barre du haut (`renderOptbar`, `editor-ui.js`), sur **une seule ligne** (défilement horizontal). Forme du pinceau et trame = boutons sans texte qui ouvrent la bibliothèque en liste déroulante ; « Réglages » = une icône. Les fenêtres flottantes `#pop` (`popId` : `lib-brush`, `lib-trama`, `brush`, `trama`, `btext`, `bshape`, `btail`) ne se reconstruisent pas si leur HTML n'a pas changé (`syncPop`), pour ne pas perdre un toucher. La gomme utilise le moteur de pinceaux (pinceau propre, valeur 0). Volet de droite = 2 onglets : **Calques** (calques, bulles, propriétés du calque) et **Page** (pages, notes, cadre, masque, image, copie). Sections `<details>` (`sec()`, état dans `fusain:sections`) ; tout contrôle fermé par défaut doit s'ouvrir avant d'être testé.
- Menus de l'en-tête : `js/menus.js` (Fichier, Édition, Outils, Image, Calque, Page, Affichage ; le menu Outils ouvre la bibliothèque en fenêtre : `libraryModal` ; un seul bouton « Menu » ≤ 768 px). Chaque entrée est une commande de `COMMANDS` dans `editor-ui.js` (`runCommand`) ; ajouter une entrée = une ligne dans `menus()` + une commande.
- Calques : `opacity`, `locked`, `color` : nom de palette pour un brouillon, **« #rrggbb » libre pour un calque d'encre ou de trame** (`tintOf`, `raster.js` ; les pixels restent 1-bit, seule la teinte change ; bulles et cadres restent noirs ; le PDF passe en RVB 8 bits seulement si un calque est coloré, sinon 1 bit gris). `compositeRect` mélange en alpha à l'écran ; à l'export (`opts.export`) l'opacité d'un calque d'encre devient un gris tramé Bayer 8 × 8, un brouillon n'est jamais exporté.
- Pinceaux : un pinceau = des paramètres (`BRUSH_DEFAULTS`, `BUILTIN_BRUSHES` dans `raster.js` ; forme, pression, effilage, grain, dispersion, stabilisation). `stampBrush` / `strokeSegment` les rendent ; `tools.js` fournit pression, vitesse, départ effilé et stabilisation. Le pinceau trame, le crayon et la gomme partagent ce moteur (la trame est la peinture) ; taille max 50 mm pour la trame (`maxSizeMm`), 30 mm sinon. Pinceaux perso, taille par pinceau et réglages de trame : `localStorage` (`fusain:prefs`) ; bibliothèque de trames globale : IndexedDB (`tramaLib`).
- `js/raster.js` — moteur 1-bit : undo **par différences de tuiles 64 px** (`UndoStack`), pinceau, formes, remplissage, composition. Le pot de peinture tolère les contours ouverts (`floodRegion(…, gap)` : encre épaissie, remplissage, regonflé) ; curseur `ed.fillGap` 0–100 (défaut 100 = trous jusqu'à 2,5 mm), dans la barre du haut.
- `js/tramas.js` — tuiles 1-bit (bibliothèque + trames perso par projet), dithering d'image. `dither.js` : matrices de Bayer (venues de Pixel Studio).
- `js/bubbles.js` — bulles vectorielles (aperçu et PDF partagent le code) : forme (ellipse, rectangle à angles réglables, nuage, tracé à main levée), marge intérieure, trait en mm, queue (pointe, flèche, bulles). Les réglages vides retombent sur le modèle du type (`props`). Contour imparfait : bruit déterministe tiré de `b.id` et `b.seed`. **Chaque bulle est liée à une case** (`b.panel`, `linkBubbles`) : supprimer la case supprime ses bulles (rétablies par annuler, `swapPanels`), fusionner les reporte sur la case qui absorbe, copier une case (`copyPanelTo`) ou dupliquer une page les copie, poser une bulle sur une autre case la relie à celle-ci ; elles ne bougent pas quand le cadre change (comme le dessin). Duplication : `duplicateBubble`. Rotation `b.rot` (degrés autour du centre ; la pointe de la queue reste fixe sur la page ; `bubbleToPage` / `bubbleToLocal`, poignée de rotation aimantée tous les 15°) ; `b.sameStroke` (trait = celui du cadre de sa case), `b.noFrame` (avec `clip` : la bulle efface le trait du cadre là où elle le touche, `drawPageBubble`), `applyBubbleLines` (copie ces traits sur toutes les bulles du projet) ; `b.clip` rogne la bulle au cadre de sa case (`drawPageBubble`) ; corps du texte jusqu'à 200 pt. `js/fonts.js` : 26 polices Google (feuille de `index.html`) + polices importées (IndexedDB, par appareil) ; toute police doit être chargée (`loadFont`) avant un rendu sur canevas. `js/export.js` — rendu de page, PNG, PDF écrit à la main.
- **Case = cadre visible (`x,y,w,h`) + étendue des calques (`ex,ey,ew,eh`)** : les calques couvrent au moins le cadre et ne rétrécissent jamais, donc réduire une case ne coupe rien (`reshape`, `editor.js`). Coordonnées de calque = page − `ex,ey` ; on ne dessine que dans le cadre (`ctx.clip`) ; le remplissage voit hors cadre comme de l'encre. Fusion : `mergeCandidates` / `mergePanels` ; suppression : `deletePanel`.
- Réglages par outil : `TOOL_DEFAULTS` / `storeToolSettings` / `applyToolSettings` (`editor.js`), rangés dans `localStorage` (`fusain:prefs`) avec le dernier style de chaque type de bulle (`bubbleDefaults`). Les tailles se règlent en mm (`sizeMm`), `ed.size` en est la valeur en pixels.
- Gouttières : `gutterHandles` / `resizeGutter` (`editor.js`) ; le « + » d'une gouttière (`gutterPlus`, `addCase`) coupe en deux les cases qui la bordent côté gauche/haut. Elles regroupent les cases qui bordent une même gouttière ; `reshape` garde le dessin à sa place sur la page. Copie de case : `copyPanelTo`.
- Gestes (`input.js`) : deux doigts zooment **et tournent la page** (`view.r`, rotation comptée au-delà de 8°, aimant tous les 45° à ±5° ; `toPage` / `toScreen` en tiennent compte, jamais `view.ox/oy/s` seuls ; menu Image : « Tourner de 90° », « Remettre droite », `0` ajuste et redresse) ; un toucher en mode déplacement (outil main, ou doigt quand le stylet est en usage) change de case sans dessiner ; deux doigts zooment, tape à deux = annuler, tape à trois = rétablir, trois doigts qui frottent (≥ 4 allers-retours) ou tournent vident le calque actif. Dès que trois doigts bougent, le geste n'est plus un « tape ». Rejet de la paume (`input.js`, réglage `ed.palm` : fort 1,6 s / normal 0,7 s / off) : un doigt **isolé** posé pendant ou juste après un appui de stylet est marqué `palm` (il ne dessine ni ne déplace la vue, et ne compte pas dans les gestes) ; un second doigt rend les deux réels, donc zoom / annuler / rétablir restent libres. Ni le survol ni la taille du contact ne comptent (Safari ne les rapporte pas de façon fiable) ; un « stylet posé » sans relevé expire après 3 s. Stylet : bouton du flanc = bascule plume ↔ gomme (le double tape du bout a été retiré : il changeait l'outil par erreur) ; bout gomme (`buttons & 32`) = gomme le temps du trait. Le double tape du flanc de l'Apple Pencil n'est pas exposé aux pages web. Pression : `pressureOf` (`tools.js`) applique la courbe `ed.pressureGamma` ; la pression d'un stylet n'est jamais remplacée par 0,5.
- `js/view.js` (rendu et zoom), `input.js` (Pointer Events, rejet de la paume, pincer), `tools.js` (outils au pointeur), `editor.js` (état et actions annulables).
- `js/shell.js` — plein écran (Safari iPad seulement, pas iPhone), détection iOS / installé, garde-fous contre la sélection, le menu de pression longue, le zoom de page et le double toucher (avec le CSS de `style.css`). Les champs de saisie gardent `user-select: text`, sinon Safari ne les laisse plus taper.
- `js/store.js` (IndexedDB, PNG 2 bits via `png.js`), `sync.js` (Supabase par `fetch`), `portable.js` (export/import JSON, découpage).
- `js/home.js`, `editor-ui.js`, `menus.js`, `settings.js`, `ui-core.js`, `toast.js`, `main.js` (routage `#/p/<id>`), `app-update.js` (copié du design system).

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
