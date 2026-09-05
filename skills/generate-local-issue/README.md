# generate-local-issue

Generates detailed, architect-quality issues as local files under `issues/<N>/issue.md` and `issues/<N>/metadata.json`, with no GitHub involved. Analyzes the project's actual stack and architecture before writing, allocates a collision-free identifier, and checks for duplicates against the existing local backlog.

Use it when the issue should not (or cannot) live on GitHub: offline, repository with no remote, `gh` not installed or not authenticated, or a demand that is still private. For issues that belong on GitHub, use [`generate-issue`](https://github.com/fabioassuncao/issue-flow/tree/main/skills/generate-issue).

## Usage

```
Create a local issue for adding rate limiting to the API
```

**Other trigger phrases:**
```
Criar issue local para o bug de sessão expirada
Open an issue offline about the broken auth flow
File this in issues/ without GitHub
Add this to the backlog locally
```

## What It Does

1. **Validates environment** — finds the project root; never requires `gh`
2. **Discovers the project** — scans the repo for stack, architecture, and conventions
3. **Detects project language** — matches the language used in existing local issues/README
4. **Analyzes the request** — expands the short instruction into a technical analysis
5. **Controls scope** — splits overly broad requests into separate issues (with user approval)
6. **Checks for duplicates** — reads `issues/*/metadata.json`, plus the remote backlog when `gh` happens to be available
7. **Allocates the identifier** — above every local number *and* every remote Issue/PR number when reachable
8. **Writes the issue** — `issue.md` (H1 title + structured body) and `metadata.json` (validated against `issueMetadataSchema`)
9. **Verifies** — parses the metadata back and checks title, number, and content hash consistency

## File Format

```
issues/
└── 42/
    ├── issue.md        # H1 = title, everything after = body
    └── metadata.json   # schemaVersion, id, number, source, title, labels,
                        # state, createdAt, updatedAt, contentHash, remote?
```

- `issue.md` is the source of truth for the content — the content hash is always recomputed from it, so a hand-edited file is never reported as unchanged.
- `metadata.json` is optional for reading (the provider derives minimal metadata from `issue.md` alone), but this skill always writes both.
- `number` is `null` for non-numeric identifiers such as `spike-auth`.
- `remote` is filled only when the local issue mirrors a GitHub one, and then all four fields (`provider`, `ref`, `syncedAt`, `syncedContentHash`) are required.

## Issue Structure

Each generated issue includes:

- Context and Motivation
- Current State Diagnosis
- Identified Problems
- Objectives
- Proposed Solution
- Alternatives Considered
- Pros and Cons
- Execution Plan (with checkboxes)
- Risks and Precautions
- Acceptance Criteria (with checkboxes)
- Expected Outcome
- Related Issues / Notes

## After Creation

```bash
issue-flow run 42 --local
```

The CLI equivalent of this skill is `issue-flow generate --prompt "..." --local` (or `--both` to create on GitHub and mirror locally).

## Requirements

- **Git** (to locate the project root) and a writable project directory
- **GitHub CLI** (`gh`) — optional, used only to allocate an identifier above the remote numbering space
