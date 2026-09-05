# Development and Deploy - issue-flow

Complete guide for setting up the development environment, testing locally, and publishing to NPM.

## Prerequisites

| Tool | Minimum version | Check |
|------|----------------|-------|
| Node.js | >= 22.13.0 | `node --version` |
| npm | >= 9 | `npm --version` |
| git | any | `git --version` |
| Claude Code | latest | `claude --version` |
| GitHub CLI | latest | `gh --version` |

To publish to NPM, you also need an account with access to the `issue-flow` package.

## Development setup

```bash
# Clone the repository
git clone https://github.com/fabioassuncao/issue-flow.git
cd issue-flow/packages/issue-flow

# Install dependencies
npm install
```

### Project structure

```
src/
  cli.ts, config.ts, types.ts, schemas.ts
  agents/       # Claude / Codex / Cursor / Antigravity, selection by phase
  commands/     # Phase commands, publication order, multi-issue queue
  core/         # Execute loop, session snapshot, metrics
  storage/      # Global tree (~/.issue-flow), artifact paths, legacy migration
  telemetry/    # Execution history in tasks.json
  verify/       # Acceptance contract and independent review
  routing/      # Shadow routing and escalation
  policy/       # Convention discovery
  conventions/  # Git conventions (branch, commit, PR title)
  resilience/   # Failure taxonomy and retry policy
  benchmark/    # Real / synthetic corpus
  issues/       # GitHub and local providers
  execution/    # Multi-issue queue
  ui/           # Terminal output
  web/          # Monitoring server
  utils/        # Shell, git, filesystem helpers

prompts/*.md              # Prompt templates (packaged, runtime asset)
web/public/               # Monitoring dashboard (packaged, runtime asset)
scripts/git-version.mjs   # preversion/postversion hooks: release commit + tag
```

Invariants live next to the code: each of those directories has an `AGENTS.md`.
The index is the repository [`AGENTS.md`](../../AGENTS.md). Where a new file
belongs — and when an existing one is already too large — is in
[`docs/code-organization.md`](../../docs/code-organization.md). Session and plan
artifacts live in the [global storage](../../docs/storage.md)
(`~/.issue-flow/projects/<id>/issues/<N>/`), not under `<repo>/issues/`.

`prompts/` and `web/public/` are resolved at runtime relative to the installed
package (see `core/prompt-resolver.ts`), which is why both are listed in the
`files` field of `package.json`. Adding a new runtime asset directory means
adding it there too, otherwise it works locally and breaks once installed.

## Available scripts

```bash
# Build - generates dist/cli.js (ESM bundle with shebang)
npm run build

# Watch mode - automatic rebuild on save
npm run dev

# Type checking (without emitting files)
npm run typecheck

# Lint (Biome, read-only — covers src/, web/public/, scripts/, *.config.ts)
npm run lint

# Gate local idêntico ao CI: biome check (não muta) + tsc
npm run check

# Aplica correções do Biome e depois typecheck (muta a árvore)
npm run fix

# Só formatação
npm run format

# Unit tests (single run)
npm test

# Tests in watch mode (re-runs on save)
npm run test:watch

# Integration tests
npm run test:integration

# Smoke script (real provider probes)
npm run smoke
```

## Local testing

### 1. Unit tests

```bash
npm test
```

Runs every `src/**/*.test.ts` via Vitest.

### 2. Manual CLI testing

```bash
# Build and run directly
npm run build
node dist/cli.js --help

# Test with a real issue (requires a plan in global storage)
node dist/cli.js execute --issue 1 --max-iterations 1

# Full pipeline
node dist/cli.js run 42
```

### 3. Testing via npm link (simulates global install)

```bash
# In the package directory
npm run build
npm link

# Now the command is available globally
issue-flow --help
issue-flow run 42

# To remove the link
npm unlink -g issue-flow
```

### 4. Testing via local npx

```bash
# From the repository root
npm run build --prefix packages/issue-flow
npx --prefix packages/issue-flow issue-flow --help
```

### 5. Package testing before publishing

```bash
# Generate the tarball without publishing (runs prepack -> npm run build)
npm pack

# Check the contents: dist/, prompts/, web/public/, package.json, README, LICENSE
tar -tzf issue-flow-*.tgz

# Test installation from the tarball
cd /tmp
npm install /path/to/issue-flow-0.12.0.tgz
npx issue-flow --help
```

## Release process

Npm releases are **manual**. `.github/workflows/ci.yml` checks lint, types,
tests, builds and Skill artifacts on pushes and pull requests. The separate
`publish-skills.yml` workflow publishes the assembled Agent Skills repository
channel; it does not publish the CLI to npm. Everything below is run from a
local machine by a maintainer with publish rights on the `issue-flow` npm package.

