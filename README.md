# opencode-memelord

[OpenCode](https://opencode.ai) plugin for [memelord](https://github.com/glommer/memelord) -- persistent memory for coding agents.

## What it does

Gives your OpenCode agent persistent memory that improves over time. The plugin provides everything out of the box:

**Memory tools** (replaces the MCP server):

| Tool                | Purpose                                                                 |
| ------------------- | ----------------------------------------------------------------------- |
| `memory_start_task` | Retrieve relevant memories via vector search at the start of every task |
| `memory_report`     | Store corrections, user inputs, or codebase insights                    |
| `memory_end_task`   | Rate retrieved memories and record task outcome                         |
| `memory_contradict` | Flag an incorrect memory and delete it                                  |
| `memory_status`     | Show memory system stats                                                |

**Lifecycle hooks** (automatic, no agent action needed):

| OpenCode event       | Purpose                                                 |
| -------------------- | ------------------------------------------------------- |
| `session.created`    | Inject top memories into context                        |
| `tool.execute.after` | Record tool failures for pattern detection              |
| `session.idle`       | Analyze transcript for self-corrections and discoveries |
| `session.deleted`    | Embed pending memories, run weight decay                |

## Install

Add to your global OpenCode config (`~/.config/opencode/opencode.json`):

```json
{
  "plugin": ["opencode-memelord@latest"]
}
```

That's it. OpenCode auto-installs the plugin and all dependencies at startup.

## How it works

- **Global database** -- memories are stored at `~/.config/memelord/projects/<project>/memory.db`, keyed by git remote URL. Multiple worktrees of the same repo share the same database.
- **Local embeddings** -- uses `Xenova/all-MiniLM-L6-v2` (384-dim, quantized, runs on CPU) via `@huggingface/transformers`. No API keys needed. The model is lazy-loaded on first use.
- **Uses the [memelord SDK](https://github.com/glommer/memelord)** directly -- same memory lifecycle, scoring, and decay algorithms. Same analysis logic for detecting self-corrections, discoveries, and failure patterns.

### Memory lifecycle

1. **Session starts** -- top memories by weight are injected into context
2. **Agent works** -- tool failures are tracked automatically
3. **Agent finishes responding** -- transcript is analyzed for self-corrections (failed tool -> same tool succeeds with different input) and discoveries (high-token exploration sessions)
4. **Session ends** -- new memories are embedded and weight decay runs

Memories that consistently help survive. Memories that don't get garbage collected over time.

## Requirements

- [OpenCode](https://opencode.ai) v1.0+

## License

MIT
