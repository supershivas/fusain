#!/bin/sh
# Récupère depuis supershivas/design-system :
#   - design-tokens.json -> ./design-tokens.json
#   - CONVENTIONS.md     -> ./.claude/conventions.md
#   - mobile.css, phone-frame.js et app-update.js -> mis à jour là où l'app en a déjà une
#     copie (racine, app/, css/, js/, public/ ou src/). Pour adopter un de
#     ces fichiers, copie-le une fois à l'endroit voulu ; il suivra ensuite.
# Lancé par le hook SessionStart (.claude/settings.json).
# Chaque fichier est téléchargé dans un fichier temporaire puis déplacé :
# si le réseau échoue, l'ancienne copie est conservée.
# Ne sort jamais en erreur, pour ne pas bloquer la session.

BASE_URL="https://raw.githubusercontent.com/supershivas/design-system/main"

cd "$(dirname "$0")/.." 2>/dev/null || exit 0

fetch() {
  src="$1"
  dest="$2"
  mkdir -p "$(dirname "$dest")" 2>/dev/null || return 0
  tmp="$dest.tmp.$$"
  if curl -fsSL --max-time 15 "$BASE_URL/$src" -o "$tmp" 2>/dev/null && [ -s "$tmp" ]; then
    mv "$tmp" "$dest" && echo "design-system : $dest à jour"
  else
    rm -f "$tmp"
    echo "design-system : échec du téléchargement de $src, copie existante conservée" >&2
  fi
}

fetch design-tokens.json design-tokens.json
fetch CONVENTIONS.md .claude/conventions.md

for file in mobile.css phone-frame.js app-update.js; do
  for dir in . app css js public src; do
    [ -f "$dir/$file" ] && fetch "$file" "$dir/$file"
  done
done

exit 0
