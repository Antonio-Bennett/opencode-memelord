# opencode-memelord

[OpenCode](https://opencode.ai) plugin for [memelord](https://github.com/glommer/memelord) -- persistent memory for coding agents.

## What it does

Gives your OpenCode agent persistent memory that improves over time. Memories from past sessions are injected at session start, tool failures are tracked, and transcripts are analyzed for self-corrections and discoveries.

| OpenCode event | memelord hook | Purpose |
|---|---|---|
| `session.created` | `session-start` | Inject top memories into context |
| `tool.execute.after` | `post-tool-use` | Record tool failures for pattern detection |
| `session.idle` | `stop` | Analyze transcript for corrections and discoveries |
| `session.deleted` | `session-end` | Embed pending memories, run weight decay |

## Install

### Quick start (with memelord init)

```bash
npm install -g memelord
cd your-project
memelord init
```

This configures both the MCP server (for memory tools) and the plugin (for hooks).

### Manual setup

Add to your `opencode.json`:

```json
{
  "plugin": ["opencode-memelord"],
  "mcp": {
    "memelord": {
      "type": "local",
      "command": ["memelord", "serve"],
      "environment": { "MEMELORD_DIR": ".memelord" },
      "enabled": true
    }
  }
}
```

Make sure memelord is installed globally:

```bash
npm install -g memelord
```

Then initialize the project database:

```bash
memelord init
```

## How it works

This plugin is a thin wrapper around the `memelord hook` CLI. It translates OpenCode's plugin events into the same hook commands that memelord uses for Claude Code, so all the analysis, storage, embedding, and decay logic stays in memelord.

- **No logic is duplicated** -- the plugin delegates everything to the memelord CLI
- **Automatic upstream updates** -- when memelord improves its hooks, this plugin benefits without changes
- **MCP tools still work** -- the plugin handles lifecycle hooks, the MCP server provides memory tools (`memory_start_task`, `memory_report`, `memory_end_task`, `memory_contradict`, `memory_status`)

## Requirements

- [memelord](https://github.com/glommer/memelord) installed globally (`npm install -g memelord`)
- [OpenCode](https://opencode.ai) v1.0+
- A `.memelord/` directory in your project (created by `memelord init`)

## License

MIT
