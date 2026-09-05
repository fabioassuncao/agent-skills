#!/usr/bin/env sh
# Compute the contentHash of a local issue file.
#
# The hash is SHA-256 over the canonical JSON {"title":...,"body":...}, with
# CRLF/CR normalised to LF and both fields trimmed. The title is the first
# non-empty line when it is an H1; everything after it is the body.
#
# Doing this by hand gets it wrong in ways nothing catches until a sync claims
# two identical issues diverged — which is why it is a script and not a
# paragraph of instructions.
#
# Usage: scripts/content-hash.sh issues/<id>/issue.md
set -eu

if [ $# -ne 1 ]; then
  echo "usage: content-hash.sh <path-to-issue.md>" >&2
  exit 2
fi

file=$1

if [ ! -f "$file" ]; then
  echo "content-hash.sh: no such file: $file" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  exec node -e '
    const { createHash } = require("node:crypto");
    const { readFileSync } = require("node:fs");
    const raw = readFileSync(process.argv[1], "utf-8").replace(/\r\n?/g, "\n");
    const lines = raw.split("\n");
    const i = lines.findIndex((l) => l.trim().length > 0);
    const m = i === -1 ? null : lines[i].match(/^#[ \t]+(.*)$/);
    const title = m ? m[1].trim() : "";
    const body = m ? lines.slice(i + 1).join("\n").trim() : raw.trim();
    const payload = JSON.stringify({ title, body });
    process.stdout.write("sha256:" + createHash("sha256").update(payload, "utf8").digest("hex"));
  ' "$file"
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 - "$file" <<'PY'
import hashlib, json, re, sys

raw = open(sys.argv[1], encoding="utf-8").read().replace("\r\n", "\n").replace("\r", "\n")
lines = raw.split("\n")
i = next((n for n, l in enumerate(lines) if l.strip()), None)
m = re.match(r"^#[ \t]+(.*)$", lines[i]) if i is not None else None
title = m.group(1).strip() if m else ""
body = "\n".join(lines[i + 1:]).strip() if m else raw.strip()
payload = json.dumps({"title": title, "body": body}, separators=(",", ":"), ensure_ascii=False)
sys.stdout.write("sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest())
PY
fi

echo "content-hash.sh: needs node or python3 on the PATH" >&2
exit 1
