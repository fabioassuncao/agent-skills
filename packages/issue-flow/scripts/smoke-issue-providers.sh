#!/usr/bin/env bash
#
# End-to-end smoke tests for the Issue provider layer (issue #23).
#
# Runs the built CLI (dist/cli.js) inside throwaway git repositories against
# deterministic stand-ins for `claude` and `gh`, so the whole pipeline is
# exercised for real -- resolver, providers, prompts, phases and summary --
# without touching the network or spending tokens.
#
# Scenarios:
#   A. GitHub only, no flags and no .issue-flow.json  (mandatory regression)
#   B. Local only, --no-branch, gh installed but not authenticated
#   C. Both origins present, with divergence (plus `generate --both`)
#
# Usage: bash scripts/smoke-issue-providers.sh [--keep]
#   --keep  leave the temporary workspaces on disk for inspection

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(dirname "$SCRIPT_DIR")"
CLI="$PKG_DIR/dist/cli.js"

KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

PASSED=0
FAILED=0
WORKSPACES=""

# ── assertions ──────────────────────────────────────────────────────────────

ok() {
  printf '    ok   %s\n' "$1"
  PASSED=$((PASSED + 1))
}

ko() {
  printf '    FAIL %s\n' "$1"
  FAILED=$((FAILED + 1))
}

expect_code() { # actual expected message
  if [ "$1" = "$2" ]; then ok "$3"; else ko "$3 (exit $1, expected $2)"; fi
}

expect_contains() { # file needle message
  if [ -f "$1" ] && grep -qF -- "$2" "$1"; then ok "$3"; else ko "$3 (missing '$2' in $1)"; fi
}

expect_missing() { # file needle message
  if [ ! -f "$1" ] || ! grep -qF -- "$2" "$1"; then ok "$3"; else ko "$3 (unexpected '$2' in $1)"; fi
}

expect_file() { # path message
  if [ -f "$1" ]; then ok "$2"; else ko "$2 (no such file: $1)"; fi
}

expect_no_file() { # path message
  if [ ! -f "$1" ]; then ok "$2"; else ko "$2 (file exists: $1)"; fi
}

