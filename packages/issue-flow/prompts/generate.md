You are drafting an issue for this repository.

The user provided this description:
__USER_PROMPT__

Steps:
1. Analyze the project's tech stack, architecture, and codebase
2. Decide the **human language** to write in, in this order of priority:
   1. the language the user's request is written in;
   2. the predominant language of the repository's existing issue titles
      (`gh issue list --limit 10 --state all --json title --jq '.[].title'`);
   3. the language of the README;
   4. the language the user wrote in.

   Use it for the title and the whole body. A backlog written in two languages
   is harder to search than one written in the "wrong" one.
3. Check for duplicates before drafting. This is a **multi-strategy search** —
   one query finds only issues worded the way you happened to word yours:
   - Local issues: read `__LOCAL_ISSUES_DIR__/*/metadata.json` (the directory may not exist)
   - Remote issues, only if `gh` is installed and authenticated:
     - 2-3 different keyword combinations drawn from the title and the core problem:
       `gh issue list --search "<keyword1> <keyword2>" --state all --limit 30 --json number,title,state,url`
     - the affected area, when the request names one (auth, database, API…)
     - a label the request maps to, when the repository has a matching one
   Judge a candidate on whether it describes the **same problem**, not on textual
   overlap. If an existing issue already covers the request, still emit the draft,
   but say so in the body under a "Possible duplicates" section, citing the issue.
4. Emit the issue draft in the exact format below

The issue should:
- Have a clear, descriptive title
- Include context about why the change is needed
- Include acceptance criteria

Do NOT create the issue. You are only drafting it: issue-flow persists the
draft to the destination the user picked (GitHub, local files, or both).

IMPORTANT: your final message must end with exactly one block in this format,
with no surrounding commentary:

<issue-draft>
<title>Concise, descriptive title</title>
<labels>label-one, label-two</labels>
<type>Issue Type, when the repository has them</type>
<template>path of the Issue Template followed, when there is one</template>
<body>
Full issue body in markdown, including context and acceptance criteria.
</body>
</issue-draft>

Rules for the block:
- `<title>` and `<body>` are required; an empty one aborts the command
- `<labels>` is a comma-separated list; leave it empty when no label applies
- **Only suggest labels that already exist in this repository.** Never invent
  one, and never create one. A label that does not exist is dropped before the
  issue is created, so inventing one silently loses the classification. When the
  section below lists the repository's labels, that list is exhaustive.
- `<type>` and `<template>` are optional: omit them entirely unless the section
  below shows that this repository has Issue Types or Issue Templates
- Write the body as plain markdown — do not wrap it in a code fence

<!-- if:__REPO_POLICY__ -->
## Repository policy

The repository this runs in declares the conventions below. They were discovered
from its own files (Issue Templates, labels, `AGENTS.md`, `CONTRIBUTING.md`,
`CODEOWNERS`) and from its configuration.

__REPO_POLICY__

**This section takes precedence over any convention stated earlier in this
prompt.** Where the two disagree, follow the repository. Where the repository is
silent, the defaults above still apply.

Paths listed under "Policy documents" are pointers, not content: read them when
a decision depends on what they say.

Use the repository's applicable issue template instead of layering another body template over it. Fill required fields; ask when two templates fit equally. Keep the PR template's sections, explaining non-applicable ones briefly.

Use existing label casing. Never create a label unless explicitly opted in by issues.allowLabelCreation and the action is authorized. Drop labels known to be absent; report lost classification. When the registry is unavailable, report that validation could not be performed rather than claiming the label does not exist. Local metadata labels are free-form and should reuse the local vocabulary.

Prefer native fields over labels and textual prefixes. Do not reintroduce a type prefix when the repository uses native Issue Types unless its declared title convention requires it. Defaults apply only to undeclared choices; obtain the fallback taxonomy from the bundled conventions helper where supplied.

### Drafting against this repository's conventions

- **Issue Templates.** When the section above lists them, pick the one that fits
  the request — by its name and description — and write the body to *its*
  structure, filling every field it marks as required. Report the one you chose
  in `<template>`. The default structure described earlier in this prompt is the
  fallback for a repository with no template, not a floor to add on top of one.
  If two templates fit equally well, say so in the body and pick the more
  specific: choosing a type is the author's call, and a wrong guess is easier to
  correct when it is stated.
- **Issue Types.** When the section above lists them, choose one and put it in
  `<type>`. A repository with Issue Types has usually *removed* the equivalent
  textual prefix from titles (`[Bug]`, `[Enhancement]`) precisely because the
  information moved into a structured field — do not reintroduce it.
- **Labels.** Use only the ones listed. Anything else is dropped.
- **Title.** Follow the convention shown above when there is one.
<!-- /if -->

## Authorized publication

A request to analyze, plan or review does not itself request a remote comment, closure, push or PR. Publish only when the user's request or existing session authorization includes that action. Preparing a concrete draft, diff and verification result comes before asking for any missing authorization. Do not ask again for authorization already granted.

Before creating an issue or PR, check for an existing equivalent item. Reuse a matching open PR instead of creating another. Updating, closing or reopening an existing item requires authorization for that action. On an uncertain publication result, query the remote before retrying to avoid duplicates.

Pass user text as structured tool arguments or a UTF-8 body file, never shell interpolation. Use argument arrays for commands. Verify success before deleting a draft. If publishing fails, preserve the draft and report the failed operation and actionable reason. Never force-push.
