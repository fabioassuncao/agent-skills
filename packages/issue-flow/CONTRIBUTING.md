# Development and Deploy - issue-flow

Complete guide for setting up the development environment, testing locally, and publishing to NPM.

## Prerequisites

| Tool | Minimum version | Check |
|------|----------------|-------|
| Node.js | >= 22.0.0 | `node --version` |
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
  cli.ts                  # Entry point, subcommand registration (commander)
  config.ts               # Configuration resolution and defaults
  types.ts                # Shared TypeScript interfaces
  schemas.ts              # Zod validation schemas
  commands/
    init.ts               # Prerequisite checking
    generate.ts           # Issue creation via headless
    run.ts                # Full pipeline orchestrator
    analyze.ts            # Issue analysis via headless
    prd.ts                # PRD generation via headless
    plan.ts               # PRD-to-JSON conversion via headless
    execute.ts            # Iterative story execution loop
    review.ts             # Implementation review via headless
    pr.ts                 # PR creation via headless
  core/
    engine.ts             # Main agent loop
    executor.ts           # Claude CLI invocation via execa
    headless.ts           # Typed wrapper for claude -p
    pipeline.ts           # Pipeline state machine
    state-manager.ts      # Typed CRUD for tasks.json
    prompt-resolver.ts    # Prompt and packaged asset resolution
    session-state.ts      # Session snapshot model (web monitoring)
    session-publisher.ts  # Atomic writes of issues/{N}/session.json
    session-git.ts        # Commit and PR tracking during a run
    verbose.ts            # Global verbosity and timeout flags
  ui/
    logger.ts             # Colored logging with ASCII fallback
    progress.ts           # Progress bar and iteration headers
    pipeline-renderer.ts  # listr2 pipeline rendering
    summary.ts            # Box drawing and summaries
  utils/
    shell.ts              # Shell command execution wrapper
    git.ts                # Git operations (repo root detection)
    retry.ts              # Transient failure detection and backoff
  web/
    server.ts             # HTTP server for `run --web`

prompts/*.md              # Prompt templates  (packaged, runtime asset)
web/public/               # Monitoring dashboard (packaged, runtime asset)
```

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

# Unit tests (single run)
npm test

# Tests in watch mode (re-runs on save)
npm run test:watch
```

## Local testing

### 1. Unit tests

```bash
npm test
```

Runs tests in `src/**/*.test.ts` via Vitest. Current coverage:

- `state-manager.test.ts` - tasks.json CRUD and state mutations
- `prompt-resolver.test.ts` - Placeholder substitution
- `retry.test.ts` - Transient failure detection and backoff calculation
- `pipeline.test.ts` - Phase transitions and resume logic
- `headless.test.ts` - Headless invocation wrapper
- `schemas.test.ts` - Zod schema validation
- `config.test.ts` - Configuration resolution (CLI flags, env, `.issue-flow.json`)
- `session-state.test.ts` / `session-publisher.test.ts` - Snapshot model and atomic publishing
- `session-git.test.ts` - Commit and PR tracking
- `web/server.test.ts` - Monitoring HTTP server
- `git.test.ts` - Git helpers
- `run.test.ts` - `run` command orchestration

### 2. Manual CLI testing

```bash
# Build and run directly
npm run build
node dist/cli.js --help

# Test with a real issue (requires tasks.json in issues/N/)
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
npm install /path/to/issue-flow-0.5.0.tgz
npx issue-flow --help
```

## Release process

Releases are **manual**. There is no CI job that publishes to npm — the only
workflow in the repository is `.github/workflows/ci.yml` (lint, typecheck, test,
build on pushes and pull requests). Everything below is run from a local
machine by a maintainer with publish rights on the `issue-flow` npm package.

### Ground rules

- **Never edit `version` in `package.json` by hand.** Always use `npm version`.
  Hand-editing is what caused 0.4.3 and 0.4.4 to reach npm without a git tag,
  leaving the repository and the registry out of sync.
- **Every published version gets a git tag and a GitHub Release.** Tags are
  `vX.Y.Z` and are created by `npm version`; they must be pushed.
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

# 4. Bump the version — creates the bump commit AND the vX.Y.Z tag
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
| `npm version` fails with "Git working directory not clean" | Uncommitted changes | Commit or stash first — the bump commit must contain only the manifest change |
| Published package missing `prompts/` or `web/public/` | New asset directory not added to `files` in `package.json` | Add it, verify with `npm pack --dry-run`, publish a patch |
| Tag pushed but nothing published | Expected — there is no publish workflow | Run `npm publish` locally as described above |
