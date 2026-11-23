# Feuille de route — Fusain

Dernière mise à jour : 2026-11-23 (v1.56.0).

## Fait (v1.29.0 → v1.56.0, 22-23 novembre 2026)

### Pinceaux et trames
- [x] Palette de pinceaux du projet dans la barre du bas, synchronisée avec le projet (v1.29)
- [x] Taille et opacité en curseurs verticaux au bord gauche ; opacité en gris tramé (v1.29)
- [x] Repères aimantés sur les curseurs (appui long), gardés avec chaque pinceau ; aimantation revue (v1.33, v1.35.1)
- [x] Pinceau et trame réunis en un seul outil ; encre pleine = cercle noir en tête des trames (v1.35, v1.35.2)
- [x] Appui long sur un pinceau de la palette ou de « Mes pinceaux » = retiré, avec Annuler (v1.34)
- [x] Réglages du pinceau en une seule fenêtre, aperçu du trait en direct (v1.38.1)
- [x] Aperçu du trait à taille réelle pendant le réglage de la taille ou de l'opacité (v1.39)
- [x] Courbe du curseur de taille revue (petites tailles compactes, grandes fines) (v1.39.1)
- [x] Pression par défaut 100 %, taille à pression nulle 10 % (v1.43.2)
- [x] Bibliothèque personnelle synchronisée entre appareils : pinceaux, gommes, réglages de trame, modèles de bulles (v1.32)

### Couleur
- [x] Couleur : calques RVBA par case, PDF en couleur (v1.31)
- [x] Deux couleurs entre les curseurs, échange (X), noir et blanc (D) (v1.36)
- [x] Palette : nuances, code hex, couleurs récentes, pipette (v1.36)
- [x] Pipette par appui long d'un doigt sur le dessin (v1.37)
- [x] Palettes nommées par projet, harmonies (v1.37)
- [x] La couleur s'applique à tous les outils sauf la gomme (v1.34)
- [x] ColorDrop : tirer la couleur principale dans une zone fermée (v1.41)

### Planche, cases et pages
- [x] Mode case : ouvrir une case seule (double toucher), passer à la voisine (v1.30)
- [x] Deux niveaux : la planche (cases, pages) et la case ouverte (dessin) (v1.38)
- [x] Bulles et textes liés à leur case (v1.33)
- [x] Navigation page / case en tête du volet de droite (v1.50)
- [x] Bouton « Fusionner » des cases utilisable au doigt et sur son étiquette (v1.50.2)

### Calques
- [x] Volet Calques simplifié, ordre changé à la poignée (v1.39.2)
- [x] Calque de référence (remplissage et ColorDrop), alpha verrouillé (v1.41)
- [x] Calques tous pareils : chaque outil dessine dans le calque actif (v1.42)
- [x] Conseil d'encrage : colorier sur l'encrage propose de déplacer le trait dans un calque dessous (v1.43)
- [x] Volet de droite à trois états : complet, réduit (vignettes), masqué (v1.44)
- [x] Options du calque au toucher, modes de fusion, message avec Annuler pour chaque action (v1.45)
- [x] Réordonner en direct, avec animation (v1.45.1), aussi dans le volet réduit ; vignette d'aperçu par calque (v1.47.1)
- [x] Volet réduit : options du calque dans une fenêtre à côté (v1.48)

### Bulles
- [x] Outil Bulle sur iPad : toucher à côté termine la saisie, bouton ✓ (v1.45)
- [x] Narration : marge au bord de la case, appliquée à tout le projet (v1.46)
- [x] Taille toujours automatique, le coin règle la largeur des lignes ; marge intérieure (v1.47)
- [x] Bulles manipulables au doigt même quand on dessine au stylet (v1.48.1)

### Sélection
- [x] Miroirs, quarts de tour, agrandir / réduire le contenu (v1.49)
- [x] Couper, copier, coller dans un nouveau calque (Ctrl+X / C / V, menu Édition) (v1.49)
- [x] Remplir la sélection, agrandir / rétrécir la sélection (v1.49)

### Gestes et interface
- [x] Frotter à trois doigts vide le calque sans faire tourner la page (v1.43.1)
- [x] Curseurs redessinés dans toute l'app (bouton aux deux bouts) ; boutons longs à la ligne (v1.47.2)
- [x] Info-bulles au long appui : titre, raccourci, description (v1.50)
- [x] Traits hachés au stylet rapide : points en retard ignorés (v1.50.1)

### Labo
- [x] Groupes Dessin, Couleur, Planche (v1.40) et Calques, sujets Curseurs, Taille des bulles, Narration au bord (v1.48)

### Impression
- [x] Imprimer directement (AirPrint), choix des pages, brouillons et bulles inclus ou non (v1.51)
- [x] Rendu bleu non photo pour encrer sur papier (v1.51)
- [x] Mise en page : planches en regard, livret à plier, 4 pages par feuille (v1.52)

