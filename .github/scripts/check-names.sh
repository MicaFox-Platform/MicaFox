#!/usr/bin/env bash
# Checks PR titles and commit subjects against docs/development.md#naming.
# Usage: check-names.sh title <pr title>          CI, on every PR
#        check-names.sh commit <subject>          .githooks/commit-msg, before the commit exists
#        check-names.sh commits <git log args>    CI and .githooks/pre-push, every non-merge commit they select
# Every failure says what is wrong and prints the rules with passing and failing examples.
# .claude/hooks/guard-git.sh sources this file for the branch rules, so it only defines functions when sourced.
set -uo pipefail

# The only allowed types, for branches, PR titles and commits; keep the table in docs/development.md in sync
types_help='feat      new behavior for users of the packages (minor release)
fix       bug fix for users of the packages (patch release)
perf      faster or lighter, same behavior
refactor  code change with the same behavior
docs      documentation only
test      tests only
build     build, dependencies, package and tool configs
ci        CI workflows, hooks and their scripts
chore     anything else that does not reach users
style     formatting only
revert    reverts an earlier commit'
types=$(cut -d' ' -f1 <<<"$types_help" | paste -sd'|' -)
# Common wrong types and what to use instead
aliases='feature:feat bugfix:fix hotfix:fix doc:docs tests:test deps:build config:build infra:build-or-ci release:chore'

max_branch=50
max_subject=100
# Branch rules bind only AI agents, through guard-git.sh: a wrong branch name is cheap to live with.
# Branches stay lowercase: on case-insensitive file systems `Feat/x` and `feat/x` are the same ref
branch_re="^($types)/[a-z0-9]+(-[a-z0-9]+)*\$"
# Conventional Commits treats type and scope as case-insensitive
subject_re="^($types)(\([a-z0-9-]+\))?!?: [^ ]"