# Every prompt handed to the agent, concatenated. Used to prove the resolved
# Issue reached each phase and that no template shells out to gh.
prompt_bundle() { # promptDir outFile
  : >"$2"
  for file in "$1"/*.txt; do
    [ -f "$file" ] && cat "$file" >>"$2"
  done
}

# ── stubs ───────────────────────────────────────────────────────────────────

write_claude_stub() { # binDir
  cat >"$1/claude" <<'STUB'
#!/usr/bin/env bash
# Deterministic stand-in for the Claude Code CLI: records the prompt and emits
# each phase's public result protocol. The CLI owns deterministic file writes.
if [ "${1:-}" = "--version" ]; then
  echo "0.0.0 (smoke stub)"
  exit 0
fi

prompt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -p) prompt="${2:-}"; shift 2 ;;
    --output-format|--max-turns|--allowedTools) shift 2 ;;
    *) shift ;;
  esac
done

# Autonomous execution sends the prompt on stdin to avoid command-line limits;
# document phases use `-p` for headless read-only runs.
[ -z "$prompt" ] && prompt=$(cat)

mkdir -p "$SMOKE_PROMPT_DIR"
index=$(ls -1 "$SMOKE_PROMPT_DIR" | wc -l | tr -d ' ')
printf '%s' "$prompt" >"$SMOKE_PROMPT_DIR/$index.txt"

first_line=$(printf '%s' "$prompt" | head -n 1)

case "$first_line" in
  "You are analyzing issue"*)
    body=$(printf '%s' "$prompt" | sed 's|<issue-analysis>|[issue-analysis]|g; s|</issue-analysis>|[/issue-analysis]|g')
    printf '<issue-analysis>\n%s\n</issue-analysis>\n' "$body"
    ;;

  "You are generating a Product Requirements Document"*)
    body=$(printf '%s' "$prompt" | sed 's|<prd>|[prd]|g; s|</prd>|[/prd]|g')
    printf '<prd>\n%s\n</prd>\n' "$body"
    ;;

  "You are converting a PRD"*)
    cat <<'JSON'
<task-plan>
{
  "description": "Smoke task plan",
  "stories": [
    {
      "key": "already-implemented",
      "title": "Already implemented",
      "description": "Pre-passing story so the execution loop terminates at once.",
      "acceptanceCriteria": ["Nothing to do"],
      "dependsOn": []
    }
  ]
}
</task-plan>
JSON
    ;;

  "# Execute the current task"*)
    path=$(printf '%s' "$prompt" | sed -n 's|^This is a read-only projection of `\([^`]*\)`.*|\1|p' | tail -n 1)
    node -e '
      const fs = require("node:fs");
      const path = process.argv[1];
      const plan = JSON.parse(fs.readFileSync(path, "utf8"));
      for (const story of plan.userStories) {
        story.passes = true;
        story.notes = "Verified by the smoke harness.";
      }
      fs.writeFileSync(path, `${JSON.stringify(plan, null, 2)}\n`);
    ' "$path"
    echo "<promise>COMPLETE</promise>"
    ;;

  "You are reviewing whether"*)
    echo "<review-result>"
    echo "STATUS: PASS"
    echo "</review-result>"
    ;;

  "You are creating a pull request"*)
    echo "Pull request opened: https://github.com/acme/demo/pull/7"
    ;;

  "You are drafting an issue"*)
    echo "<issue-draft>"
    echo "<title>Smoke drafted issue</title>"
    echo "<labels>enhancement</labels>"
    echo "<body>"
    echo "Body drafted by the smoke stub."
    echo "</body>"
    echo "</issue-draft>"
    ;;

  *)
    echo "smoke stub: unrecognized prompt: $first_line" >&2
    exit 1
    ;;
esac
STUB
  chmod +x "$1/claude"
}

write_gh_stub() { # binDir authed|unauthed
  cat >"$1/gh" <<STUB
#!/usr/bin/env bash
GH_AUTHED="$2"
STUB
  cat >>"$1/gh" <<'STUB'
# Deterministic stand-in for the GitHub CLI, backed by JSON fixtures.
printf '%s\n' "$*" >>"$SMOKE_GH_LOG"

case "${1:-}" in
  --version)
    echo "gh version 2.0.0 (smoke stub)"
    exit 0
    ;;
  auth)
    if [ "$GH_AUTHED" = "authed" ]; then
      echo "Logged in to github.com as smoke"
      exit 0
    fi
    echo "You are not logged into any GitHub hosts." >&2
    exit 1
    ;;
  pr)
    echo "[]"
    exit 0
    ;;
  issue)
    sub="${2:-}"
    shift 2
    case "$sub" in
      view)
        fixture="$SMOKE_GH_FIXTURES/${1}.json"
        if [ -f "$fixture" ]; then
          cat "$fixture"
          exit 0
        fi
        echo "GraphQL: Could not resolve to an Issue with the number of ${1}." >&2
        exit 1
        ;;
      create)
        title=""; body=""; labels=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --title) title="$2"; shift 2 ;;
            --body) body="$2"; shift 2 ;;
            --label) labels="$labels $2"; shift 2 ;;
            *) shift ;;
          esac
        done
        number=$(( $(ls -1 "$SMOKE_GH_FIXTURES" | wc -l | tr -d ' ') + 100 ))
        url="https://github.com/acme/demo/issues/$number"
        SMOKE_NUMBER="$number" SMOKE_URL="$url" SMOKE_TITLE="$title" \
        SMOKE_BODY="$body" SMOKE_LABELS="$labels" node -e '
          const labels = (process.env.SMOKE_LABELS || "").split(" ").filter(Boolean).map((name) => ({ name }));
          process.stdout.write(JSON.stringify({
            number: Number(process.env.SMOKE_NUMBER),
            title: process.env.SMOKE_TITLE,
            body: process.env.SMOKE_BODY,
            labels,
            state: "OPEN",
            url: process.env.SMOKE_URL,
            createdAt: "2026-08-03T12:00:00Z",
            updatedAt: "2026-08-03T12:00:00Z",
          }));
        ' >"$SMOKE_GH_FIXTURES/$number.json"
        echo "$url"
        exit 0
        ;;
      close)
        echo "Closed issue #${1}"
        exit 0
        ;;
      list)
        echo "[]"
        exit 0
        ;;
    esac
    exit 1
    ;;
esac
exit 1
STUB
  chmod +x "$1/gh"
}

write_github_fixture() { # fixturesDir number title body
  SMOKE_NUMBER="$2" SMOKE_TITLE="$3" SMOKE_BODY="$4" node -e '
    process.stdout.write(JSON.stringify({
      number: Number(process.env.SMOKE_NUMBER),
      title: process.env.SMOKE_TITLE,
      body: process.env.SMOKE_BODY,
      labels: [{ name: "enhancement" }],
      state: "OPEN",
      url: `https://github.com/acme/demo/issues/${process.env.SMOKE_NUMBER}`,
      createdAt: "2026-08-03T12:00:00Z",
      updatedAt: "2026-08-03T12:00:00Z",
    }));
  ' >"$1/$2.json"
}

write_local_issue() { # repo number title body
  mkdir -p "$1/issues/$2"
  printf '# %s\n\n%s\n' "$3" "$4" >"$1/issues/$2/issue.md"
  SMOKE_ID="$2" SMOKE_TITLE="$3" SMOKE_BODY="$4" SMOKE_OUT="$1/issues/$2/metadata.json" \
    node -e '
      const { createHash } = require("node:crypto");
      const { writeFileSync } = require("node:fs");
      const normalize = (v) => v.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      const title = normalize(process.env.SMOKE_TITLE);
      const body = normalize(process.env.SMOKE_BODY);
      const contentHash = `sha256:${createHash("sha256").update(JSON.stringify({ title, body })).digest("hex")}`;
      writeFileSync(process.env.SMOKE_OUT, `${JSON.stringify({
        schemaVersion: 1,
        id: process.env.SMOKE_ID,
        number: Number(process.env.SMOKE_ID),
        source: "local",
        title,
        labels: ["enhancement"],
        state: "open",
        createdAt: "2026-08-03T12:00:00Z",
        updatedAt: "2026-08-03T12:00:00Z",
        contentHash,
      }, null, 2)}\n`);
    '
}

# ── workspace ───────────────────────────────────────────────────────────────

# Prints the repo path. The caller must record it in WORKSPACES: this runs in a
# command substitution, so any variable set here dies with the subshell.
new_workspace() { # authed|unauthed -> prints the repo path
  local repo bin
  repo="$(mktemp -d)"

  git -C "$repo" init -q
  git -C "$repo" config user.email smoke@example.com
  git -C "$repo" config user.name "Smoke Test"
  printf '# demo\n' >"$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -qm 'chore: initial commit'

  bin="$repo/.smoke-bin"
  mkdir -p "$bin" "$repo/.smoke/prompts" "$repo/.smoke/fixtures"
  write_claude_stub "$bin"
  write_gh_stub "$bin" "$1"

  printf '%s' "$repo"
}

# Run the CLI inside a workspace with the stubs first on PATH.
run_cli() { # repo args...
  local repo="$1"
  shift
  (
    cd "$repo" || exit 1
    PATH="$repo/.smoke-bin:$PATH" \
    SMOKE_PROMPT_DIR="$repo/.smoke/prompts" \
    SMOKE_GH_FIXTURES="$repo/.smoke/fixtures" \
    SMOKE_GH_LOG="$repo/.smoke/gh.log" \
    ISSUE_FLOW_HOME="$repo/.smoke/state" \
    NO_COLOR=1 \
      node "$CLI" "$@" </dev/null
  )
}

reset_capture() { # repo
  rm -rf "$1/.smoke/prompts" "$1/.smoke/gh.log"
  mkdir -p "$1/.smoke/prompts"
}

# A workspace owns one global storage project. Assertions inspect its projections;
# the legacy input tree is deliberately never treated as the current write target.
artifact_path() { # repo issue filename
  local projects
  projects=("$1"/.smoke/state/projects/*)
  printf '%s/issues/%s/%s' "${projects[0]}" "$2" "$3"
}

# ── scenario A: GitHub only, no flags, no .issue-flow.json ──────────────────

scenario_github_only() {
  echo "[A] GitHub only -- no flags, no .issue-flow.json (mandatory regression)"
  local repo out
  repo="$(new_workspace authed)"
  WORKSPACES="$WORKSPACES $repo"
  write_github_fixture "$repo/.smoke/fixtures" 42 "Add dark mode" "The settings page needs a dark theme toggle."

  out="$repo/.smoke/run.log"
  run_cli "$repo" run 42 >"$out" 2>&1
  expect_code "$?" 0 "issue-flow run 42 succeeds"

  local prompts="$repo/.smoke/all-prompts.txt"
  prompt_bundle "$repo/.smoke/prompts" "$prompts"

  expect_contains "$prompts" "Add dark mode" "the GitHub title reaches the phases"
  expect_contains "$prompts" "The settings page needs a dark theme toggle." "the GitHub body reaches the phases"
  expect_contains "$prompts" "Source: github" "phases are told the origin is github"
  expect_contains "$prompts" "https://github.com/acme/demo/issues/42" "the issue URL reaches the phases"
  expect_contains "$prompts" "Closes #42" "the PR keeps the Closes reference"
  expect_missing "$prompts" "gh issue view" "no prompt tells the agent to fetch the issue"

  expect_contains "$repo/.smoke/gh.log" "issue view 42" "the provider fetched the issue via gh"
  expect_missing "$repo/.smoke/gh.log" "issue close 42" "the issue remains open without explicit closure"

  expect_contains "$out" "Pipeline finished" "the pipeline reports completion"
  expect_contains "$out" "unverified" "an empty verification contract is not reported green"
  expect_contains "$out" "Branch:" "summary keeps Branch"
  expect_contains "$out" "Stories:" "summary keeps Stories"
  expect_contains "$out" "Duration:" "summary keeps Duration"
  expect_contains "$out" "PR:" "summary keeps PR"

  expect_file "$(artifact_path "$repo" 42 prd.md)" "prd.md was produced"
  expect_contains "$(artifact_path "$repo" 42 tasks.json)" '"prCreated": true' "pipeline state records the PR"
  expect_no_file "$(artifact_path "$repo" 42 metadata.json)" "a GitHub-only run writes no local metadata"
  expect_no_file "$(artifact_path "$repo" 42 issue.md)" "a GitHub-only run writes no local issue.md"
  expect_no_file "$repo/.issue-flow.json" "the run did not create a config file"
}

# ── scenario B: local only, --no-branch, gh not authenticated ───────────────

scenario_local_only() {
  echo "[B] Local only -- --no-branch, gh present but not authenticated"
  local repo out
  repo="$(new_workspace unauthed)"
  WORKSPACES="$WORKSPACES $repo"
  write_local_issue "$repo" 7 "Local rate limiting" "Throttle the public API to 100 req/min."

  run_cli "$repo" init >"$repo/.smoke/init-github.log" 2>&1
  expect_code "$?" 1 "init still fails without gh auth when the origin is github"

  run_cli "$repo" init --local >"$repo/.smoke/init-local.log" 2>&1
  expect_code "$?" 0 "init --local approves the environment"
  expect_contains "$repo/.smoke/init-local.log" "not required for local issues" "gh is downgraded to a warning"

  reset_capture "$repo"
  out="$repo/.smoke/run.log"
  run_cli "$repo" run 7 --no-branch --local >"$out" 2>&1
  expect_code "$?" 0 "issue-flow run 7 --no-branch --local succeeds"

  local prompts="$repo/.smoke/all-prompts.txt"
  prompt_bundle "$repo/.smoke/prompts" "$prompts"

  expect_contains "$prompts" "Local rate limiting" "the local title reaches the phases"
  expect_contains "$prompts" "Throttle the public API to 100 req/min." "the local body reaches the phases"
  expect_contains "$prompts" "Source: local" "phases are told the origin is local"
  expect_contains "$prompts" "issues/7/issue.md" "phases reference the local file"
  expect_missing "$prompts" "gh issue view" "no prompt tells the agent to fetch the issue"

  expect_missing "$repo/.smoke/gh.log" "issue view" "an unauthenticated gh is never asked for the issue"
  expect_contains "$(artifact_path "$repo" 7 metadata.json)" '"state": "open"' "the local issue remains open by default"
  expect_contains "$out" "Pipeline finished" "the pipeline reports completion"
  expect_contains "$out" "unverified" "an empty verification contract is not reported green"
  expect_missing "$out" "PR:" "--no-branch prints no PR line"
}

# ── scenario C: both origins, with divergence ──────────────────────────────

scenario_both_divergent() {
  echo "[C] Both origins -- divergent content"
  local repo analysis
  repo="$(new_workspace authed)"
  WORKSPACES="$WORKSPACES $repo"
  write_github_fixture "$repo/.smoke/fixtures" 42 "Add dark mode" "Remote body: toggle in the settings page."
  write_local_issue "$repo" 42 "Add dark mode" "Local body: toggle plus an OS-level preference."

  analysis=""

  reset_capture "$repo"
  run_cli "$repo" analyze 42 >"$repo/.smoke/ask.log" 2>&1
  expect_code "$?" 0 "analyze resolves a divergent issue without blocking"
  analysis="$(artifact_path "$repo" 42 analysis.md)"
  expect_contains "$repo/.smoke/ask.log" "differs between origins" "the divergence is reported"
  expect_contains "$repo/.smoke/ask.log" "non-interactive environment" "ask degrades outside a TTY"
  expect_contains "$analysis" "Remote body" "the default preference (github) wins"

  reset_capture "$repo"
  rm -f "$analysis"
  run_cli "$repo" analyze 42 --prefer-local >"$repo/.smoke/prefer-local.log" 2>&1
  expect_code "$?" 0 "--prefer-local resolves"
  expect_contains "$repo/.smoke/prefer-local.log" "using the local version" "the policy is announced"
  expect_contains "$analysis" "Local body" "the local version is used"

  reset_capture "$repo"
  rm -f "$analysis"
  run_cli "$repo" analyze 42 --prefer-github >"$repo/.smoke/prefer-github.log" 2>&1
  expect_code "$?" 0 "--prefer-github resolves"
  expect_contains "$analysis" "Remote body" "the GitHub version is used"

  # Same content on both sides: equivalence, no divergence warning.
  reset_capture "$repo"
  rm -f "$analysis"
  write_github_fixture "$repo/.smoke/fixtures" 42 "Add dark mode" "Local body: toggle plus an OS-level preference."
  run_cli "$repo" analyze 42 >"$repo/.smoke/identical.log" 2>&1
  expect_code "$?" 0 "identical content resolves"
  expect_contains "$repo/.smoke/identical.log" "has identical content" "equivalence is reported"
  expect_missing "$repo/.smoke/identical.log" "differs between origins" "no divergence is claimed"

  # generate --both: GitHub owns the number, the local mirror reuses it.
  reset_capture "$repo"
  run_cli "$repo" generate --prompt "Add a health endpoint" --both >"$repo/.smoke/generate.log" 2>&1
  expect_code "$?" 0 "generate --both succeeds"
  expect_contains "$repo/.smoke/generate.log" "Issue created (github)" "the GitHub issue was created"
  expect_contains "$repo/.smoke/generate.log" "Issue created (local)" "the local mirror was created"
  expect_missing "$repo/.smoke/generate.log" "gh issue create" "generate no longer shells out from the prompt"

  local mirror
  mirror="$(ls -d "$repo"/.smoke/state/projects/*/issues/1*/ 2>/dev/null | head -n 1)"
  if [ -n "$mirror" ]; then
    expect_contains "${mirror}metadata.json" '"syncedContentHash"' "the mirror records the sync hash"
    expect_contains "${mirror}metadata.json" "https://github.com/acme/demo/issues/" "the mirror records the remote ref"
    expect_contains "${mirror}issue.md" "Smoke drafted issue" "the mirror carries the drafted title"
  else
    ko "the local mirror directory was created"
  fi
}

