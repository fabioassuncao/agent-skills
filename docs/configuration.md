# Configuration

Configuration is resolved in this order, from lowest to highest precedence:

1. built-in defaults;
2. `~/.issue-flow/config.json`;
3. `<repository>/.issue-flow.json`;
4. `ISSUE_FLOW_*` environment variables;
5. command-line flags.

Unknown keys are ignored. Invalid known values produce a warning and do not
erase a valid value from a lower-precedence layer.

## Project configuration

`.issue-flow.json` may configure:

- agent selection and per-phase provider/model settings;
- issue providers and local-only operation;
- runtime profiles, panes, services and startup environment;
- retry, failover, queue, watchdog and decomposition policies;
- routing, verification, telemetry, GitHub and Linear integration;
- web monitor host, port, refresh interval and log visibility;
- git, commit and Pull Request behavior.

Runtime profile permissions are `read-only`, `workspace` or `autonomous`.
Docker credentials and host paths are mounted only when explicitly declared in
the profile. SSH-agent forwarding is opt-in.

## Global configuration

`~/.issue-flow/config.json` contains machine-wide preferences such as the
default agent, dashboard settings, routing preferences, storage retention and
integration settings. The file is shared by all registered projects.

## Storage

`ISSUE_FLOW_HOME` changes the machine-wide data directory. SQLite is the only
storage engine. The optional retention shape is:

```json
{
  "storage": {
    "retention": {
      "executions": 10000,
      "events": 50000,
      "snapshots": 1000,
      "backups": 10
    }
  }
}
```

Run `issue-flow --help` and `issue-flow <command> --help` for the complete,
version-matched flag and environment-variable reference.
