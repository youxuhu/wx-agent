#!/usr/bin/env bash
# Auto-push for ~/.pi/agent, guarded by a secret scan.
#
#   (no args)      scan HEAD's diff; if clean, push the current branch to origin
#   --check-only   scan HEAD's diff, never push
#   --check-diff   scan a unified diff from stdin, never push (for tests)
#
# Escape hatch: GIT_AUTO_PUSH=0 disables both the push and the scan block.
# The hook never forces: an amended/rebased history is reported, not overwritten.

set -uo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || { echo "auto-push: not a git repo"; exit 0; }
cd "$REPO_ROOT" || exit 0

MODE="${1:-push}"

# --- secret detection -------------------------------------------------------
# Patterns that should never reach a public remote. Keep this list short and
# specific: a false positive only costs one GIT_AUTO_PUSH=0 commit.
SECRET_PATTERNS=(
  'sk-[A-Za-z0-9_-]{16,}'
  'Bearer [A-Za-z0-9._-]{16,}'
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  'AKIA[0-9A-Z]{16}'
  'gh[pousr]_[A-Za-z0-9]{20,}'
  'xox[baprs]-[A-Za-z0-9-]{10,}'
  'AIza[0-9A-Za-z_-]{35}'
  '(api[_-]?key|apikey|token|secret)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_.-]{16,}["'"'"']'
)

scan_added_lines() {
  # stdin: unified diff. Report only added lines, skip +++ headers.
  local hits=0 pattern line
  while IFS= read -r line; do
    case "$line" in
      +++*|+++\ *) continue ;;
      +*) ;;
      *) continue ;;
    esac
    for pattern in "${SECRET_PATTERNS[@]}"; do
      if printf '%s\n' "$line" | grep -Eq -- "$pattern"; then
        echo "auto-push: possible secret in an added line (pattern: $pattern)"
        echo "           (content redacted)"
        hits=$((hits + 1))
        break
      fi
    done
  done
  [ "$hits" -eq 0 ]
}

scan_tracked_filenames() {
  # A forced `git add -f` can put an ignored credential file back in the index.
  local bad
  bad="$(git ls-files | grep -E '(^|/)(auth\.json|web-search\.json|\.git-credentials|\.env)$' || true)"
  if [ -n "$bad" ]; then
    echo "auto-push: tracked credential file(s) — remove from the index before pushing:"
    printf '           %s\n' $bad
    return 1
  fi
  return 0
}

run_checks() {
  local ok=1
  git diff-tree -p HEAD 2>/dev/null | scan_added_lines || ok=0
  scan_tracked_filenames || ok=0
  [ "$ok" -eq 1 ]
}

case "$MODE" in
  --check-diff)
    if scan_added_lines; then echo "auto-push: diff clean"; exit 0; else exit 1; fi
    ;;
  --check-only)
    if run_checks; then echo "auto-push: HEAD clean"; exit 0; else echo "auto-push: HEAD contains secrets"; exit 1; fi
    ;;
esac

# --- push -------------------------------------------------------------------
if [ "${GIT_AUTO_PUSH:-1}" = "0" ]; then
  echo "auto-push: GIT_AUTO_PUSH=0, skipping"
  exit 0
fi

if ! run_checks; then
  echo "auto-push: BLOCKED — HEAD was not pushed. Fix the content, then:"
  echo "           git push origin \$(git rev-parse --abbrev-ref HEAD)"
  exit 0
fi

# History-rewriting operations leave nothing safe to push automatically.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  echo "auto-push: rebase/merge in progress, skipping"
  exit 0
fi

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
case "$BRANCH" in
  ""|HEAD) echo "auto-push: detached HEAD, skipping"; exit 0 ;;
esac

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "auto-push: no origin remote, skipping"
  exit 0
fi

if ! git fetch --quiet origin "$BRANCH" 2>/dev/null; then
  echo "auto-push: cannot reach origin, skipping (commit is local)"
  exit 0
fi

UPSTREAM="origin/$BRANCH"
if git rev-parse --verify --quiet "$UPSTREAM" >/dev/null; then
  BEHIND="$(git rev-list --count "HEAD..$UPSTREAM" 2>/dev/null || echo 0)"
  if [ "${BEHIND:-0}" -gt 0 ]; then
    echo "auto-push: local is $BEHIND commit(s) behind $UPSTREAM (amended/rebased history?) — NOT force-pushing"
    echo "           resolve manually: git pull --rebase  (then push)"
    exit 0
  fi
  AHEAD="$(git rev-list --count "$UPSTREAM..HEAD" 2>/dev/null || echo 0)"
  if [ "${AHEAD:-0}" -eq 0 ]; then
    exit 0
  fi
fi

if OUT="$(git push --quiet origin "$BRANCH" 2>&1)"; then
  echo "auto-push: pushed $BRANCH → origin ($(git rev-parse --short HEAD))"
else
  echo "auto-push: push failed, commit stays local:"
  printf '%s\n' "$OUT" | sed 's/^/           /'
fi
exit 0
