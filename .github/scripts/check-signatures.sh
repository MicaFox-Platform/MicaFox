#!/usr/bin/env bash
# Checks that commits are signed: docs/development.md#signing-commits. The rulesets of `staging` and `main` require
# a verified signature on every commit, and a merge commit keeps every commit of a pull request.
# Usage: check-signatures.sh pr <repo> <number>   CI, on PRs into staging: every commit of the PR is `verified` for
#                                                 GitHub; needs GH_TOKEN, the default read-only one is enough
#        check-signatures.sh commits <git log args>  .githooks/pre-push: no selected commit lacks a signature; only
#                                                 GitHub can tell a trusted key from an untrusted one
# Every failure says what is wrong and how to fix it.
set -uo pipefail

repo_url="https://github.com/${GITHUB_REPOSITORY:-MicaFox-Platform/MicaFox}"
how_to="$repo_url/blob/staging/docs/development.md#signing-commits"

usage() {
  echo 'Usage: check-signatures.sh pr <repo> <number> | commits <git log args>' >&2
  exit 2
}

# What to do about a reason of GitHub's `verification.reason`; the rest of them have the how-to
hint() {
  case $1 in
    unsigned) echo 'not signed: sign it' ;;
    no_user) echo 'the commit email is on no GitHub account: use a verified email or the noreply address' ;;
    unverified_email) echo 'the commit email is not verified on the GitHub account' ;;
    bad_email) echo "the commit email is not one of the signing key's emails" ;;
    unknown_key) echo "the key is not on the author's GitHub account as a Signing key" ;;
    not_signing_key) echo 'the key is not allowed to sign: use a signing key' ;;
    expired_key) echo 'the key has expired: sign with a valid key' ;;
    invalid | malformed_signature | gpgverify_error | gpgverify_unavailable)
      echo 'the signature is not valid: sign it again' ;;
    *) echo 'GitHub cannot verify the signature' ;;
  esac
}

# Workflow commands need %, CR and LF encoded; outside GitHub Actions they would be noise
annotate() {
  [[ -n ${GITHUB_ACTIONS:-} ]] || return 0
  local msg=$2
  msg=${msg//%/%25} msg=${msg//$'\r'/%0D} msg=${msg//$'\n'/%0A}
  echo "::error title=$1::$msg"
}

# Takes "<short sha> <reason> <subject>" lines on stdin, prints them as a list and exits non-zero when there are any
report() {
  local line sha reason subject list=''
  while IFS= read -r line; do
    [[ -n $line ]] || continue
    sha=${line%% *} line=${line#* } reason=${line%% *} subject=${line#* }
    list+=$(printf '  ✗ %s %s (%s)\n      %s' "$sha" "$subject" "$reason" "$(hint "$reason")")$'\n'
  done
  [[ -n $list ]] || return 0
  printf '✗ commits without a verified signature:\n%s\n  how to sign and fix them: %s\n' "$list" "$how_to" >&2
  annotate 'Unverified commits' "$list"$'how to sign and fix them: '"$how_to"
  return 1
}

# GitHub lists at most this many commits of a pull request, however many pages are asked for
max_pr_commits=250

check_pr() {
  local repo=$1 number=$2 out err total
  err=$(mktemp)
  # shellcheck disable=SC2064 # expand now: $err is local
  trap "rm -f '$err'" EXIT
  # `--jq` runs once per page. One line per commit: "ok" or GitHub's reason. A fork controls the subject, so control
  # characters go: a CR would start a workflow command in the log
  if ! out=$(gh api --paginate "repos/$repo/pulls/$number/commits?per_page=100" --jq '
    .[] |
    (if .commit.verification.verified == true then "ok" else .commit.verification.reason // "unknown" end) as $status |
    "\(.sha[0:7]) \($status) \(.commit.message | split("\n")[0] | gsub("[[:cntrl:]]"; " "))"
  ' 2>"$err"); then
    echo "✗ could not read the commits of $repo#$number from GitHub: $(cat "$err")" >&2
    exit 1
  fi
  total=$(grep -c . <<<"$out")
  report < <(awk '$2 != "ok"' <<<"$out") || exit 1
  if ((total >= max_pr_commits)); then
    local note="only the first $max_pr_commits commits were checked, GitHub lists no more; the ruleset checks the rest"
    echo "! $note"
    [[ -z ${GITHUB_ACTIONS:-} ]] || echo "::warning title=Commit signatures::$note"
  fi
  echo '✓ commit signatures'
}

# A commit is signed when its header has a `gpgsig` field. `%G?` cannot tell: git reports N for an SSH signature while
# gpg.ssh.allowedSignersFile is unset, which is the default. Whether GitHub trusts the key is for the `pr` check
check_commits() {
  local log sha short subject out='' header
  # Captured first: a failed `git log` inside the loop's redirection would look like no commits at all
  log=$(git log --format='%H %h %s' "$@") || exit 1
  while read -r sha short subject; do
    [[ -n $sha ]] || continue
    header=$(git cat-file commit "$sha") || exit 1
    grep -q '^gpgsig' <<<"${header%%$'\n\n'*}" || out+="$short unsigned $subject"$'\n'
  done <<<"$log"
  report <<<"$out" || exit 1
  echo '✓ commit signatures'
}

case ${1:-} in
  pr) (($# == 3)) || usage; check_pr "$2" "$3" ;;
  commits) (($# > 1)) || usage; shift; check_commits "$@" ;;
  *) usage ;;
esac
