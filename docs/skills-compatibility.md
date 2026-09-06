# Agent Skills compatibility

[Skills guide](../skills/README.md) · [Installation options](../skills/README.md#installation-options-and-compatibility)

Documentation checked **2026-09-05**. `O` = official support; `N` = normative format; `G` = guidance; `E` = host extension; `X` = experimental; `H` = host-dependent; `—` = unspecified; `?` = not established. Format support does not guarantee correct behavior by every model.

| Capability | Agent Skills Spec | Claude Code | Codex | Cursor | OpenCode | Antigravity | Gemini CLI | Copilot |
|---|---|---|---|---|---|---|---|---|
| Discovery | G: metadata first | O | O | O | O | O | O | O/H |
| `SKILL.md` | N | O | O | O | O | O | O | O |
| Core frontmatter | N | O + E | O + E | O + E | O; unknown fields ignored | O | O | O |
| `references/` | G | O | O | O | O: supporting files | O | O | O |
| `scripts/` | G | O/H execution | O/H | O/H | O/H | O/H | O/H | O/H |
| `assets/` | G | O | O | O | O: supporting files | O | O | O |
| Project install | — | O | O | O | O | O | O | O/H |
| User install | — | O | O | O | O | O | O | O/H |
| Progressive disclosure | G | O | O | O | O | O | O | O |
| Explicit invocation | — | E: `/name` | E: selection/mention | E: `/name` | E: Skill tool/request | Request by name; slash UI ? | E: request, activation consent | H: IDE/CLI |
| Automatic triggering | G: description | O | O | O | O | O | O; consent | O/H |
| Tool restrictions | X: `allowed-tools` | E: permissions | E: sandbox/config | E: host config | E: Skill permissions | E: host permissions | E: activation/permissions | H |

Supporting files are read through ordinary file capabilities; directory names do not grant execution permission. Issue Flow uses neither experimental `allowed-tools` nor provider-specific frontmatter. Bundled helpers need Node and command execution permission.

## Official references and directories

| Host | Project | User | Evidence and qualification |
|---|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` | [Official guide](https://code.claude.com/docs/en/skills). Subagents, dynamic command expansion and invocation controls are extensions. |
| Codex | `.agents/skills/` in repository scope/ancestors | `~/.agents/skills/` | [OpenAI guide](https://learn.chatgpt.com/docs/build-skills). Optional host metadata is not a portable requirement. |
| Cursor | `.cursor/skills/`; host compatibility locations | `~/.cursor/skills/` | [Cursor Skills](https://cursor.com/docs/skills). IDE support is not proof for every CLI build. |
| OpenCode | `.opencode/skills/`, `.agents/skills/`, `.claude/skills/` | `~/.config/opencode/skills/`, `~/.agents/skills/`, `~/.claude/skills/` | [OpenCode Skills](https://opencode.ai/docs/skills/). Native and compatibility locations. |
| Antigravity | `.agents/skills/`; legacy `.agent/skills/` | `~/.gemini/config/skills/` | [Antigravity Skills](https://antigravity.google/docs/skills). Product documentation does not establish identical discovery in every `agy` CLI version. |
| Gemini CLI | `.gemini/skills/` or `.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` | [Gemini CLI Skills](https://geminicli.com/docs/cli/skills/). Native management and activation consent are host behavior. |
| Copilot | `.github/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.copilot/skills/` or `~/.agents/skills/` | [Copilot Skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills). Availability varies across IDE, CLI, cloud and review surfaces. |

The [Agent Skills specification](https://agentskills.io/specification) defines the artifact, not a universal install directory or invocation syntax. [Anthropic's overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) distinguishes product/API execution environments. [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/agents/skills?pivots=programming-language-csharp) documents SDK integration rather than one coding-agent installer. [MCP's Skill guidance](https://modelcontextprotocol.io/docs/2026-07-28/develop/build-with-agent-skills) explains complementary capabilities; it does not make MCP a Skill requirement.

## Invocation options

The [official specification](https://agentskills.io/specification) defines no
formal parameter schema, argument declarations or universal invocation syntax.
Its `metadata` map stores strings; it does not bind runtime inputs. Options can
be explained in the unrestricted Markdown body of SKILL.md and in bundled
references, then supplied in the user's request. Issue Flow uses that portable
approach: natural language or the documented optional text block, without adding
frontmatter fields or requiring a host extension.

| Host | Officially documented invocation behavior | Portability boundary |
|---|---|---|
| Claude Code | `/name`, `arguments`, `argument-hint` and `$ARGUMENTS`/positional substitution | These argument features are host extensions, not Issue Flow requirements. [Guide](https://code.claude.com/docs/en/skills) |
| Codex | Skill selection or mention (`/skills` or `$` in CLI/IDE) alongside the request | No shared formal argument contract established by that interface. [Guide](https://learn.chatgpt.com/docs/build-skills) |
| Cursor | Explicit `/skill-name` or automatic selection | Slash invocation alone does not establish portable argument binding. [Guide](https://cursor.com/docs/skills) |
| OpenCode | Agent loads `skill({ name: ... })`; extra frontmatter fields are ignored | Input remains in the request context. [Guide](https://opencode.ai/docs/skills/) |
| Gemini CLI | `activate_skill` followed by UI consent and instruction loading | Activation is host behavior, not a parameter schema. [Guide](https://geminicli.com/docs/cli/skills/) |
| Antigravity | Context selection or mentioning the Skill by name | No formal argument binding documented. [Guide](https://antigravity.google/docs/skills) |

This is documentation evidence checked on 2026-09-05, not certification of native
execution on every host/version. The [invocation guide](../skills/README.md#configure-an-invocation)
shows Issue Flow vocabulary. A block such as `branchMode: current` is interpreted
by the agent; it is neither a new Agent Skills standard nor executable YAML.

## Observed behavior

Vercel Skills **1.5.23** discovered eleven generated Skills. Individual, all-Skill and subset installs, copy/symlink modes, Claude/Codex/OpenCode project targets, inventory and Codex global install in a disposable user container passed byte/reference validation.

That version installs OpenCode project Skills in `.agents/skills/`, shared with Codex. Its Antigravity mappings use `.agent/skills/` and `~/.gemini/antigravity/skills/`; the global path differs from current host documentation. Use the documented host directory manually until the installed host and installer agree. Successful copying is not proof of a host load. [Installer source](https://github.com/vercel-labs/skills).

No native activation/execution claim is made for Cursor, OpenCode, Antigravity, Gemini or Copilot by these installation tests. Claude/Codex observations and limits are in [the dated report](research/2026-09-05-skills-portability.md). Catalogue selection evals are distinct from native discovery tests.
