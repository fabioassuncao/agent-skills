# Issue input and artifact ownership

Accept an explicit GitHub URL/number, a local issue file/directory, or complete issue content supplied by the user/caller. An explicit source wins. With only an identifier, inspect issues/<id>/issue.md; otherwise resolve the GitHub repository from the current remote. When both sources are supplied or known to differ, ask which source to use rather than silently switching. Local-only requests must not perform remote probes.

For local input, the first non-empty line of issue.md is the H1 title and the remaining text is the body. Metadata is optional when reading; if present, report malformed metadata instead of inventing values. Identifiers are single path segments: reject slash, backslash, dot/dot-dot, and non-positive numeric identifiers.

For GitHub input, use an available authenticated GitHub capability. A gh example is issue view <number> --repo <owner/repo> --json title,body,labels,comments,state,url. Fetch linked context only when relevant. Missing access is a retrieval failure, not an empty issue. If complete content was supplied, work from it and state any limits on remote verification.

Default Skill artifacts are issues/<id>/ in the consumer repository: prd.md, tasks.json, progress.txt and review reports. Honor explicitly supplied artifact paths. Resolve paths against the consumer project, not the installed Skill directory. Never overwrite a different issue/branch's work; archive only with authorization, to a fresh directory without overwriting an earlier archive.

CLI-managed global state is a different surface. Do not infer a resumable CLI session from these local artifacts, and do not write CLI-owned runState, executions, locks or telemetry. Preserve unknown fields in an existing task plan when updating your owned fields.
