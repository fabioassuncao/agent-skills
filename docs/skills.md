# Authoring and distributing Skills

User installation and usage live in [the Skills guide](../skills/README.md). This document defines the repository's source/artifact contract.

## Source and distribution

```text
skills-src/<name>/SKILL.md.in       authored entry point
skills-src/<name>/workflow.md       authored phase procedure
skills-src/_shared/                 authored shared references
skills-src/manifest.json            explicit resource mapping
packages/issue-flow/src/            canonical pure rules and schemas
packages/issue-flow/scripts/skill-entries/   bundling entry points
packages/issue-flow/prompts-src/    authored CLI prompt templates
                  |
             skills:sync
                  |
          +-------+-------+
          |               |
skills/<name>/       packages/issue-flow/prompts/
 SKILL.md             standalone CLI resources
 LICENSE.txt
 references/
 scripts/
 assets/ (when needed)
```

Edit the sources, never a generated copy. `.gitattributes` marks distribution files and packaged prompts as generated for review. Commit sources **and** generated `skills/` and `prompts/` together. The Git repository is directly installable without a postinstall/build hook. `.md.in` prevents installers recursively discovering a second source copy of each Skill. Root `skills/README.md` is the authored user guide and `skills/AGENTS.md` is an authored index, both excluded from generation; neither is a required dependency of an installed Skill. `skills-src/AGENTS.md` points contributors to this contract.

Version sources, the manifest, dependency lockfile, tests, scenarios and documentation. Ignore package `node_modules/`, `dist/` and `.cache/`. Local `issues/` work is not ignored by this repository's committed `.gitignore` files; inspect artifacts before staging. Generated distribution files are intentionally **not ignored**. Dated, selected synthetic eval reports under `docs/research/` are committed evidence; routine runner output stays in the ignored cache. See [eval evidence](skills-evals.md#contracts-and-interpretation) before retaining a report.

`manifest.json` maps each artifact-relative destination to one repository-relative source. Shared references are copied at build time. The orchestrator receives phase procedures from the very same files used by the individual Skills. There are eleven independent artifacts, not eleven author-maintained copies of shared rules.

Invocation vocabulary and choice propagation live in `skills-src/_shared/execution-options.md`. It delegates source ownership to issue-input, policy discovery to repository-policy and Git behavior to git-conventions. Changes to these contracts must reach standalone consumers and resolve-issue through the manifest. Options belong in the request/body, not proprietary frontmatter. The CLI runtime and its persisted configuration remain independent.

Pure TypeScript modules remain canonical for Git conventions/default taxonomy, issue Markdown parsing, body hashes, task-plan/metadata schemas and scaffold renderers. `esbuild` bundles small Node entry points, including their libraries, into each consuming Skill. Runtime imports may use Node built-ins; no `node_modules` or Issue Flow installation is needed. Bundled third-party licenses are copied alongside the affected helpers. The CLI still compiles its own code and loads its own packaged prompts. No runtime imports point into `skills/` or `skills-src/`.

Distributed helper scripts must remain readable and unminified, including bundled dependencies. Preserve indentation, descriptive identifiers, module source comments and legal notices so users can inspect the installed code. Larger artifacts are an accepted tradeoff for auditability. Each bundle's header identifies its canonical entry point and regeneration command; module comments identify the included source files. These repository paths are provenance information, not runtime dependencies. Change the original source and run `skills:sync`; do not format or edit generated copies manually. Regression tests check readable output alongside existing isolated execution tests.

Small prose contracts with real parity requirements (repository decisions, PR metadata, evidence, publication, structured review results) are composed into CLI prompts using `<!-- contract:name -->`. The directive reads one `_shared/name.md` file at generation time. It is not a runtime template language or a plugin API. Existing CLI placeholders, conditional sections and user prompt overrides are preserved. A replacement prompt remains the consumer's maintenance responsibility.

## Format and disclosure