# ── main ────────────────────────────────────────────────────────────────────

# ── scenario D: a free prompt, with no Issue behind it (§17) ────────────────

# `issue-flow run --prompt` is the entry `webmux oneshot` had and `run` did not.
# What this proves is the point of the convergence: the demand becomes an Issue
# of the `inline` origin, and from there the pipeline, the prompts and the
# summary are the ordinary ones — no shorter path, no skipped phase.
scenario_inline_prompt() {
  echo "[D] Free prompt -- no Issue behind it (§17)"
  local repo out
  repo="$(new_workspace unauthed)"
  WORKSPACES="$WORKSPACES $repo"

  out="$repo/.smoke/run.log"
  run_cli "$repo" run --prompt "Throttle the public API to 100 req/min" --no-branch --local >"$out" 2>&1
  expect_code "$?" 0 "issue-flow run --prompt succeeds with no Issue at all"

  local prompts="$repo/.smoke/all-prompts.txt"
  prompt_bundle "$repo/.smoke/prompts" "$prompts"

  expect_contains "$out" "Inline demand recorded as inline-" "the demand is reported as an inline Issue"
  expect_contains "$prompts" "Throttle the public API to 100 req/min" "the prompt reaches the phases as the Issue body"
  expect_contains "$prompts" "Source: inline" "phases are told the origin is inline"
  expect_missing "$repo/.smoke/gh.log" "issue view" "an inline demand never asks GitHub for an issue"
  expect_contains "$out" "Pipeline finished" "the pipeline reports completion"
  expect_contains "$out" "unverified" "verification is not weakened for an inline demand"

  # No issue argument and no prompt is a usage error, not an empty run.
  run_cli "$repo" run >"$repo/.smoke/no-demand.log" 2>&1
  expect_code "$?" 1 "run with no demand at all fails"
  expect_contains "$repo/.smoke/no-demand.log" "--prompt" "the error names the way to pass a free demand"
}

if [ ! -f "$CLI" ]; then
  echo "Building the CLI (dist/cli.js not found)..."
  (cd "$PKG_DIR" && npm run build >/dev/null) || {
    echo "Build failed."
    exit 1
  }
fi

echo "Smoke tests for the Issue provider layer"
echo "CLI: $CLI"
echo

scenario_github_only
echo
scenario_local_only
echo
scenario_both_divergent
echo
scenario_inline_prompt
echo

if [ "$KEEP" = "1" ]; then
  echo "Workspaces kept:"
  for ws in $WORKSPACES; do echo "  $ws"; done
else
  for ws in $WORKSPACES; do rm -rf "$ws"; done
fi

echo "passed: $PASSED   failed: $FAILED"
[ "$FAILED" -eq 0 ] || exit 1