### Ground rules

- **Never edit `version` in `package.json` by hand.** Always use `npm version`.
  Hand-editing is what caused 0.4.3 and 0.4.4 to reach npm without a git tag,
  leaving the repository and the registry out of sync.
- **Every published version gets a git tag and a GitHub Release.** Tags are
  `vX.Y.Z`, created by the `postversion` hook, and must be pushed.
- **`npm version` alone does not tag in this repository.** npm only performs the
  git step when it finds a `.git` directory inside the package folder; here
  `.git` lives at the monorepo root, so npm rewrites `package.json` and stops —
  no commit, no tag, no warning. That is the actual root cause of the missing
  0.4.3/0.4.4 tags. The `preversion`/`postversion` hooks in `package.json`
  (`scripts/git-version.mjs`) restore the expected behavior: they refuse to bump
  on a dirty tree, then create the release commit and the annotated tag.
- **`CHANGELOG.md` is updated before the version bump**, not after. Its section
  for the new version is the body of the GitHub Release.
- The quality gate lives in the manifest, not in CI: `npm publish` runs
  `prepublishOnly` (lint + typecheck + tests) and then `prepack`
  (`npm run build`). A failing check aborts the publish, and `dist/` is always
  rebuilt from the current sources — a stale build cannot be published.

### Versioning (SemVer)

| Type | When to use | Example |
|------|------------|---------|
| **patch** | Bug fix, text adjustment | Fix transient error detection |
| **minor** | New backward-compatible feature | Add the `--web` monitoring dashboard |
| **major** | Breaking change | Change the `tasks.json` format |

### One-time setup

```bash
# Authenticate against the public registry
npm login

# Confirm the account (must have publish rights on issue-flow)
npm whoami
```

The token stored in `~/.npmrc` expires. If `npm whoami` returns
`401 Unauthorized`, run `npm login` again.

### Release steps

```bash
# 1. Start from a clean, up-to-date main
git checkout main
git pull
git status            # must be clean

# 2. Confirm you are authenticated
npm whoami

# 3. Update CHANGELOG.md at the repository root: add the new version section
#    (Added / Changed / Fixed / Removed) and its link at the bottom.
git add CHANGELOG.md
git commit -m "docs: changelog for vX.Y.Z"

# 4. Bump the version. preversion checks the tree is clean; postversion creates
#    the release commit and the annotated vX.Y.Z tag.
cd packages/issue-flow
npm version patch      # or minor / major

# 5. Publish — runs prepublishOnly (lint, typecheck, test) and prepack (build)
npm publish

# 6. Push the commits and the tag
git push && git push --tags

# 7. Create the GitHub Release. Copy the CHANGELOG section for this version
#    into a file and use it as the release body.
gh release create vX.Y.Z --title "vX.Y.Z" --notes-file /tmp/notes.md --latest

# 8. Verify
npm view issue-flow version
npx --yes issue-flow@latest --version
```

If step 5 fails, undo the bump before pushing anything:

```bash
git tag -d vX.Y.Z
git reset --hard HEAD~1
```

### Post-release checklist

- [ ] `npm view issue-flow version` reports the new version
- [ ] `npx --yes issue-flow@latest --version` reports the new version
- [ ] `npx --yes issue-flow@latest init` runs (validates that `prompts/` and
      `web/public/` resolve correctly from the installed package)
- [ ] Tag visible in `git ls-remote --tags origin`
- [ ] GitHub Release created and marked as *Latest*
- [ ] `CHANGELOG.md` section matches what was actually shipped

### Troubleshooting

| Problem | Likely cause | Solution |
|---------|-------------|----------|
| `npm ERR! 401 Unauthorized` | Expired token in `~/.npmrc` | Run `npm login` again |
| `npm ERR! 403 Forbidden` | Account without publish rights on the package | Check package ownership with `npm owner ls issue-flow` |
| `npm ERR! 403 ... cannot publish over previously published version` | Version already in the registry | Bump again with `npm version patch`; published versions are immutable |
| `npm version` fails with "Working tree is not clean" | Uncommitted changes | Commit or stash first — the release commit must contain only the manifest change |
| `npm version` bumped the files but created no commit or tag | The `preversion`/`postversion` hooks were bypassed (e.g. `--ignore-scripts`) | Revert the manifest change and re-run `npm version` without `--ignore-scripts` |
| Published package missing `prompts/` or `web/public/` | New asset directory not added to `files` in `package.json` | Add it, verify with `npm pack --dry-run`, publish a patch |
| Tag pushed but nothing published | Expected — there is no publish workflow | Run `npm publish` locally as described above |
