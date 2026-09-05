# Contributing to Issue Flow

[Project overview](README.md) · [Architecture](docs/code-organization.md) · [Project status](docs/project-status.md)

## Choose a contribution

Contributions can improve documentation, portable Agent Skills, shared rules or
the experimental CLI. Start with the issue's problem, scope and acceptance
criteria. Use the repository's [issue templates](.github/ISSUE_TEMPLATE/) to
report a bug or propose work, and follow existing discussion before expanding
its scope.

| Area | Read next |
|---|---|
| Documentation | [Documentation ownership](#documentation-ownership) |
| Skill instructions, helpers or CLI prompt contracts | [Authoring Skills](docs/skills.md) |
| Skill behavior and evidence | [Behavioral evals](docs/skills-evals.md) |
| CLI code and dashboard | [Code organization](docs/code-organization.md) and [CLI development](packages/issue-flow/CONTRIBUTING.md) |

## Set up the repository

For local development, use **Node.js ≥22.13.0**, **npm ≥9** and **Git**.
Clone your fork if you will contribute through one; the upstream checkout is:

```bash
git clone https://github.com/fabioassuncao/issue-flow.git
cd issue-flow/packages/issue-flow
npm ci
npm run skills:check
```

All npm scripts run from `packages/issue-flow`. Check committed Skill and prompt
artifacts before generating anything, so stale distribution files remain visible.
A prose-only edit can be made without installing dependencies; the environment
above is needed to run repository checks.

Node, npm and Git are sufficient for deterministic checks. Authenticated coding
agents and GitHub access are needed for real runs or live evals, not unit or
isolated fixture tests. Installer and packed-package checks can need network
access; the optional global installer check also needs Docker. See
[validation requirements](docs/skills.md#sync-check-and-test).

## Work from an issue

1. Read the issue and the applicable `AGENTS.md` indexes, starting with the
   [root index](AGENTS.md), then follow their source documents.
2. Establish the requested scope and observable acceptance criteria. An open
   Idea, Research or Epic is not itself authorization to implement; see
   [issue conventions](docs/conventions.md#six-issue-types).
3. Use a dedicated branch and the existing
   [branch and commit conventions](docs/git-conventions.md).
4. Make the focused change and collect fresh evidence against its requirements.
5. Submit a PR using the [repository template](.github/PULL_REQUEST_TEMPLATE.md).

[Agent Skills](skills/README.md) are the recommended assistant workflow, but
using an agent is not required to contribute. `resolve-issue` can prepare a PRD
and plan in manual mode, then continue when implementation is requested.
Ordinary editor-based contributions follow the same issue and review process.

## Validate your change

For code changes, run the common gate and relevant tests from the package:

```bash
npm run check
npm test
npm run build
```

`check` runs Biome read-only and TypeScript checking. `npm run fix` applies
Biome changes and then typechecks; inspect its diff when you use it.

- **Documentation:** verify relative links, heading anchors, examples and rendered
  Markdown. Check that a new reader can complete the affected navigation path.
  Run `skills:check` to confirm distribution consistency; no sync or live model
  run is needed for changes confined to human-facing documentation.
- **Skills or prompt sources:** follow the canonical
  [sync, check and test sequence](docs/skills.md#sync-check-and-test). Edit sources
  and commit their generated artifacts together; never fix generated copies.
- **CLI behavior or packaging:** follow
  [local CLI testing](packages/issue-flow/CONTRIBUTING.md#local-testing), including
  smoke or packed-package checks when relevant.

The [CI workflow](.github/workflows/ci.yml) defines the full platform matrix.
Live model evals are opt-in and consume tokens; they are not required for an
ordinary contribution.

## Submit a Pull Request

Explain the problem and resulting behavior, list the checks you ran and what
they established, and link the related issues. Follow the existing PR template
and [Git conventions](docs/git-conventions.md#pull-requests). Include material
limitations or checks you could not run. Human review of the diff and evidence
remains necessary before merging.

## Documentation ownership

Keep the README focused on purpose, the recommended Skill workflow and where
to continue reading. Maintain procedural and reference details in their owners:

| Information | Owner |
|---|---|
| Skill installation, usage and catalog | [Skills guide](skills/README.md) |
| CLI onboarding and reference navigation | [CLI guide](docs/cli.md) |
| CLI commands and configuration | [Commands](docs/commands.md) and [Configuration](docs/configuration.md) |
| Maturity and precautions for both interfaces | [Project status](docs/project-status.md) |
| Architecture and code placement | [Code organization](docs/code-organization.md) |
| Skill source/artifact contract | [Authoring Skills](docs/skills.md) |
| Conventions and Git naming | [Conventions](docs/conventions.md) and [Git conventions](docs/git-conventions.md) |

Summarize and link instead of copying complete procedures. Use relative links
within the repository; the npm README uses full repository URLs because the
docs are not packaged. Keep documentation in English, identify CLI-specific
behavior, and distinguish recommended use from stability. Preserve useful old
anchors when moving a guide. Dated research records evidence rather than rules.
`AGENTS.md` files remain indexes as defined by
[the entry-point policy](docs/conventions.md#agent-entry-points).

## Architecture and maintainer tasks

Read [Architecture and code organization](docs/code-organization.md) for the
repository map, generation flow and runtime boundaries. The
[CLI contributor guide](packages/issue-flow/CONTRIBUTING.md#release-process)
owns the manual npm release procedure. Publishing the CLI and distributing
Skills from Git are separate activities.
