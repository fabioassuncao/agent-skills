# CLI development and release

Start with the root [Contributing guide](../../CONTRIBUTING.md) for environment
setup, the issue-to-PR process and common validation. This page covers local CLI
testing, packaging and maintainer releases. All commands run from
`packages/issue-flow` unless a different directory is shown.

## Prerequisites

Use the [shared development environment](../../CONTRIBUTING.md#set-up-the-repository).
Real CLI runs additionally need the selected
[agent and authentication](../../docs/agents.md), plus authenticated `gh` for
GitHub work. Publishing requires an npm account with access to `issue-flow`.

## Development setup

Follow [repository setup](../../CONTRIBUTING.md#set-up-the-repository).

### Project structure

The [architecture and code map](../../docs/code-organization.md) owns the
repository layout and module responsibilities. `prompts/` and `web/public/`
are resolved relative to the installed package, which is why both are listed
in `package.json`'s `files`. Add any new runtime asset directory there too, or
it may work locally and fail after installation.

## Available scripts

See [common validation](../../CONTRIBUTING.md#validate-your-change) for the
shared gate. Use `npm run dev` for a build watcher, `npm run lint` for Biome,
`npm run typecheck` for TypeScript, or `npm run format` to apply formatting.
Local execution and packaging checks follow below.

## Local testing

### 1. Deterministic checks

Run the [common checks](../../CONTRIBUTING.md#validate-your-change) first.
`npm run test:watch` reruns unit tests on edits; `npm run test:integration` runs
the integration suite. `npm run smoke` builds the CLI and drives disposable Git
repositories against deterministic stand-ins for the agent and `gh`, with no
network or tokens. Pass `--keep` to inspect the fixture workspaces.

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

After building, `npm run skills:cli-test` packs and installs the CLI in a
temporary directory, runs the complete fixture pipeline without Skills, and
checks optional integration with a copied Skill. It needs registry access for
runtime dependencies and does not modify your global installation.

```bash
# Reject stale generated resources before packing
npm run skills:check

# Generate the tarball without publishing (prepack checks drift, then builds)
npm pack

# Check the contents: dist/, prompts/, web/public/, package.json, README, LICENSE
tar -tzf issue-flow-*.tgz

# Test installation from the tarball
cd /tmp
npm install /path/to/issue-flow-0.12.0.tgz
npx issue-flow --help
```

## Release process

Releases are **manual**. There is no CI job that publishes to npm — the only
workflow in the repository is `.github/workflows/ci.yml` (Skill drift, isolation,
corpus validation, lint, typecheck, tests and build for main pushes and pull
requests targeting main; installer and packed CLI checks also run on Linux/Node
22). Everything below is run from a local
machine by a maintainer with publish rights on the `issue-flow` npm package.

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
  `prepublishOnly` (Skill drift + isolation tests + lint + typecheck + unit tests) and then `prepack`
  (`skills:check`, then `npm run build`). A failing check aborts the publish, and `dist/` is always
  rebuilt from the current sources — a stale build cannot be published.
- **`npm run build` regenerates Skills and prompts, then compiles the CLI.**
  `npm pack` runs `prepack`, which checks drift before building; stale committed
  artifacts therefore fail packaging rather than being silently repaired.
  Regenerate and commit sources and artifacts together before release. Packing
  does not run `prepublishOnly`. Publishing the npm CLI does not install Skills
  into a user's agent; Git-based Skill distribution follows the selected
  repository revision. See the [generation contract](../../docs/skills.md#sync-check-and-test).

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

# 5. Publish — runs prepublishOnly (Skill checks, lint, typecheck, tests) and prepack (build)
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

## Agent Skills and prompt contracts

Read [Authoring and distributing Skills](../../docs/skills.md) before changing
Skill sources, shared contracts or CLI prompt templates. That guide owns the
source/artifact boundary and the complete generation and validation sequence.
The [eval guide](../../docs/skills-evals.md) covers optional live-model evidence.
The CLI must keep loading its own packaged resources without installed Skills.
