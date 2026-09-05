# Local issue files

Node.js 22.13+ is required for the bundled hash/validation helper; Issue Flow is not required.

Write issue.md with the title as its first non-empty H1. Run `scripts/artifacts.mjs issue <issue.md>` to obtain title, body and contentHash, using the same parser and SHA-256 normalization as the CLI. Do not calculate a different hash manually.

Write metadata.json with schemaVersion:1, id equal to the directory segment, number equal to a positive numeric id or null for a nonnumeric id, source:"local", title from the H1, labels as a string array, state:"open", createdAt/updatedAt as ISO timestamps, and contentHash from the helper. On a requested mirror only, remote includes provider:"github", ref (real URL), syncedAt and syncedContentHash.

Create only in a newly reserved directory inside the chosen consumer backlog. Reject traversal and symlink destinations. If any artifact already exists, preserve it and report a collision. Write the issue before metadata, then run `scripts/artifacts.mjs issue <issue.md> <metadata.json>`. Confirm metadata.id matches the destination directory as well.

Reading an existing issue with no metadata is supported; the title/body still come from issue.md. Malformed existing metadata must be reported. The user's files may be versioned in their own project; no global Issue Flow database is involved.
