g() {
  local msg="$*"

  if [ -z "$msg" ]; then
    echo "Bitte Commit-Text angeben."
    echo "Beispiel: g Fix planner layout"
    return 1
  fi

  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "Du bist in keinem Git-Repository."
    return 1
  fi

  local branch
  branch="$(git branch --show-current)"

  if [ -z "$branch" ]; then
    echo "Konnte aktuellen Branch nicht ermitteln."
    return 1
  fi

  git add -A || return 1

  if git diff --cached --quiet; then
    echo "Keine Änderungen zum Committen."
    return 1
  fi

  git commit -m "$msg" || return 1

  if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
    git push || return 1
  else
    git push -u origin "$branch" || return 1
  fi

  echo "Fertig: add + commit + push"
}