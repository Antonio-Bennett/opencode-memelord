/**
 * Memory tools — native OpenCode custom tools replacing the MCP server.
 *
 * Same schemas and descriptions as memelord's packages/cli/src/mcp.ts,
 * adapted to the OpenCode tool() API (returns string instead of MCP content).
 */
import { tool } from '@opencode-ai/plugin'
import type { StoreManager } from './store.js'

export function createTools(storeManager: StoreManager) {
  return {
    memory_start_task: tool({
      description: `Start a new task and retrieve relevant memories. You MUST call this FIRST at the beginning of every task, before doing any work. Pass the user's request or task description.

Returns memories from past experience that are relevant to this task. These memories contain lessons learned from previous sessions — patterns that worked, mistakes to avoid, project-specific knowledge. Using them will help you avoid repeating past mistakes and work more efficiently.

Also returns a task_id that you MUST pass to memory_end_task when you finish.`,
      args: {
        description: tool.schema
          .string()
          .describe("The user's request or task description"),
      },
      async execute(args) {
        try {
          const store = await storeManager.getLiveStore()

          // Embed any hook-stored memories before searching so they appear in results
          try {
            await store.embedPending()
          } catch {}

          const result = await store.startTask(args.description)

          let text = `Task started (id: ${result.taskId})\n\n`

          if (result.memories.length === 0) {
            text +=
              'No relevant memories found. This appears to be a new type of task.'
          } else {
            text += `Retrieved ${result.memories.length} relevant memories:\n\n`
            for (const mem of result.memories) {
              text += `--- [${mem.category}] (weight: ${mem.weight.toFixed(2)}, score: ${mem.score.toFixed(3)}) ---\n`
              text += `${mem.content}\n\n`
            }
          }

          return text
        } catch (e: any) {
          return `Error: ${e.message}`
        }
      },
    }),

    memory_report: tool({
      description: `Report a self-correction or user-provided knowledge to persist across sessions.

Use type "correction" when you:
- Tried the wrong file path, function name, or API and had to search for the correct one
- Used the wrong tool, command, or pattern for this project
- Made an architectural assumption that turned out wrong
- Wasted significant effort (3+ tool calls) on a wrong approach before finding the right one
Do NOT report: typos, minor first-try search misses, or things that took <2 tool calls to resolve.

Use type "user_input" when:
- The user denies a tool call and explains why
- The user corrects your approach ("no, use X instead of Y")
- The user shares project-specific knowledge ("we use Turso, not SQLite")
- The user states a preference ("always run tests before committing")
The user should never have to tell you the same thing twice.

Use type "insight" when you discover something useful about the codebase during exploration:
- Key file locations ("auth middleware is in src/middleware/auth.rs")
- Architecture patterns ("the project uses a VDBE architecture: translate -> bytecode -> execute")
- Build/test conventions ("run 'make check' before committing, tests are in tests/")
- Important relationships between components
Store insights proactively — they save future sessions from re-exploring the same codebase.`,
      args: {
        type: tool.schema
          .enum(['correction', 'user_input', 'insight'])
          .describe(
            'What kind of memory: correction (self-correction), user_input (user-provided knowledge), or insight (codebase knowledge discovered during exploration)',
          ),
        lesson: tool.schema
          .string()
          .describe('The lesson learned — what the agent should remember'),
        what_failed: tool.schema
          .string()
          .optional()
          .describe('(correction only) The approach that failed'),
        what_worked: tool.schema
          .string()
          .optional()
          .describe('(correction only) The approach that worked'),
        tokens_wasted: tool.schema
          .number()
          .optional()
          .describe(
            '(correction only) Approximate tokens spent on the wrong approach',
          ),
        tools_wasted: tool.schema
          .number()
          .optional()
          .describe('(correction only) Number of tool calls wasted'),
        source: tool.schema
          .enum(['user_denial', 'user_correction', 'user_input'])
          .optional()
          .describe('(user_input only) How the user provided this'),
      },
      async execute(args) {
        try {
          const store = await storeManager.getStore()
          let id: string

          if (args.type === 'correction') {
            id = await store.reportCorrection({
              lesson: args.lesson,
              whatFailed: args.what_failed ?? '',
              whatWorked: args.what_worked ?? '',
              tokensWasted: args.tokens_wasted,
              toolsWasted: args.tools_wasted,
            })
          } else if (args.type === 'insight') {
            id = await store.insertRawMemory(args.lesson, 'insight', 1.0)
          } else {
            id = await store.reportUserInput({
              lesson: args.lesson,
              source: args.source ?? 'user_input',
            })
          }

          return `Memory saved (id: ${id}). This will be remembered across sessions.`
        } catch (e: any) {
          return `Error: ${e.message}`
        }
      },
    }),

    memory_end_task: tool({
      description: `End the current task and provide outcome metrics. You MUST call this when you finish a task or when the user moves on to a different request. This updates memory weights so that useful memories are strengthened and unhelpful ones decay.

For self_report: rate each memory that was retrieved at task start:
  0 = ignored / not relevant
  1 = glanced at but didn't use
  2 = somewhat useful
  3 = directly applied / saved significant effort`,
      args: {
        task_id: tool.schema
          .string()
          .describe('The task_id returned by memory_start_task'),
        tokens_used: tool.schema
          .number()
          .describe('Total tokens used during this task'),
        tool_calls: tool.schema
          .number()
          .describe('Total tool calls made during this task'),
        errors: tool.schema
          .number()
          .describe(
            'Number of errors encountered (failed commands, test failures, etc.)',
          ),
        user_corrections: tool.schema
          .number()
          .describe(
            'Number of times the user corrected you or denied a tool call',
          ),
        completed: tool.schema
          .boolean()
          .describe('Whether the task was completed successfully'),
        self_report: tool.schema
          .array(
            tool.schema.object({
              memory_id: tool.schema.string(),
              score: tool.schema.number().min(0).max(3),
            }),
          )
          .optional()
          .describe(
            'Rate each retrieved memory: 0=ignored, 1=glanced, 2=useful, 3=directly applied',
          ),
      },
      async execute(args) {
        try {
          const store = await storeManager.getStore()

          await store.endTask(args.task_id, {
            tokensUsed: args.tokens_used,
            toolCalls: args.tool_calls,
            errors: args.errors,
            userCorrections: args.user_corrections,
            completed: args.completed,
            selfReport: args.self_report?.map((s) => ({
              memoryId: s.memory_id,
              score: s.score,
            })),
          })

          const decayResult = await store.decay()

          let text = 'Task ended. Score recorded and memory weights updated.'
          if (decayResult.deleted > 0) {
            text += `\n${decayResult.deleted} stale memories cleaned up.`
          }

          return text
        } catch (e: any) {
          return `Error: ${e.message}`
        }
      },
    }),

    memory_contradict: tool({
      description: `Flag a retrieved memory as incorrect and remove it. Call this when a memory is factually wrong or led you down the wrong path.

Optionally provide a correction — the correct information that should replace the bad memory.

Example: You retrieve a memory saying "config is in /etc/shadow" but discover it's actually in src/config/auth.toml. Call this with the memory_id and correction="Config is in src/config/auth.toml, not /etc/shadow".`,
      args: {
        memory_id: tool.schema
          .string()
          .describe('The ID of the incorrect memory to remove'),
        correction: tool.schema
          .string()
          .optional()
          .describe(
            "What's actually true — stored as a new high-weight memory to replace the wrong one",
          ),
      },
      async execute(args) {
        try {
          const store = await storeManager.getStore()
          const result = await store.contradictMemory(
            args.memory_id,
            args.correction,
          )

          if (!result.deleted) {
            return `Memory ${args.memory_id} not found.`
          }

          let text = 'Incorrect memory deleted.'
          if (result.correctionId) {
            text += ` Correction saved (id: ${result.correctionId}).`
          }
          return text
        } catch (e: any) {
          return `Error: ${e.message}`
        }
      },
    }),

    memory_status: tool({
      description:
        'Show memory system statistics: total memories stored, memory health, task history. Use this to check that the memory system is working.',
      args: {},
      async execute() {
        try {
          const store = await storeManager.getStore()
          const stats = await store.getStats()

          const lines = [
            'memelord status:',
            `  Memories stored:    ${stats.totalMemories}`,
            `  Tasks completed:    ${stats.taskCount}`,
            `  Avg task score:     ${stats.avgTaskScore.toFixed(3)}`,
          ]

          if (stats.topMemories.length > 0) {
            lines.push('\n  Top memories by weight:')
            for (const mem of stats.topMemories.slice(0, 5)) {
              const preview =
                mem.content.length > 80
                  ? mem.content.slice(0, 80) + '...'
                  : mem.content
              lines.push(
                `    [w=${mem.weight.toFixed(2)}, used=${mem.retrievalCount}x] ${preview}`,
              )
            }
          }

          return lines.join('\n')
        } catch (e: any) {
          return `Error: ${e.message}`
        }
      },
    }),
  }
}
