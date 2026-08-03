You are drafting an issue for this repository.

The user provided this description:
__USER_PROMPT__

Steps:
1. Analyze the project's tech stack, architecture, and codebase
2. Check for duplicates before drafting:
   - Local issues: read `issues/*/metadata.json` (the directory may not exist)
   - Remote issues, only if `gh` is installed and authenticated:
     `gh issue list --state open --search "<keywords>"`
   If an existing issue already covers the request, still emit the draft, but
   say so in the body under a "Possible duplicates" section.
3. Emit the issue draft in the exact format below

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
<body>
Full issue body in markdown, including context and acceptance criteria.
</body>
</issue-draft>

Rules for the block:
- `<title>` and `<body>` are required; an empty one aborts the command
- `<labels>` is a comma-separated list; leave it empty when no label applies
- Only suggest labels that already exist in the repository, or that are
  conventional (`bug`, `enhancement`, `documentation`)
- Write the body as plain markdown — do not wrap it in a code fence
