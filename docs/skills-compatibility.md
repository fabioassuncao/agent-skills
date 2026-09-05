# Agent Skills compatibility

Documentation checked on **2026-09-05**. This is a capability comparison, not a
certification that every Issue Flow Skill has executed in every product.
`S` = open specification; `D` = documented host support; `E` = host-specific
extension; `?` = not established by the cited page; `—` = outside its scope.
Observed smoke results are recorded separately in the
[audit](research/2026-09-05-agent-skills-portability.md#behavioral-smoke).

## Capability matrix

| Capability | Agent Skills spec | Claude Code | Codex | OpenCode | Antigravity CLI | Cursor | Copilot CLI | Gemini CLI |
|---|---|---|---|---|---|---|---|---|
| `SKILL.md` | S, required | D | D | D | ? CLI documents flat `.md` files | D | D | D |
| `name` / `description` | S, required | D (host can infer name) | D | D | D | D | D | D |
| `references/` | S, optional | D | D | ? resources through host tools | ? CLI resource resolution | D | D bundled resources | D bundled resources |
| `scripts/` | S, optional | D, host permissions | D, host permissions | ? execution policy | ? CLI bundling | D | D | D bundling; execution permissions separate |
| `assets/` | S, optional | D supporting files | D | ? | ? CLI bundling | D resources | D resources | D resources |
| Progressive disclosure | S, recommended | D | D | D on-demand load | ? CLI; D general app | D | D | D |
| Tool restrictions | Experimental `allowed-tools` | E allowlists/settings | E sandbox/config | E `permission.skill` | E CLI permissions | E host controls | E host controls | E activation consent/policy |
| Project skills | — paths not standardized | D | D | D | D | D | D | D |
| User/global skills | — paths not standardized | D | D | D | D | D | D | D |
| Discovery | Metadata-based model | D directory scan | D upward scan | D upward scan | D project/global | D directory scan | D directory scan | D discovery tiers |
| Direct invocation | — no universal syntax | E `/name` | E `$name` / selector | Ask by name; universal slash syntax not established | E `/name` | E `/` selector | E `/name` | Ask by name; activation tool |

Sources by column: [specification](https://agentskills.io/specification),
[Claude Code](https://code.claude.com/docs/en/skills),
[Codex](https://learn.chatgpt.com/docs/build-skills),
[OpenCode](https://opencode.ai/docs/skills/),
[Antigravity CLI](https://antigravity.google/docs/cli/plugins/),
[Cursor](https://cursor.com/docs/skills),
[Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills),
[Gemini CLI](https://geminicli.com/docs/cli/skills/).

A documented ability to bundle a script is not blanket permission to execute
it. OpenCode's skills page documents discovery/loading, not every filesystem
capability. Missing documentation is not a negative test result. Cursor's
agent documentation is not proof that every headless CLI release behaves alike.

## Installation paths

Use the same directory contents at each path; do not generate provider-specific
Skill definitions. Paths below are documented host conventions, not open-spec
requirements. Alternative compatibility paths are omitted for clarity.

| Host | Project | User/global |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `.agents/skills/` from cwd to repo root | `~/.agents/skills/` |
| OpenCode | `.opencode/skills/` or `.agents/skills/` | `~/.config/opencode/skills/` or `~/.agents/skills/` |
| Antigravity app | `.agents/skills/<name>/SKILL.md` | `~/.gemini/config/skills/<name>/SKILL.md` |
| Antigravity CLI | `.agents/skills/<name>.md` documented; directory support unverified | `~/.gemini/antigravity-cli/skills/<name>.md` documented |
| Cursor | `.cursor/skills/` or `.agents/skills/` | `~/.cursor/skills/` or `~/.agents/skills/` |
| Copilot CLI | `.github/skills/` or `.agents/skills/` | `~/.copilot/skills/` or `~/.agents/skills/` |
| Gemini CLI | `.gemini/skills/` or `.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` |

The columns' sources above document these paths. Antigravity's
[general Skills guide](https://antigravity.google/docs/skills/) describes
standard directories, but its [CLI guide](https://antigravity.google/docs/cli/plugins/)
describes flat Markdown files and a different global location. These are
different product surfaces: directory/resource discovery in the CLI needs an
execution probe before claiming compatibility or deciding whether an adapter
is necessary. No flat-file adapter has been introduced on speculation.
`.agents/skills` is a useful common convention, not a
universal scan location. Avoid installing duplicate names in several locations
unless the host's collision behavior is understood.

## What is not portable core

Claude Code supports invocation controls, subagent context, dynamic shell
injection and other frontmatter extensions. Codex has optional
`agents/openai.yaml` for UI/invocation policy. OpenCode's skill-access policy
lives in its configuration. None is needed by Issue Flow's canonical Skills.

Anthropic's platform overview also covers API/container and claude.ai uploads;
those environments are not interchangeable with Claude Code. A filesystem
package being accepted does not supply Git, network access or a project's test
runner. Its reserved-name/XML restrictions are an additional compatibility
constraint, not the open specification.
[Platform documentation](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).

## Other implementations and MCP

Microsoft Agent Framework supports filesystem Skills with staged loading of
instructions/references/assets and an explicitly configured script runner. It
is an SDK integration, so directory discovery and execution are application
configuration rather than a universal user/global convention. Its experimental
MCP skill source is a framework extension.
[Microsoft documentation](https://learn.microsoft.com/en-us/agent-framework/agents/skills?pivots=programming-language-csharp).

The MCP project's [Build with Agent Skills](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills)
page teaches use of Skills when building MCP integrations. It does not make an
MCP server a prerequisite for a Skill. MCP provides structured capabilities;
Skills describe how to use available capabilities. Additional clients listed
in the [client showcase](https://agentskills.io/home) are not automatically
certified by this matrix.
