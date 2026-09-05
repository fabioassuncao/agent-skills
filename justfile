# Thin entry points over the npm scripts. The CI runs npm directly; nothing here
# holds logic of its own, so the two can never disagree.

pkg := "packages/issue-flow"

_default:
    @just --list

# Regenerate the contracts the CLI prompts include (a build artifact).
sync:
    cd {{pkg}} && npm run skills:sync

# Validate the skills as they are in this tree, and the prompt contracts.
check:
    cd {{pkg}} && npm run skills:check

# Assemble the publishable skills tree into dist/skills.
build:
    cd {{pkg}} && npm run skills:build

# Assemble it and validate it strictly — what CI does before publishing.
verify:
    cd {{pkg}} && npm run skills:verify

# The full gate: lint, types, skills, tests, build.
ci:
    cd {{pkg}} && npm run lint && npm run typecheck && npm run skills:check && npm test && npm run build