branch_ok() { [[ $1 == staging ]] || { [[ $1 =~ $branch_re ]] && ((${#1} <= max_branch)); }; }
subject_ok() {
  local ok=1
  shopt -s nocasematch
  [[ $1 =~ $subject_re ]] && ((${#1} <= max_subject)) && ok=0
  shopt -u nocasematch
  return $ok
}

# Prints why a letters-only type is not allowed, nothing when it is
type_problem() {
  local type=$1 lower hint pair
  lower=$(tr '[:upper:]' '[:lower:]' <<<"$type")
  [[ "|$types|" == *"|$lower|"* ]] && return 0
  for pair in $aliases; do
    [[ $lower == "${pair%%:*}" ]] && hint=" (did you mean '${pair#*:}'?)" && hint=${hint//-or-/\' or \'}
  done
  echo "type '$type' is not allowed${hint:-}; use one of: ${types//|/, }"
}

# Prints one reason per line for a name that failed branch_ok
branch_problems() {
  local name=$1 type rest
  ((${#name} > max_branch)) && echo "${#name} chars, the limit is $max_branch"
  if [[ $name != */* ]]; then
    echo "no '<type>/' prefix"
    return
  fi
  type=${name%%/*} rest=${name#*/}
  if [[ -z $type ]]; then
    echo "type before '/' is empty"
  elif [[ $type =~ [A-Z] && $type =~ ^[A-Za-z]+$ ]]; then
    echo "type '$type' has uppercase letters: branches are lowercase only"
  elif [[ ! $type =~ ^[a-z]+$ ]]; then
    echo "type '$type' may contain only letters a-z"
  else
    type_problem "$type"
  fi
  if [[ -z $rest ]]; then
    echo "name after '/' is empty"
    return
  fi
  [[ $rest == */* ]] && echo "more than one '/': the part after '$type/' cannot contain '/'"
  [[ $rest =~ [A-Z] ]] && echo "'$rest' has uppercase letters: branches are lowercase only"
  [[ $rest =~ [^A-Za-z0-9/-] ]] && echo "'$rest' has characters other than a-z, 0-9 and '-'"
  [[ $rest == -* || $rest == *- ]] && echo "'$rest' starts or ends with '-'"
  [[ $rest == *--* ]] && echo "'$rest' has '--': separate words with a single '-'"
  return 0
}

# Prints one reason per line for a subject that failed subject_ok
subject_problems() {
  local s=$1 head desc type scope
  ((${#s} > max_subject)) && echo "${#s} chars, the limit is $max_subject"
  if [[ $s =~ ^(fixup|squash|amend)! ]]; then
    echo "'${BASH_REMATCH[0]}' commit is not squashed yet: git rebase -i --autosquash <base>"
    return
  fi
  if [[ $s != *:* ]]; then
    echo "no ':' after '<type>' or '<type>(<scope>)'"
    return
  fi
  head=${s%%:*} desc=${s#*:}
  head=${head%!}
  type=$head
  if [[ $head == *\(* ]]; then
    type=${head%%\(*} scope=${head#*\(}
    if [[ $scope != *\) ]]; then
      echo "scope '($scope' must end with ')' right before ':' or '!:'"
    else
      scope=${scope%\)}
      if [[ -z $scope ]]; then
        echo "scope '()' is empty: name a scope or drop the parentheses"
      elif [[ ! $scope =~ ^[A-Za-z0-9-]+$ ]]; then
        echo "scope '$scope' may contain only letters, digits and '-'"
      fi
    fi
  fi
  if [[ -z $type ]]; then
    echo "type before ':' is empty"
  elif [[ ! $type =~ ^[A-Za-z]+$ ]]; then
    echo "type '$type' may contain only letters (no spaces, digits or symbols)"
  else
    type_problem "$type"
  fi
  if [[ -z ${desc// /} ]]; then
    echo "description after ': ' is empty"
  elif [[ $desc != " "* ]]; then
    echo "no space after ':'"
  elif [[ $desc == "  "* ]]; then
    echo "more than one space after ':'"
  fi
  return 0
}

[[ ${BASH_SOURCE[0]} == "$0" ]] || return 0

mode=${1:-} && shift
case $mode in
  title | commit) (($# == 1)) || mode= ;;
  commits) (($# > 0)) || mode= ;;
  *) mode= ;;
esac
if [[ -z $mode ]]; then
  echo 'Usage: check-names.sh title <pr title> | commit <subject> | commits <git log args>' >&2
  exit 2
fi

subject_pass=('docs: decide configs architecture' 'Docs: decide configs architecture' 'feat(sdk): add snapshots'
  'FEAT(SDK)!: drop Node 20')
subject_fail=('decide configs architecture' 'infra: bump pnpm' 'ci-infra-docs: add checks' 'docs:decide'
  'docs:  decide' 'docs(): decide' 'docs (configs): decide' 'docs(configs: decide')

# Examples are run through the same checks, so they cannot drift from the rules
examples() {
  local kind=$1 verdict reason x
  shift
  for x in "$@"; do
    reason=$(subject_problems "$x" | head -1)
    reason=${reason%%; use one of*}
    if subject_ok "$x"; then verdict='✓' reason=''; else verdict='✗'; fi
    if [[ ($kind == pass && $verdict == '✗') || ($kind == fail && $verdict == '✓') ]]; then
      echo "::error::check-names.sh: example '$x' should $kind but does not, fix the examples"
      exit 2
    fi
    if [[ -z $reason ]]; then printf '    %s %s\n' "$verdict" "$x"; else printf '    %s %-36s %s\n' "$verdict" "$x" "$reason"; fi
  done
}

# Workflow commands need %, CR and LF encoded; outside GitHub Actions they would be noise
annotate() {
  [[ -n ${GITHUB_ACTIONS:-} ]] || return 0
  local msg=$2
  msg=${msg//%/%25} msg=${msg//$'\r'/%0D} msg=${msg//$'\n'/%0A}
  echo "::error title=$1::$msg"
}

failed=0
report() {
  local label=$1 value=$2 reasons
  if subject_ok "$value"; then
    printf '✓ %s: "%s"\n' "$label" "$value"
    return
  fi
  reasons=$(subject_problems "$value")
  [[ -z $reasons ]] && reasons="does not match the rule below"
  printf '✗ %s: "%s"\n%s\n' "$label" "$value" "$(sed 's/^/    - /' <<<"$reasons")"
  annotate "$label is invalid" "\"$value\""$'\n'"$reasons"
  failed=$((failed + 1))
}

case $mode in
  title) report 'PR title' "$1" ;;
  commit) report 'Commit' "$1" ;;
  commits)
    # Merge commits keep git's default subject and are skipped
    while IFS= read -r line; do
      report "Commit ${line%% *}" "${line#* }"
    done < <(git log --no-merges --format='%h %s' "$@")
    ;;
esac

((failed == 0)) && exit 0

case $mode in
  title) fix='gh pr edit <number> --title "<type>: <description>"   (CI re-runs on rename)' ;;
  commit) fix='git commit -e -F "$(git rev-parse --git-path COMMIT_EDITMSG)"   (reopens the message you wrote)' ;;
  commits) fix="git rebase -i --autosquash <base>, mark them 'reword'; once pushed, also git push --force-with-lease" ;;
esac

cat <<EOF

$failed name(s) break the rules

Rule (docs/development.md#naming)
  <type>[(<scope>)][!]: <description>, ≤ $max_subject chars; type and scope in any case
  $subject_re (case-insensitive)

Types
$(sed 's/^/  /' <<<"$types_help")

Examples
$(examples pass "${subject_pass[@]}")
$(examples fail "${subject_fail[@]}")

How to fix
  $fix
EOF
exit 1
