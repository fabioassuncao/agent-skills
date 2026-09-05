# issue-flow CLI

**Experimental automation from issue to reviewed Pull Request.**

This npm package is Issue Flow's independent CLI. It drives coding agents in
headless mode and manages persistent execution state, verification, queues,
recovery and monitoring. It accepts GitHub or local issues.

For the recommended workflow in your current coding agent, start with the
[portable Agent Skills](https://github.com/fabioassuncao/issue-flow/blob/main/skills/README.md).
They are installed separately from Git and do not require this npm package.
Installing this package does not install Skills.

> [!WARNING]
> The whole project, including the CLI and Skills, is experimental. Recommended
> Skill use does not imply production readiness. Read the
> [project status](https://github.com/fabioassuncao/issue-flow/blob/main/docs/project-status.md)
> for the current risks, restrictions and precautions.

## Get started

Complete the
[CLI prerequisites](https://github.com/fabioassuncao/issue-flow/blob/main/docs/cli.md#requirements-and-installation)
first. From your consumer repository:

```bash
npx issue-flow init
npx issue-flow run 42
```

Replace `42` with the issue to resolve. `run` plans, implements, verifies,
reviews and creates a PR. Review the resulting changes before merging.
For installation, local issues, monitoring and limitations, use the
[CLI guide](https://github.com/fabioassuncao/issue-flow/blob/main/docs/cli.md).

## Documentation

- [Project overview](https://github.com/fabioassuncao/issue-flow#readme)
- [CLI guide and reference map](https://github.com/fabioassuncao/issue-flow/blob/main/docs/cli.md)
- [Commands](https://github.com/fabioassuncao/issue-flow/blob/main/docs/commands.md)
- [Configuration](https://github.com/fabioassuncao/issue-flow/blob/main/docs/configuration.md)
- [Agent setup and authentication](https://github.com/fabioassuncao/issue-flow/blob/main/docs/agents.md)
- [Agent Skills](https://github.com/fabioassuncao/issue-flow/blob/main/skills/README.md)
- [Contributing](https://github.com/fabioassuncao/issue-flow/blob/main/CONTRIBUTING.md)
- [CLI development and release](https://github.com/fabioassuncao/issue-flow/blob/main/packages/issue-flow/CONTRIBUTING.md)

## License

MIT. See [LICENSE](https://github.com/fabioassuncao/issue-flow/blob/main/LICENSE).
