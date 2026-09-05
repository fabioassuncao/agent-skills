## Evidence before completion

Use fresh evidence from the revision being delivered. Read the repository's test/build instructions and execute the relevant checks after the final meaningful change. Record commands, results and material coverage limits. An earlier green run, a checked checkbox or another agent's claim is not current verification.

If a required check fails or cannot run, report the failure or unverified criterion. Do not mark that criterion passed or emit a completion/approval signal. Discover checks appropriate to the stack; do not require TypeScript checks in a project without TypeScript. For UI acceptance, use an available browser capability and record what was exercised; missing browser verification remains pending when required.

For bug fixes, reproduce the defect with a focused check before correcting it when the repository and environment permit. Follow existing testing conventions; do not impose universal TDD or tests that merely restate the implementation.

Evaluate review feedback against the code and requirements before applying it. Reproduce valid defects where feasible. Record why an incorrect or inapplicable finding was rejected, with evidence, rather than changing code just to satisfy its wording. Re-review after valid fixes.
