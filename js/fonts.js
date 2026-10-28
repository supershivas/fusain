// Polices des bulles : une sélection Google Fonts (chargées par la feuille de index.html) et les polices
// importées par l'utilisateur (gardées dans IndexedDB sur cet appareil seulement).
import { kvGet, kvSet } from './store.js';

const f = (id, name, family, weight, group) => ({ id, name, family, weight, group });
export const FONTS = [
  f('inter', 'Inter (neutre)', 'Inter', 600, 'Neutres'),
  f('comicneue', 'Comic Neue', 'Comic Neue', 700, 'Bande dessinée'),
  f('patrickhandsc', 'Patrick Hand SC (capitales à la main)', 'Patrick Hand SC', 400, 'Bande dessinée'),
  f('patrickhand', 'Patrick Hand', 'Patrick Hand', 400, 'Bande dessinée'),
  f('architects', 'Architects Daughter', 'Architects Daughter', 400, 'Bande dessinée'),
  f('kalam', 'Kalam', 'Kalam', 700, 'Bande dessinée'),
  f('schoolbell', 'Schoolbell', 'Schoolbell', 400, 'Bande dessinée'),
  f('shortstack', 'Short Stack', 'Short Stack', 400, 'Bande dessinée'),
  f('comingsoon', 'Coming Soon', 'Coming Soon', 400, 'Bande dessinée'),
  f('bangers', 'Bangers (cris, action)', 'Bangers', 400, 'Cris et action'),
  f('londrina', 'Londrina Solid', 'Londrina Solid', 900, 'Cris et action'),
  f('luckiest', 'Luckiest Guy', 'Luckiest Guy', 400, 'Cris et action'),
  f('boogaloo', 'Boogaloo', 'Boogaloo', 400, 'Cris et action'),
  f('chewy', 'Chewy', 'Chewy', 400, 'Cris et action'),
  f('caveat', 'Caveat', 'Caveat', 700, 'Écritures à la main'),
  f('gloria', 'Gloria Hallelujah', 'Gloria Hallelujah', 400, 'Écritures à la main'),
  f('indie', 'Indie Flower', 'Indie Flower', 400, 'Écritures à la main'),
  f('shadows', 'Shadows Into Light', 'Shadows Into Light', 400, 'Écritures à la main'),
  f('gochi', 'Gochi Hand', 'Gochi Hand', 400, 'Écritures à la main'),
  f('reenie', 'Reenie Beanie', 'Reenie Beanie', 400, 'Écritures à la main'),
  f('covered', 'Covered By Your Grace', 'Covered By Your Grace', 400, 'Écritures à la main'),
  f('nanum', 'Nanum Pen Script', 'Nanum Pen Script', 400, 'Écritures à la main'),
  f('marker', 'Permanent Marker', 'Permanent Marker', 400, 'Écritures à la main'),
  f('rocksalt', 'Rock Salt', 'Rock Salt', 400, 'Écritures à la main'),
  f('amatic', 'Amatic SC', 'Amatic SC', 700, 'Écritures à la main'),
  f('special', 'Special Elite (machine à écrire)', 'Special Elite', 400, 'Narration'),
];

export const DEFAULT_FONT = 'comicneue';
const byId = id => FONTS.find(x => x.id === id) || FONTS.find(x => x.id === DEFAULT_FONT);

// Valeur CSS `font` d'une police à la taille donnée (en pixels).
export const fontSpec = (id, px) => {
  const ft = byId(id);
  return `${ft.weight} ${px.toFixed(1)}px "${ft.family}", 'Comic Sans MS', sans-serif`;
};

const asked = new Set();
// Lance le chargement de la police ; la page se redessine quand le navigateur l'a reçue (`loadingdone`).
export function touchFont(id) {
  if (asked.has(id) || !document.fonts) return;
  asked.add(id);
  document.fonts.load(fontSpec(id, 20), 'AÀbé').catch(() => {});
}
export const loadFont = id => (document.fonts ? document.fonts.load(fontSpec(id, 20), 'AÀbé').catch(() => []) : Promise.resolve());

// ───────────────────────── Polices importées ─────────────────────────

export async function loadImportedFonts() {
  const list = (await kvGet('fonts')) || [];
  for (const it of list) await register(it.id, it.name, await kvGet('font:' + it.id));
}

async function register(id, name, buffer) {
  if (!buffer) return;
  const family = 'Perso ' + id;
  try {
    const face = new FontFace(family, buffer);
    await face.load();
    document.fonts.add(face);
    if (!FONTS.some(x => x.id === id)) FONTS.push(f(id, name, family, 400, 'Importées'));
  } catch { /* fichier illisible : on l'ignore */ }
}

export async function importFont(file) {
  const id = 'perso-' + Math.random().toString(36).slice(2, 8);
  const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40);
  const buffer = await file.arrayBuffer();
  await register(id, name, buffer);
  if (!FONTS.some(x => x.id === id)) throw new Error('Cette police n\'a pas pu être lue.');
  await kvSet('font:' + id, buffer);
  await kvSet('fonts', [...((await kvGet('fonts')) || []), { id, name }]);
  return id;
}

export const fontName = id => byId(id).name;
