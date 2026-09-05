# The local issue files

A local issue is two files in a directory named by its identifier. `issue.md`
is the source of truth for the **content**; `metadata.json` for everything else.

```text
issues/<id>/
├── issue.md
└── metadata.json
```

Write `issue.md` **first**, then `metadata.json` — so the hash always describes
content that is already on disk.

## `issues/<id>/issue.md`

The **first non-empty line must be the H1 holding the title**. The body is
everything after it. A heading further down belongs to the body and is never
promoted to the title.

```markdown
# [Enhancement] Concise description

## Context and Motivation

…
```

## `issues/<id>/metadata.json`

Every field is required except `remote`.

```json
{
  "schemaVersion": 1,
  "id": "42",
  "number": 42,
  "source": "local",
  "title": "[Enhancement] Concise description",
  "labels": ["enhancement", "backend"],
  "state": "open",
  "createdAt": "2026-01-31T12:00:00.000Z",
  "updatedAt": "2026-01-31T12:00:00.000Z",
  "contentHash": "sha256:<hex>"
}
```

| Field | Rules |
|---|---|
| `schemaVersion` | literal `1`. Not optional, no default |
| `id` | non-empty string, equal to the directory name |
| `number` | positive integer for a numeric identifier, `null` for a non-numeric one (`"spike-auth"`). **Never `0`** |
| `source` | `"local"` |
| `title` | byte-identical to the H1 in `issue.md` |
| `labels` | array of strings, `[]` when none. Never omit the key |
| `state` | `"open"` on creation; `"closed"` once the work finishes |
| `createdAt` / `updatedAt` | ISO 8601. Equal on creation |
| `contentHash` | `sha256:<hex>` over the normalised title and body — see below |
| `remote` | optional. When present, **all four** of `provider`, `ref`, `syncedAt`, `syncedContentHash` are required. Only for a mirror of a remote issue |

A timestamp:

```bash
node -e 'process.stdout.write(new Date().toISOString())'
# or
python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'),end='')"
# or
date -u +%Y-%m-%dT%H:%M:%S.000Z
```

## `contentHash`

The hash is what tells "the local and the remote issue are the same demand" from
"they diverged". It is the SHA-256 of the canonical JSON
`{"title":…,"body":…}`, with CRLF and CR normalised to LF and both fields
trimmed.

**Compute it from the file you just wrote — never by hand:**

```bash
scripts/content-hash.sh issues/<id>/issue.md
```

Resolve `scripts/content-hash.sh` from the directory containing this Skill’s
`SKILL.md`, not from the project root. Pass the absolute path of the issue file;
run it with a POSIX shell. It needs `node` or `python3`, with no npm packages.

## Identifiers

The identifier is the directory name, and it shares a numbering space with
GitHub issues **and** pull requests — which share a single counter. Allocating
above the local maximum alone is therefore not enough when a remote exists.

1. **Highest local number** — the maximum across numeric directory names in
   `issues/` and the `number` field of every `issues/*/metadata.json`. No
   directory means `0`.
   ```bash
   ls issues/ 2>/dev/null
   cat issues/*/metadata.json 2>/dev/null | grep '"number"'
   ```
2. **Highest remote number**, only when remote coordination was requested and
   `gh` answers — an unavailable lookup contributes `0` and is not a guarantee
   against future GitHub collisions:
   ```bash
   gh issue list --state all --limit 1 --json number 2>/dev/null || true
   gh pr list    --state all --limit 1 --json number 2>/dev/null || true
   ```
3. **Allocate** `max(local, remote) + 1`.

Identifiers are path segments: reject anything containing `/` or `\`, and reject
`.` and `..`. A leading `#` is stripped.

**Mirroring a remote issue:** skip the allocation and reuse the remote number as
the identifier, so the two are one demand in two places rather than two
unrelated issues. Fill `remote` with all four fields.

## Never overwrite

Before writing anything:

```bash
test -e "issues/<id>" && echo COLLISION
```

On a collision, stop:

> The directory `issues/<id>/` is already occupied. Pick another identifier.

Reserve the new directory with an exclusive create (`mkdir` without `-p` for
the final path). If that fails, stop or choose another identifier; never write
through an existing directory or symlink.

## Verify

```bash
ls issues/<id>/
node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf-8"))' issues/<id>/metadata.json
```

Then check by eye:

- the H1 in `issue.md` is byte-identical to `title` in `metadata.json`;
- `number` matches the directory name, or is `null` for a non-numeric id;
- `contentHash` came from the final `issue.md`, not from a draft.
