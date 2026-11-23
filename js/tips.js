// Info-bulles au long appui (doigt, stylet ou souris) : titre, description et raccourci de l'élément touché.
// Le texte vient d'abord du dictionnaire TIPS (clé « attribut:valeur » d'un data-*), sinon du title / aria-label de l'élément.
// Les éléments qui ont déjà leur propre appui long (palette, couleurs, curseurs à repères, dessin) ne sont pas concernés.

const HOLD_MS = 520, SLOP = 9;

// [titre, description]
const TIPS = {
  // ── Outils ──
  'tool:pencil': ['Pinceaux et trames', 'Dessine dans le calque actif. La trame est un réglage du pinceau : encre pleine ou trame, dans la couleur principale.'],
  'tool:eraser': ['Gomme', 'Efface dans le calque actif avec le moteur des pinceaux. Le bout gomme du stylet gomme le temps d\'un trait.'],
  'tool:fill': ['Remplir', 'Remplit une zone fermée, même si le contour a de petits trous. Le remplissage ne voit que les traits des calques de référence.'],
  'tool:shape': ['Formes', 'Trace une ligne, un rectangle ou une ellipse. Toucher l\'outil une seconde fois change de forme.'],
  'tool:mask': ['Masque', 'Peint un masque qui protège une partie de la case : les traits n\'y entrent pas (ou n\'entrent que là).'],
  'tool:select': ['Sélection', 'Choisis une zone pour la déplacer, la transformer, la copier, la remplir ou l\'effacer.'],
  'tool:bubble': ['Bulles', 'Pose une bulle du modèle choisi d\'un toucher dans la case ; touche une bulle pour la modifier.'],
  'tool:layout': ['Taille des cases', 'Fais glisser les gouttières, ajoute une case avec les « + », fusionne deux cases voisines.'],
  'tool:pan': ['Déplacer la vue', 'Fait glisser la page sans dessiner ; un toucher change de case.'],
  // ── Barres ──
  'act:add-gradmap': ['Carte de dégradé', 'Calque de réglage, comme dans Photoshop : la luminosité de tout ce qui est dessous devient une couleur du dégradé (sombre = début, clair = fin).'],
  'act:grad-preset': ['Modèle de dégradé', 'Remplace le dégradé par ce modèle ; on peut ensuite retoucher chaque arrêt.'],
  'act:grad-add': ['Ajouter un arrêt', 'Ajoute une couleur au milieu du plus grand écart du dégradé.'],
  'act:grad-del': ['Retirer l\'arrêt', 'Retire cette couleur du dégradé (il en garde au moins deux).'],
  'act:grad-reverse': ['Inverser', 'Retourne le dégradé : les ombres prennent les couleurs des lumières.'],
  'sym': ['Symétrie', 'Dessine en miroir autour du centre de la case. Chaque toucher change : aucune, axe vertical, axe horizontal, deux axes.'],
  'guide': ['Guides de tracé', 'Règle, perspective à 1, 2 ou 3 points de fuite, grille isométrique : les traits se calent sur la direction la plus proche. Fais glisser les poignées pour placer les guides.'],
  'act:symmetry': ['Symétrie', 'Dessin en miroir autour du centre de la case ; chaque choix passe au mode suivant.'],
  'act:guide': ['Guides de tracé', 'Passe d\'aucun guide à la règle, à la perspective à 1, 2 et 3 points, puis à la grille isométrique.'],
  'act:folio': ['Numéros de page', 'Numérote les pages dans la marge : position, premier numéro, couverture sans numéro.'],
  'act:add-cover': ['Couverture', 'Ajoute en tête une page à fond perdu avec le titre du projet, jamais numérotée.'],
  'act:pages-board': ['Chemin de fer', 'Toutes les pages en vignettes : toucher en ouvre une, la poignée la déplace.'],
  'bopen': ['Ouvrir la page', 'Ferme le chemin de fer et ouvre cette page.'],
  'bgrip': ['Déplacer la page', 'Fais glisser pour changer la place de la page dans l\'album.'],
  'act:undo': ['Annuler', 'Défait la dernière action. Toucher à deux doigts fait la même chose.'],
  'act:redo': ['Rétablir', 'Refait l\'action annulée. Toucher à trois doigts fait la même chose.'],
  'act:dock': ['Panneau de droite', 'Affiche ou réduit le panneau des calques et des pages.'],
  'z:focus': ['Ouvrir la case', 'La case active devient le seul canevas : on y dessine, ses calques sont dans le panneau. Double toucher sur une case fait de même.'],
  'z:page': ['Revenir à la planche', 'Quitte la case pour voir la page entière : pages, taille des cases, notes. Double toucher fait de même.'],
  'z:pcase': ['Case précédente', 'Ouvre la case d\'avant, dans l\'ordre de lecture.'],
  'z:ncase': ['Case suivante', 'Ouvre la case d\'après, dans l\'ordre de lecture.'],
  'z:prev': ['Page précédente', 'Passe à la page d\'avant.'],
  'z:next': ['Page suivante', 'Passe à la page d\'après.'],
  'z:in': ['Zoom avant', 'Agrandit la vue. On peut aussi écarter deux doigts.'],
  'z:out': ['Zoom arrière', 'Réduit la vue. On peut aussi pincer deux doigts.'],
  'z:fit': ['Ajuster à l\'écran', 'Montre la page (ou la case ouverte) en entier et la remet droite. Touche 0.'],
  'openfocus': ['Dessiner dans la case', 'Ouvre la case active pour y dessiner.'],
  // ── Couleurs ──
  'cw:open': ['Couleur principale', 'Toucher : ouvre la palette. Tirer la pastille sur le dessin : remplit la zone de cette couleur (ColorDrop).'],
  'cw:swap': ['Échanger les couleurs', 'La couleur secondaire devient la principale, et inversement. Touche X.'],
  'cw:reset': ['Noir et blanc', 'Remet le noir en couleur principale et le blanc en secondaire. Touche D.'],
  'act:color-add': ['Ajouter à la palette', 'Range la couleur principale dans la palette du projet.'],
  'act:pick-color': ['Pipette', 'Touche le dessin pour prendre sa couleur. Un appui long immobile sur le dessin fait de même.'],
  'act:pal-new': ['Nouvelle palette', 'Crée une palette vide dans ce projet.'],
  'act:pal-rename': ['Renommer la palette', 'Change le nom de la palette affichée.'],
  'act:pal-del': ['Supprimer la palette', 'Retire cette palette du projet.'],
  'palid': ['Palette', 'Affiche cette palette du projet.'],
  'hsv:sv': ['Saturation et luminosité', 'Glisse pour régler la saturation (horizontal) et la luminosité (vertical).'],
  'hsv:h': ['Teinte', 'Glisse pour choisir la teinte.'],
  // ── Pinceaux et trames ──
  'pop:lib-brush': ['Bibliothèque de pinceaux', 'Choisis un pinceau livré ou un des tiens ; il entre dans la palette du projet.'],
  'pop:lib-trama': ['Trame', 'Choisis l\'encre pleine ou une trame pour le pinceau.'],
  'pop:lib-bubble': ['Modèle de bulle', 'Choisis le modèle posé par le prochain toucher dans la case.'],
  'pop:brush': ['Réglages du pinceau', 'Trait, trame, forme, texture, dynamique : tout le pinceau dans une seule fenêtre.'],
  'pal': ['Réglages du pinceau', 'Ouvre les réglages du pinceau actif.'],
  'act:brush-save': ['Enregistrer le pinceau', 'Range ce pinceau dans « Mes pinceaux », pour tous tes projets.'],
  'act:brush-update': ['Mettre à jour', 'Remplace le pinceau enregistré par ces réglages.'],
  'act:brush-reset': ['Revenir au pinceau d\'origine', 'Annule les retouches faites sur ce pinceau.'],
  'act:brush-del': ['Supprimer le pinceau', 'Retire ce pinceau de « Mes pinceaux ».'],
  'act:slot-left': ['Vers la gauche', 'Déplace ce pinceau d\'une place dans la palette.'],
  'act:slot-right': ['Vers la droite', 'Déplace ce pinceau d\'une place dans la palette.'],
  'act:slot-rename': ['Renommer', 'Change le nom de ce pinceau de la palette.'],
  'act:slot-remove': ['Retirer de la palette', 'Enlève ce pinceau de la palette du projet (il reste dans la bibliothèque).'],
  'act:tpreset-save': ['Enregistrer ces réglages de trame', 'Garde la trame, son échelle et son opacité pour les retrouver d\'un toucher.'],
  'act:new-trame': ['Nouvelle trame', 'Dessine ta propre tuile de trame pour ce projet.'],
  'act:edit-trame': ['Modifier la trame', 'Ouvre la tuile de cette trame pour la retoucher.'],
  'act:del-trame': ['Supprimer la trame', 'Retire cette trame personnalisée du projet.'],
  'act:pop-close': ['Fermer', 'Referme cette fenêtre.'],
  'bprev': ['Aperçu du pinceau', 'Le trait tel qu\'il sortira, avec la trame, l\'opacité et la couleur.'],
  // ── Formes, masque, remplissage ──
  'shape:line': ['Ligne', 'Trace un trait droit entre deux points.'],
  'shape:rect': ['Rectangle', 'Trace un rectangle d\'un coin à l\'autre.'],
  'shape:ellipse': ['Ellipse', 'Trace une ellipse dans le rectangle tiré.'],
  'mask:off': ['Sans masque', 'Le masque est ignoré : on dessine partout dans la case.'],
  'mask:in': ['Dessiner dedans', 'Les traits ne se posent que dans la zone du masque.'],
  'mask:out': ['Dessiner dehors', 'Le masque protège sa zone : les traits n\'y entrent pas.'],
  'maskpen:0': ['Peindre le masque', 'Ajoute à la zone du masque.'],
  'maskpen:1': ['Effacer le masque', 'Retire de la zone du masque.'],
  'act:mask-invert': ['Inverser le masque', 'Ce qui était masqué ne l\'est plus, et inversement.'],
  'act:mask-clear': ['Vider le masque', 'Supprime toute la zone du masque de cette case.'],
  // ── Sélection ──
  'selmode:auto': ['Sélection automatique', 'Touche une zone fermée : elle est sélectionnée comme le ferait le seau.'],
  'selmode:free': ['Main levée', 'Entoure la zone au doigt ou au stylet.'],
  'selmode:poly': ['Polygone', 'Touche les sommets un à un, puis valide.'],
  'selmode:rect': ['Rectangle', 'Tire un rectangle.'],
  'selmode:ellipse': ['Ellipse', 'Tire une ellipse.'],
  'selop:new': ['Nouvelle sélection', 'Remplace la sélection actuelle.'],
  'selop:add': ['Ajouter', 'Ajoute la nouvelle zone à la sélection.'],
  'selop:sub': ['Retirer', 'Retire la nouvelle zone de la sélection.'],
  'selact:all': ['Tout sélectionner', 'Sélectionne toute la case. Ctrl+A.'],
  'selact:invert': ['Inverser', 'Sélectionne tout ce qui ne l\'était pas.'],
  'selact:clear': ['Effacer le contenu', 'Efface les pixels sélectionnés dans les calques visés.'],
  'selact:none': ['Désélectionner', 'Retire la sélection. Échap.'],
  'selact:grow': ['Agrandir la sélection', 'Élargit la sélection de 0,5 mm tout autour.'],
  'selact:shrink': ['Rétrécir la sélection', 'Resserre la sélection de 0,5 mm tout autour.'],
  'selact:cut': ['Couper', 'Copie le calque actif sous la sélection, puis l\'efface. Ctrl+X.'],
  'selact:copyclip': ['Copier', 'Copie le calque actif sous la sélection (toute la case sans sélection). Ctrl+C.'],
  'selact:paste': ['Coller', 'Colle dans un nouveau calque « Collage », au même endroit, prêt à être déplacé. Ctrl+V.'],
  'selact:fill': ['Remplir la sélection', 'Remplit la sélection dans le calque actif, avec la couleur et la trame du pinceau.'],
  'selact:polyok': ['Valider le polygone', 'Ferme le polygone et en fait la sélection.'],
  'selact:polycancel': ['Abandonner le polygone', 'Efface les sommets posés.'],
  'seltf:flipH': ['Miroir horizontal', 'Retourne le contenu sélectionné de gauche à droite (sans sélection : toute la case).'],
  'seltf:flipV': ['Miroir vertical', 'Retourne le contenu sélectionné de haut en bas (sans sélection : toute la case).'],
  'seltf:rotCW': ['Quart de tour à droite', 'Tourne le contenu sélectionné de 90° autour de son centre.'],
  'seltf:rotCCW': ['Quart de tour à gauche', 'Tourne le contenu sélectionné de 90° dans l\'autre sens.'],
  // ── Bulles ──
  'freebubble:0': ['Bulle du modèle', 'Un toucher dans la case pose une bulle du modèle choisi.'],
  'freebubble:1': ['Bulle à main levée', 'Dessine toi-même le contour de la bulle.'],
  'bf:text': ['Écrire', 'Ouvre la saisie du texte, posée sur la bulle ; ✓ ou un toucher sur le dessin la termine.'],
  'bf:shape': ['Changer de forme', 'Ellipse, rectangle, nuage, éclair : chaque toucher passe à la suivante.'],
  'bf:tail': ['Queue', 'Montre ou cache la queue ; sa position est retenue.'],
  'bf:tab-text': ['Réglages du texte', 'Police, corps, alignement et casse du texte.'],
  'bf:tab-shape': ['Réglages de la forme', 'Modèle, contour, marges intérieure et au bord, trait.'],
  'bf:tab-tail': ['Réglages de la queue', 'Forme, largeur et courbure de la queue.'],
  'bf:dup': ['Dupliquer la bulle', 'Pose une copie de la bulle juste à côté.'],
  'bf:del': ['Supprimer la bulle', 'Retire la bulle (Annuler la rétablit).'],
  'act:tpl-save': ['Enregistrer le modèle', 'Range le style de cette bulle dans « Mes modèles ».'],
  'act:edge-all': ['Appliquer à toutes les narrations', 'Donne ces marges à toutes les narrations du projet.'],
  'act:bubble-lines-all': ['Appliquer à toutes les bulles', 'Copie ces réglages de trait sur toutes les bulles du projet.'],
  'act:stroke-all': ['Appliquer à toutes les bulles', 'Copie ce trait sur toutes les bulles du projet.'],
  'act:reseed': ['Nouveau tirage', 'Redessine les imperfections du contour autrement.'],
  'act:pick-font': ['Police', 'Choisis la police du texte de la bulle.'],
  'act:talign': ['Alignement', 'Aligne le texte à gauche, au centre ou à droite.'],
  'act:pt-': ['Plus petit', 'Diminue le corps du texte.'],
  'act:pt+': ['Plus grand', 'Augmente le corps du texte.'],
  'act:bub-select': ['Choisir la bulle', 'Sélectionne cette bulle sur le dessin.'],
  'act:bub-vis': ['Afficher / masquer', 'Une bulle masquée n\'est pas exportée.'],
  'act:bub-lock': ['Verrouiller la bulle', 'Une bulle verrouillée ne bouge plus au toucher.'],
  'act:bub-del': ['Supprimer la bulle', 'Retire la bulle (Annuler la rétablit).'],
  'act:bubs-vis': ['Bulles de la page', 'Montre ou cache toutes les bulles de la page ; masquées, elles ne sont pas exportées.'],
  'act:swipe-bub-dup': ['Dupliquer la bulle', 'Pose une copie de la bulle juste à côté.'],
  'act:swipe-bub-del': ['Supprimer la bulle', 'Retire la bulle (Annuler la rétablit).'],
  // ── Calques ──
  'act:select-layer': ['Calque', 'Toucher : rend le calque actif. Toucher le calque actif : ses options. Tirer : change l\'ordre.'],
  'act:vis': ['Afficher / masquer', 'Montre ou cache ce calque.'],
  'act:add-layer': ['Nouveau calque', 'Ajoute un calque au-dessus du calque actif.'],
  'act:add-ink': ['Nouveau calque', 'Ajoute un calque au-dessus du calque actif.'],
  'act:add-draft': ['Nouveau brouillon', 'Un calque de crayonné en couleur, jamais exporté.'],
  'act:rename': ['Renommer', 'Change le nom du calque.'],
  'act:dup-layer': ['Dupliquer', 'Copie le calque juste au-dessus.'],
  'act:merge': ['Fusionner', 'Fond ce calque dans celui du dessous.'],
  'act:clear': ['Vider', 'Efface tout le contenu du calque (Annuler le rétablit). Trois doigts qui frottent font de même.'],
  'act:del-layer': ['Supprimer', 'Retire le calque (Annuler le rétablit).'],
  'act:lock': ['Verrouiller', 'Un calque verrouillé ne reçoit plus de trait.'],
  'act:tint-reset': ['Retirer la teinte', 'Rend au calque son encre noire.'],
  'act:mini-opts-close': ['Fermer', 'Referme les options du calque.'],
  'act:swipe-dup': ['Dupliquer', 'Copie le calque juste au-dessus.'],
  'act:swipe-del': ['Supprimer', 'Retire le calque (Annuler le rétablit).'],
  'prop:reference': ['Référence', 'Le remplissage et ColorDrop ne voient que les traits des calques de référence visibles.'],
  'prop:alphaLock': ['Alpha verrouillé', 'Seuls les pixels déjà peints changent : la transparence est gardée, la gomme n\'agit pas.'],
  'prop:draft': ['Brouillon', 'Crayonné en couleur, jamais exporté.'],
  'prop:locked': ['Verrouillé', 'Le calque ne reçoit plus de trait.'],
  'prop:solo': ['Afficher seul', 'Cache les autres calques le temps de travailler celui-ci.'],
  'grip': ['Réordonner', 'Tire la poignée vers le haut ou le bas pour changer la place du calque.'],
  'lcolor': ['Couleur du brouillon', 'Teinte du crayonné à l\'écran.'],
  // ── Pages, cases ──
  'act:add-page': ['Nouvelle page', 'Ajoute une page avec la disposition choisie.'],
  'act:dup-page': ['Dupliquer la page', 'Copie la page avec ses cases, ses calques et ses bulles.'],
  'act:del-page': ['Supprimer la page', 'Retire la page (Annuler la rétablit).'],
  'act:page-left': ['Reculer la page', 'Avance la page d\'une place vers le début.'],
  'act:page-right': ['Avancer la page', 'Recule la page d\'une place vers la fin.'],
  'act:export-pdf': ['Exporter en PDF', 'Toutes les pages en PDF à 300 dpi, prêtes à imprimer.'],
  'act:relayout': ['Disposition des cases', 'Remplace la grille des cases de cette page.'],
  'act:copy-case': ['Copier la case', 'Copie le dessin et les bulles de la case vers une autre case.'],
  'act:dither': ['Image tramée', 'Importe une photo et la convertit en trame noir et blanc dans un calque.'],
  'mpage': ['Page', 'Ouvre cette page.'],
  'page': ['Page', 'Ouvre cette page.'],
  'merge': ['Fusionner les cases', 'Cette case absorbe la case voisine.'],
  'split': ['Ajouter une case', 'Coupe la case de ce côté.'],
  'delpanel': ['Supprimer la case', 'Retire la case et ses bulles (Annuler les rétablit).'],
  'layout': ['Disposition', 'Grille de cases de la page.'],
  // ── Panneau ──
  'act:foot-fs': ['Plein écran', 'Masque la barre du navigateur pour dessiner sur tout l\'écran.'],
  'act:foot-dock': ['Masquer le panneau', 'Rend toute la largeur au dessin.'],
  'act:dock-mini': ['Réduire le panneau', 'Ne garde qu\'une colonne de vignettes des calques.'],
  'act:dock-full': ['Agrandir le panneau', 'Montre toutes les options des calques et des pages.'],
  'act:dock-hide': ['Masquer le panneau', 'Rend toute la largeur au dessin ; un bouton au coin le rappelle.'],
  // ── En-tête, exports ──
  'menu': ['Menu', 'Toutes les commandes de l\'app, rangées par thème.'],
  'm:png': ['PNG', 'Exporte la page en image.'],
  'm:pdf': ['PDF', 'Exporte le projet en PDF.'],
  'm:json': ['Sauvegarde JSON', 'Le projet entier dans un fichier, pour le réimporter.'],
};
// Sections du panneau (data-sec)
const SECS = {
  pf: ['Numéros de page', 'Numéros imprimés dans la marge, pour tout le projet.'],
  bubs: ['Bulles et textes', 'Les bulles de la case ouverte : choisir, masquer, verrouiller, supprimer.'],
  lays: ['Calques', 'Les calques de la case, le plus haut en premier. Toucher le calque actif ouvre ses options.'],
  cn: ['Notes de la case', 'Plan et description à dessiner, venus du découpage ; jamais exportés.'],
  cf: ['Cadre', 'Épaisseur et style du trait qui entoure la case.'],
  cx: ['Copie', 'Copier le contenu de la case vers une autre.'],
  cm: ['Masque', 'Zone qui protège une partie de la case des traits.'],
  ci: ['Image tramée', 'Une photo convertie en trame noir et blanc, dans un calque.'],
  btpl: ['Mes modèles', 'Les styles de bulle que tu as enregistrés.'],
  trpre: ['Mes réglages', 'Tes réglages de trame enregistrés.'],
};

