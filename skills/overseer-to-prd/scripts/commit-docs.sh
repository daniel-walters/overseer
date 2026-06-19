#!/usr/bin/env bash
#
# commit-docs.sh — commit the grill's domain docs onto a PRD feature branch.
#
# Usage: commit-docs.sh <repo-path> <branch-name>
#
# Invoked once per session working dir by /overseer-to-prd after prd.md is
# written. The grill leaves the domain docs (CONTEXT.md / CONTEXT-MAP.md and
# docs/adr) edited but uncommitted in the working tree; this script lands them
# on the PRD feature branch so dispatched agents inherit them as their base.
#
# It is self-guarding (a clean no-op where there is nothing to commit) and
# idempotent (an existing branch is reused, never recreated). Only the
# domain-doc paths are committed — any unrelated work in the repo, staged or
# not, is left untouched. No runtime dependency beyond `git`.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: commit-docs.sh <repo-path> <branch-name>" >&2
  exit 2
fi

repo="$1"
branch="$2"

# 1. Not a git repo → clean no-op. The caller invokes this for every session
#    working dir, some of which may not be repos.
if ! git -C "$repo" rev-parse --git-dir >/dev/null 2>&1; then
  echo "commit-docs: $repo is not a git repo — nothing to do"
  exit 0
fi

# The domain-doc paths this script owns. The per-context nested variants
# (*/CONTEXT.md, */docs/adr) are doc paths only when this repo uses the
# multi-context layout, signalled by a CONTEXT-MAP.md at its root. The globs are
# git pathspecs (git matches `*` across `/`), kept quoted so the shell does not
# expand them before git sees them.
doc_paths=(CONTEXT.md CONTEXT-MAP.md docs/adr)
if [ -f "$repo/CONTEXT-MAP.md" ]; then
  doc_paths+=('*/CONTEXT.md' '*/docs/adr/*')
fi

# 2. Collect the pending changes under the doc paths, classifying each into
#    CONTEXT vs ADR so the commit message reflects what actually changed.
#    -c core.quotePath=false makes git emit raw UTF-8 paths so non-ASCII
#    filenames are not wrapped in C-style octal-escaped double-quoted strings.
#    Capture to a variable first so a git failure exits loudly (process
#    substitution < <(...) does not propagate exit codes under set -euo pipefail).
if ! porcelain=$(git -C "$repo" -c core.quotePath=false status --porcelain -- "${doc_paths[@]}"); then
  echo "commit-docs: failed to read git status in $repo" >&2
  exit 1
fi
context_changed=false
adr_changed=false
doc_files=()
while IFS= read -r raw_line; do
  [ -n "$raw_line" ] || continue
  # Strip the two-char XY status code and the separating space (first 3 bytes).
  path="${raw_line:3}"
  # Rename entries appear as "old -> new"; keep the new path.
  path="${path##* -> }"
  # git may still quote paths in porcelain output on older git versions even
  # with quotePath=false; strip the surrounding double-quotes defensively.
  [[ "$path" == '"'* ]] && path="${path:1:${#path}-2}"
  doc_files+=("$path")
  case "$path" in
    docs/adr/* | */docs/adr/*) adr_changed=true ;;
    *) context_changed=true ;;
  esac
done <<< "$porcelain"

# 3. No doc edits this session → no-op. No branch is created.
if [ "${#doc_files[@]}" -eq 0 ]; then
  echo "commit-docs: no pending doc changes in $repo — nothing to commit"
  exit 0
fi

# 4. Resolve the base ref the same way gitSetup.defaultBase does: origin/HEAD
#    (its refs/remotes/ prefix stripped), falling back to origin/main.
base="origin/main"
if ref=$(git -C "$repo" symbolic-ref --quiet refs/remotes/origin/HEAD 2>/dev/null); then
  resolved="${ref#refs/remotes/}"
  [ -n "$resolved" ] && base="$resolved"
fi

# 5. Ensure the feature branch exists, then check it out. An existing branch is
#    reused, never recreated (idempotent); the uncommitted doc edits carry
#    across the checkout.
if ! git -C "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
  if ! git -C "$repo" branch "$branch" "$base"; then
    echo "commit-docs: failed to create branch '$branch' from '$base' in $repo" >&2
    exit 1
  fi
fi
if ! git -C "$repo" checkout "$branch" >/dev/null; then
  echo "commit-docs: failed to check out branch '$branch' in $repo" >&2
  exit 1
fi

# 6. Stage only the doc paths, then commit only them. `git add` brings in any
#    new (untracked) doc files; `commit --only -- <paths>` commits exactly those
#    paths, so unrelated work already staged in the index is left out.
if ! git -C "$repo" add -- "${doc_files[@]}"; then
  echo "commit-docs: failed to stage doc paths in $repo" >&2
  exit 1
fi

if [ "$context_changed" = true ] && [ "$adr_changed" = true ]; then
  message="docs: CONTEXT + ADRs for $branch"
elif [ "$context_changed" = true ]; then
  message="docs: CONTEXT for $branch"
else
  message="docs: ADRs for $branch"
fi

if ! git -C "$repo" commit --only -m "$message" -- "${doc_files[@]}" >/dev/null; then
  echo "commit-docs: failed to commit docs in $repo" >&2
  exit 1
fi

echo "commit-docs: committed onto '$branch' in $repo — $message"
