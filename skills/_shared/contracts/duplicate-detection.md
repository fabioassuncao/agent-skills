# Duplicate detection

One query finds only issues worded the way you happened to word yours. This is a
**multi-strategy search**, and the judgement at the end is about the *problem*,
not about textual overlap.

## Search the local backlog

Always, and first — it needs no network and no `gh`:

```bash
ls -d issues/*/ 2>/dev/null
cat issues/*/metadata.json 2>/dev/null
```

`issues/` may not exist. That is a normal empty backlog, not an error.

For a candidate whose title looks related, read the whole thing:

```bash
cat issues/<candidate>/issue.md
```

## Search the remote backlog

Only when `gh` is installed and authenticated (or an equivalent GitHub tool is
available through MCP). Never fail when it is not — append `|| true`.

**Strategy 1 — keywords.** Extract 3-5 keywords from the title and the core
problem, and run 2-3 *different* combinations:

```bash
gh issue list --search "<keyword1> <keyword2>" --state all --limit 30 \
  --json number,title,state,url,labels 2>/dev/null || true
```

**Strategy 2 — area.** When the request names an area (auth, database, API,
billing…), search for it on its own.

**Strategy 3 — label.** When the request maps to a label the repository actually
has, list by that label:

```bash
gh issue list --label "<relevant-label>" --state all --limit 20 \
  --json number,title,state,url 2>/dev/null || true
```

## Judge each candidate

| Dimension | Question | Weight |
|---|---|---|
| **Intent** | Do both aim to solve the same underlying problem? | High |
| **Domain** | Do they affect the same area or module? | Medium |
| **Approach** | Do they propose similar solutions? | Low |

| Verdict | Meaning |
|---|---|
| **High** — intent *and* domain match | Duplicate |
| **Partial** — same domain with different intent, or the reverse | Ask the user |
| **Low** — only superficial textual overlap | Not a duplicate; proceed |

## What to do about it

- **Duplicate, open.** Do not create a new issue. Add whatever new context or
  analysis your work produced to the existing one, tell the user what you did,
  and give them its URL or path.
- **Duplicate, closed.** Ask: reopen it, create a new issue referencing it, or
  skip.
- **Partial.** Ask whether to extend the existing issue or create a new, more
  specific one. Do not decide unilaterally.
- **None found across every strategy.** Proceed.

When the surface you are writing to is local files and the duplicate exists only
on GitHub — or the reverse — say so and ask which the user wants. A deliberate
mirror is legitimate; a silent second copy is not.