const SKIP = '#view, .qs, .slot, .brush-row, .cswatch, .grip, input[type=text], input[type=search], input[type=number], textarea, [contenteditable], .bedit, .tip';
const TARGET = 'button, [role=button], [role=slider], [role=menuitem], summary, select, input[type=range], input[type=checkbox], label, .mini-page, a';

let tip = null, timer = null, start = null, swallow = false, shownFor = null;

const clean = s => (s || '').replace(/\s+/g, ' ').trim();
// « Annuler (Ctrl+Z) » → titre « Annuler », raccourci « Ctrl+Z »
function splitKey(s) {
  const m = /\s*\(((?:Ctrl|Maj|Alt|⌘)[^)]*|[A-Z0-9]|Entrée|Échap|Suppr)\)\s*$/.exec(s);
  return m ? [s.slice(0, m.index), m[1]] : [s, ''];
}

export function tipFor(el) {
  let t = null;
  if (el.dataset.tip) { const [a, b] = el.dataset.tip.split('|'); t = [a, b || '']; }
  if (!t && el.dataset.cmd) {
    const c = el.dataset.cmd;
    t = TIPS['cmd:' + c] || TIPS[c.startsWith('tool:') ? c : 'act:' + c] || TIPS['z:' + c];
    if (t) t = [clean(el.querySelector('span')?.textContent) || t[0], t[1]];
  }
  if (!t) for (const [k, v] of Object.entries(el.dataset)) { t = TIPS[`${k}:${v}`] || TIPS[k]; if (t) break; }
  if (!t && el.tagName === 'SUMMARY') {
    const id = el.parentElement?.dataset.sec || '';
    t = SECS[id] || (id.startsWith('bg-') ? ['Groupe de pinceaux', 'Touche un pinceau pour le prendre ; il entre dans la palette du projet.'] : id.startsWith('tg-') ? ['Groupe de trames', 'Touche une trame pour l\'appliquer au pinceau.'] : null);
    if (t) t = [clean(el.textContent) || t[0], t[1]];
  }
  const raw = clean(el.getAttribute('title') || el.getAttribute('aria-label') || (el.tagName === 'INPUT' || el.tagName === 'SELECT' ? el.closest('label, .field, .row')?.textContent : el.textContent));
  let [title, key] = splitKey(raw);
  let desc = '';
  const cut = title.indexOf(' : ');
  if (cut > 0) { desc = title.slice(cut + 3); title = title.slice(0, cut); }
  if (t) { if (!key) key = splitKey(t[1])[1]; return { title: t[0], desc: t[1], key }; }
  if (!title) return null;
  if (!desc) {   // libellé seul : on dit au moins ce que fait le geste
    const kind = el.matches('input[type=range]') ? 'Fais glisser pour régler.' : el.matches('select') ? 'Choisis une valeur dans la liste.'
      : el.matches('input[type=checkbox]') || el.getAttribute('aria-pressed') ? 'Touche pour activer ou désactiver.' : el.tagName === 'SUMMARY' ? 'Touche pour ouvrir ou refermer cette section.' : '';
    desc = kind;
  }
  if (title.length > 60) { desc = desc || title; title = title.split(/[.:(]/)[0].slice(0, 60); }
  return { title: title.charAt(0).toUpperCase() + title.slice(1), desc: desc.charAt(0).toUpperCase() + desc.slice(1), key };
}

function iconOf(el) {
  const i = el.querySelector('.ti'); if (!i) return '';
  const c = [...i.classList].find(x => x.startsWith('ti-'));
  return c ? `<span class="tip-ic"><i class="ti ${c}" aria-hidden="true"></i></span>` : '';
}
const escH = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function show(el, info) {
  if (!tip) {
    tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip');
    if ('popover' in tip) tip.popover = 'manual';
    document.body.appendChild(tip);
  }
  tip.innerHTML = `<div class="tip-head">${iconOf(el)}<b>${escH(info.title)}</b>${info.key ? `<kbd>${escH(info.key)}</kbd>` : ''}</div>${info.desc ? `<p>${escH(info.desc)}</p>` : ''}<span class="tip-arrow"></span>`;
  tip.classList.remove('in');
  try { tip.showPopover?.(); } catch { /* déjà ouverte */ }
  tip.hidden = false;
  const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight, vw = innerWidth, vh = innerHeight, gap = 10;
  let below = r.top - th - gap < 8;   // au-dessus du doigt d'abord
  let top = below ? r.bottom + gap : r.top - th - gap;
  if (below && top + th > vh - 8) top = Math.max(8, vh - th - 8);
  const cx = r.left + r.width / 2, left = Math.max(8, Math.min(vw - tw - 8, cx - tw / 2));
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
  tip.classList.toggle('below', below);
  tip.style.setProperty('--ax', Math.max(14, Math.min(tw - 14, cx - left)) + 'px');
  requestAnimationFrame(() => tip.classList.add('in'));
  shownFor = el;
}
export function hideTip() {
  if (!tip || !shownFor) return;
  tip.classList.remove('in'); shownFor = null;
  try { tip.hidePopover?.(); } catch { /* */ }
  tip.hidden = true;
}

function down(e) {
  hideTip(); clearTimeout(timer);
  if (e.button > 0) return;
  const el = e.target.closest?.(TARGET);
  if (!el || e.target.closest(SKIP) || el.closest('[data-notip]')) return;
  start = { x: e.clientX, y: e.clientY, id: e.pointerId };
  timer = setTimeout(() => {
    const info = el.isConnected && tipFor(el);
    if (!info) return;
    show(el, info); swallow = true;
    navigator.vibrate?.(8);
  }, HOLD_MS);
}
function move(e) {
  if (!start || e.pointerId !== start.id) return;
  if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) { clearTimeout(timer); start = null; }
}
function up() {
  clearTimeout(timer); start = null;
  if (swallow) setTimeout(() => { swallow = false; }, 400);   // le clic qui suit le long appui ne déclenche rien
}

export function initTips() {
  document.addEventListener('pointerdown', down, true);
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', () => { clearTimeout(timer); start = null; }, true);
  document.addEventListener('input', () => clearTimeout(timer), true);
  document.addEventListener('scroll', () => { clearTimeout(timer); start = null; hideTip(); }, true);
  document.addEventListener('click', e => { if (swallow) { swallow = false; e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('contextmenu', e => { if (shownFor || timer) { if (e.target.closest?.(TARGET) && !e.target.closest(SKIP)) e.preventDefault(); } }, true);
  window.addEventListener('keydown', e => { if (e.key === 'Escape') hideTip(); });
  window.addEventListener('resize', hideTip);
}
