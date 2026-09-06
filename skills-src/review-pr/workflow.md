# Review a Pull Request

Read execution-options and apply relevant accepted choices without activating implementation or publication. Read repository-policy, evidence and pr-review-result. Do not edit source code, commit, push, merge or publish a remote review/comment. Saving a requested report is the only permitted output-file change.

Resolve PR from explicit number/URL, then a known plan's pullRequest, then the open PR for the current head branch. With multiple matches choose the most recent and state the chosen PR before reviewing. If nothing resolves, ask for a PR reference. An associated issue/plan is optional.

Retrieve exact head/base SHAs, body, commits and file metadata. With gh use pr view <PR> --json number,title,body,headRefOid,baseRefOid,headRefName,baseRefName,commits,files,url and pr diff <PR> --name-only. For a paginated file/stat view use api --paginate repos/<owner>/<repo>/pulls/<PR>/files. The gh diff command does not support --stat or a trailing file path filter.

For full diffs use gh pr diff <PR>. To inspect a specific file, fetch the exact PR head/base refs without checking them out and use git diff <base-sha>...<head-sha> -- <path>. Never read an unrelated local HEAD as the PR revision. API patches can be truncated; obtain the full diff or report the coverage limit. A missing commit or inaccessible fork must not silently change the revision reviewed.

Prioritize core behavior, API/data changes and security-sensitive paths. Read surrounding code and callers; inspect tests, architecture, duplication, regressions, commit history, description and scope against requirements. Note generated/format-only files separately and disclose omitted coverage. Run relevant checks only against the revision actually reviewed, using an isolated checkout if needed and available.

Emit the eight-section report and final block from pr-review-result. Empty or draft PRs are valid review subjects; describe their state. Do not invent findings. Missing critical verification remains a blocker or incomplete review, never approval by omission.

Persist only when requested or when the caller supplied an artifact destination. Resolve the issue directory with the artifact helper and use additive pr-<PR>-round-N.md plus index.json in `paths.prReviewDir` (or the resolved `pr-<PR>` issue directory). Read both the index and existing round files, allocate max+1, preserve previous entries and refuse overwriting. Index: schemaVersion=1, pullRequest={number,url,title,headBranch} (unknown fields null), rounds entries with round, at, recommendation, headSha, reportPath and findings [{severity,file,line,title}] (file/line may be null). Return the saved path when applicable.