The normative format is [Agent Skills](https://agentskills.io/specification). The portable subset used here is `name`, `description`, optional `license`, `compatibility` and string-valued `metadata`. `name` must match the directory, be lowercase hyphen-separated alphanumeric text, and fit 64 characters. Descriptions must be nonempty and fit 1024 characters; compatibility text fits 500. Experimental `allowed-tools` and provider-specific invocation/permission fields are deliberately excluded from canonical artifacts.

Describe the user task, when to select it and its important boundary. A near-neighbor negative case is more useful than institutional marketing. Keep the entry point below 500 lines and focused on responsibility, prerequisites, main workflow and when to load each resource. Link every required resource directly from `SKILL.md`. Detailed workflows, formats and conditional guidance belong in `references/`; executable helpers in `scripts/`; static templates in `assets/` when a real need exists. Do not add empty directories just to match a diagram.

Use semantic capabilities: read, search, edit, execute, retrieve. Specific tools are examples or documented optional integrations. Do not assume `Read`, `Task`, slash-command interpolation or a specific provider's subagent mechanism. Paths inside the Skill resolve from its installation directory; inputs and outputs resolve from the consumer project. The distinction must be explicit. External documentation URLs can provide background, but essential execution knowledge must ship locally.

## Sync, check and test

Run in `packages/issue-flow`:

```bash
npm ci
npm run skills:check    # inspect committed artifacts before any generation
npm run skills:sync     # regenerate after source changes
npm run skills:check
npm run skills:test
npm run skills:eval -- --check
npm run check
npm test
npm run build
npm run skills:install-test
npm run skills:install-test -- --global-container
npm run skills:cli-test
```

Run `skills:check` once immediately after `npm ci` when reviewing a checkout,
before any sync, to detect stale committed artifacts. Run sync after source
edits. `build` compiles the CLI; it does not regenerate Skills or prompts.
`skills:cli-test` packs the existing build with lifecycle scripts disabled, so
build first. Installer tests require Git; the global variant additionally
requires Docker, may pull its pinned Node image, and fetches the pinned Skills
installer from npm inside the container. Packed CLI tests install
runtime dependencies from npm, so registry access or a populated cache is needed.

The generator assembles expected bytes before writing, rejects conflicting/escaping sources and produces deterministic bundles. Repeating sync without source/dependency changes produces no diff. `skills:check` is read-only: it compares exact bytes and file sets, then validates all eleven artifacts. CI calls check **without running sync first**, so forgotten generation fails rather than being hidden. CI also exercises installer output and the packed CLI on Linux/Node 22. Dependency versions are locked; intentional compiler upgrades can change generated bundles and require regeneration.

Checks cover YAML, names/types/lengths, resource links and anchors, code-path references, escaping paths, symlinks, unresolved generation directives, external JavaScript imports, unexpected files, known proprietary tool instructions and silent CLI invocations. The parser uses a Markdown AST and a real YAML parser. Project-specific lints are stricter than the standard where portability requires it. Static analysis cannot prove the meaning of every sentence or dynamically constructed path; review and behavioral evals cover those limits.

Isolation tests copy each Skill to a temporary directory, validate the closure there, and run every helper without the repository. Behavioral helper tests exercise parsing/hashing, schema errors, naming precedence, non-destructive scaffold output and optional CLI failures. Installer tests use pinned Vercel Skills against a disposable Git checkout, compare every installed file byte-for-byte and validate installed references. Global tests use a disposable Docker user rather than changing your personal Skill collection. Slow model evals are separate and opt-in; [their format and interpretation](skills-evals.md) matter as much as a green score.

## Add or change a Skill

1. Create `skills-src/<name>/SKILL.md.in` and its focused procedure. Define positive/negative triggering and observable outcomes first.
2. Add its explicit resources to `manifest.json`. Reuse a source only when the underlying rule truly must remain equivalent. Avoid copying sibling artifacts or referencing repository implementation at execution time.
3. Put a pure helper entry in `scripts/skill-entries/` only for a deterministic capability worth sharing with the CLI. Helpers should provide `--help`, useful errors and no implicit writes.
4. Add positive, negative and behavior cases to `evals/skills/scenarios.json`; add meaningful helper/isolation regression coverage when appropriate.
5. Sync, check, test and install the new directory alone. Inspect its actual dependencies. Update the capability index and audit when responsibility changes.

The shared `pr-metadata.md` contract is bundled into create-pr/resolve-issue and composed into the packaged CLI PR prompt. It governs metadata discovery, application and confirmation without adding runtime state or a universal label taxonomy.

An integration with the CLI must classify the operation: direct capability (A, remove CLI dependence), optional optimization (B, bounded probe plus direct fallback), or exclusive runtime capability (C, explicit requirement and reconsider whether it belongs in a Skill). Current Skills have no category-C dependency. Locks, SQLite, persistent orchestration and lifecycle remain in the CLI. Do not hide a CLI download in a fallback or write to its internal state.