### Synchronisation entre appareils
- [x] Mise en service : Supabase (tables, SMTP Gmail, modèles d'email avec code), connexion sur ordinateur et iPad — vérifiée le 23 novembre
- [x] Adresse Supabase collée avec un chemin corrigée toute seule (v1.52.1)
- [x] Connexion par le lien de l'email collé, ou par le code à 6 chiffres (v1.52.2)
- [x] Aperçu des projets synchronisé : visible sur l'accueil de tous les appareils (v1.52.3)

### Dessin, album, conventions (v1.53)
- [x] Symétrie : dessin en miroir autour du centre de la case (vertical, horizontal, deux axes) ; pinceau, gomme, formes
- [x] Numéros de page : position (bas centre, bas extérieur, haut extérieur), premier numéro, couverture sans numéro
- [x] Écran de chargement (règle du 14 novembre) ; échec de chargement affiché avec « Recharger »
- [x] `schemaVersion` : projets (2) et sauvegardes JSON (2), anciens formats migrés, sauvegarde plus récente refusée

### Guides et album (v1.54)
- [x] Règle : traits parallèles à la règle, collés à son bord quand on part tout près ; poignées aux bouts et au milieu
- [x] Perspective à 1 point (vers le point de fuite, horizontales, verticales) et à 2 points (vers l'un des deux, verticales), ligne d'horizon
- [x] Couverture : page en tête à fond perdu, titre du projet, jamais numérotée
- [x] Chemin de fer : vignettes de toutes les pages, ouverture au toucher, ordre changé à la poignée (annulable)

### Impression pour l'imprimeur (v1.55)
- [x] Couleur au choix : automatique, noir et blanc 1 bit (gris et couleurs tramés), niveaux de gris 8 bits, RVB, CMJN (gris et noir en K seul)
- [x] Alerte sur les trames trop fines (points isolés d'un pixel à plus de 254 dpi), avec les pages concernées
- [x] Fond perdu 3 mm (bords étirés), TrimBox / BleedBox, traits de coupe (une page par feuille)
- [x] Lettrage net (v1.56) : bulles et textes en deux masques 1 bit à 1200 dpi (fond blanc, encre) au-dessus de l'image de la page
- [x] CMJN visé PDF/X-1a (v1.56) : intention de sortie FOGRA39 (condition enregistrée, sans profil ICC joint), TrimBox sur chaque feuille, identifiant, Trapped

## Reste à faire

### À vérifier sur iPad
- [ ] Symétrie au stylet (pinceaux à grain, gomme) et numéros de page à l'impression
- [ ] Règle et perspective au stylet : poignées faciles à attraper, trait qui part dans la bonne direction ; chemin de fer : glisser à la poignée au doigt
- [ ] Traits hachés et dédoublés au stylet rapide : confirmer que le correctif v1.50.1 suffit (sinon : noter pinceau, zoom, rotation)
- [ ] Info-bulles au long appui : pas de conflit avec le menu de Safari ni avec les gestes existants
- [ ] Bulles et Taille des cases au doigt pendant qu'on dessine au stylet
- [ ] Sélection : transformations, couper / copier / coller, remplir

### À faire par toi
- Rien en attente. Pour un nouvel appareil : Réglages → URL et clé anon du projet Supabase, puis email et code.

### À vérifier de bout en bout
- [ ] Objectif v1.0 : page de 4 cases sur iPad → reprise sur un autre appareil (synchronisation vérifiée) → PDF imprimé

### Impression (suite)
- [ ] Lettrage aussi net à l'impression directe (AirPrint : aujourd'hui à la résolution de la page)
- [ ] PDF/X-1a : choisir le profil de l'imprimeur (aujourd'hui FOGRA39 fixe) ; conversion CMJN simple, sans profil ICC
- [ ] Fond perdu dessiné : laisser dessiner jusqu'à 3 mm hors de la page dans les cases qui touchent le bord (aujourd'hui les bords sont étirés)

### À vérifier sur iPad (impression)
- [ ] Imprimer par AirPrint depuis Safari et depuis l'app installée : format de page respecté, une page par feuille
- [ ] PDF imprimeur (CMJN, fond perdu) : le faire valider par un imprimeur ou dans Acrobat (contrôle en amont)
- [ ] Livret : sens de retournement recto verso (bord court) sur une vraie imprimante

### Améliorations possibles
- [ ] Guides : ellipses en perspective, perspective à 3 points, grille isométrique ; guides appliqués à l'outil Forme
- [ ] Labo : ajouter les options de sélection, les info-bulles et la navigation dans le volet
- [ ] Sélection : presse-papiers partagé entre onglets ou appareils (aujourd'hui interne à l'app) ; coller en rectangle plutôt qu'en forme du dessin
- [ ] Info-bulles : couvrir les curseurs de taille et d'opacité (leur appui long pose déjà un repère) et compléter les explications des éléments qui n'ont que leur libellé
