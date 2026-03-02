/**
 * Lifecycle hook handlers for OpenCode events.
 *
 * Same analysis logic as memelord's packages/cli/src/hooks.ts,
 * adapted to work directly with OpenCode's native Part/Message types
 * instead of Claude Code's stdin JSON + transcript JSONL.
 */
import type { Event, Message, Part, AssistantMessage } from '@opencode-ai/sdk'
import type { PluginInput } from '@opencode-ai/plugin'
import type { StoreManager } from './store.js'

// ---------------------------------------------------------------------------
// Transcript analysis helpers (adapted from memelord's hooks.ts)
// ---------------------------------------------------------------------------

interface ToolSequenceEntry {
  tool: string
  input: unknown
  failed: boolean
}

/**
 * Extract a flat list of tool calls with success/failure from OpenCode messages.
 * Equivalent to memelord's extractToolSequences but works with ToolPart directly.
 */
function extractToolSequences(
  messages: Array<{ info: Message; parts: Part[] }>,
): ToolSequenceEntry[] {
  const sequence: ToolSequenceEntry[] = []

  for (const { parts } of messages) {
    for (const part of parts) {
      if (part.type !== 'tool') continue

      if (part.state.status === 'completed') {
        // Check if the "completed" tool actually returned an error in its output
        const output = part.state.output ?? ''
        const hasError =
          output.includes('Error:') ||
          output.includes('ENOENT') ||
          output.includes('command not found')
        sequence.push({
          tool: part.tool,
          input: part.state.input,
          failed: hasError,
        })
      } else if (part.state.status === 'error') {
        sequence.push({
          tool: part.tool,
          input: part.state.input,
          failed: true,
        })
      }
    }
  }

  return sequence
}

/**
 * Detect self-corrections: a failed tool call followed by the same tool
 * succeeding within 3 calls, with different input.
 * Equivalent to memelord's detectCorrections.
 */
function detectCorrections(sequence: ToolSequenceEntry[]) {
  const corrections: Array<{
    failedTool: string
    failedInput: string
    succeededTool: string
    succeededInput: string
  }> = []

  for (let i = 0; i < sequence.length - 1; i++) {
    if (!sequence[i].failed) continue
    for (let j = i + 1; j < Math.min(i + 4, sequence.length); j++) {
      if (sequence[j].tool === sequence[i].tool && !sequence[j].failed) {
        const failedInput =
          typeof sequence[i].input === 'string'
            ? (sequence[i].input as string)
            : JSON.stringify(sequence[i].input).slice(0, 200)
        const succeededInput =
          typeof sequence[j].input === 'string'
            ? (sequence[j].input as string)
            : JSON.stringify(sequence[j].input).slice(0, 200)
        if (failedInput !== succeededInput) {
          corrections.push({
            failedTool: sequence[i].tool,
            failedInput,
            succeededTool: sequence[j].tool,
            succeededInput,
          })
        }
        break
      }
    }
  }

  return corrections
}

/**
 * Sum tokens from assistant messages.
 * Equivalent to memelord's sumTokens but reads from OpenCode's AssistantMessage.tokens.
 */
function sumTokens(messages: Array<{ info: Message; parts: Part[] }>): number {
  let total = 0
  for (const { info } of messages) {
    if (info.role === 'assistant') {
      const a = info as AssistantMessage
      total += a.tokens.input
      total += a.tokens.output
      total += a.tokens.cache.write
    }
  }
  return total
}

/**
 * Extract long text blocks from assistant messages.
 * Equivalent to memelord's extractTextBlocks but reads from OpenCode's TextPart.
 */
function extractTextBlocks(
  messages: Array<{ info: Message; parts: Part[] }>,
): string[] {
  const texts: string[] = []
  for (const { info, parts } of messages) {
    if (info.role !== 'assistant') continue
    for (const part of parts) {
      if (
        part.type === 'text' &&
        typeof part.text === 'string' &&
        part.text.length > 80
      ) {
        texts.push(part.text)
      }
    }
  }
  return texts
}

// ---------------------------------------------------------------------------
// Failure detection (same heuristics as memelord's hookPostToolUse)
// ---------------------------------------------------------------------------

function isToolFailure(
  output: string,
  metadata?: Record<string, unknown>,
): boolean {
  return (
    (metadata != null &&
      typeof metadata.exitCode === 'number' &&
      metadata.exitCode !== 0) ||
    (typeof output === 'string' &&
      (output.startsWith('Error:') ||
        output.startsWith('error:') ||
        output.includes('ENOENT') ||
        output.includes('command not found') ||
        output.includes('No such file') ||
        output.includes('Permission denied')))
  )
}

// ---------------------------------------------------------------------------
// Hook handlers
// ---------------------------------------------------------------------------

/**
 * session.created → inject top memories into context.
 * Equivalent to memelord's hookSessionStart.
 */
export async function onSessionCreated(
  sessionId: string,
  client: PluginInput['client'],
  storeManager: StoreManager,
): Promise<void> {
  storeManager.setCurrentSessionId(sessionId)
  const store = await storeManager.getStore()

  try {
    const memories = await store.getTopByWeight(5)

    storeManager.setSessionState(sessionId, {
      sessionId,
      startedAt: Math.floor(Date.now() / 1000),
      injectedMemoryIds: memories.map((m) => m.id),
    })

    let context = ''
    if (memories.length > 0) {
      context += '# Memories from past sessions\n\n'
      for (const mem of memories) {
        context += `[${mem.category}] (id: ${mem.id}, weight: ${mem.weight.toFixed(2)})\n${mem.content}\n\n`
      }
    }

    context += `# Memory system instructions

You have a persistent memory system available via tools. Use it:

1. At the START of every task, call memory_start_task with the user's request. This retrieves task-relevant memories using vector search (more precise than the weight-based ones above).

2. When you self-correct (tried something that failed, then found the right approach), call memory_report with type "correction".

3. When the user corrects you or shares project knowledge, call memory_report with type "user_input". The user should never have to tell you the same thing twice.

4. When you discover something useful about the codebase (key file locations, architecture patterns, build/test conventions), call memory_report with type "insight". This saves future sessions from re-exploring the same codebase.

5. IMPORTANT — Before finishing a task, review the memories above against what you actually found. If any memory contains incorrect information (wrong file paths, wrong function names, wrong explanations), you MUST call memory_contradict with its id to remove it. Provide the correct information so future sessions get it right. Bad memories poison every future session if not removed.

6. When you finish a task, call memory_end_task with outcome metrics and rate each retrieved memory (0=ignored, 1=glanced, 2=useful, 3=directly applied).`

    await client.session.prompt({
      path: { id: sessionId },
      body: {
        noReply: true,
        parts: [{ type: 'text', text: context }],
      },
    })
  } catch (e: any) {
    await client.app.log({
      body: {
        service: 'memelord',
        level: 'error',
        message: `SessionStart error: ${e.message}`,
      },
    })
  }
}

/**
 * tool.execute.after → record tool failures.
 * Equivalent to memelord's hookPostToolUse.
 */
export function onToolAfter(
  sessionId: string,
  toolName: string,
  toolInput: unknown,
  toolOutput: string,
  toolMetadata: unknown,
  storeManager: StoreManager,
): void {
  const meta = toolMetadata as Record<string, unknown> | undefined
  if (!isToolFailure(toolOutput, meta)) return

  const errorSummary = toolOutput.slice(0, 500)

  storeManager.appendFailure(sessionId, {
    timestamp: Math.floor(Date.now() / 1000),
    toolName,
    toolInput,
    errorSummary,
  })
}

/**
 * session.idle → analyze transcript for corrections, discoveries, and failure patterns.
 * Equivalent to memelord's hookStop.
 */
export async function onSessionIdle(
  sessionId: string,
  client: PluginInput['client'],
  storeManager: StoreManager,
): Promise<void> {
  const store = await storeManager.getStore()

  try {
    let correctionsFound = 0
    let discoveryStored = false

    // Fetch messages from OpenCode
    let messages: Array<{ info: Message; parts: Part[] }> = []
    try {
      const response = await client.session.messages({
        path: { id: sessionId },
      })
      messages = response.data ?? []
    } catch {}

    if (messages.length > 0) {
      const sequence = extractToolSequences(messages)
      const corrections = detectCorrections(sequence)

      for (const c of corrections) {
        const content = `Auto-detected correction with ${c.failedTool}:\n\nFailed approach: ${c.failedInput}\nWorking approach: ${c.succeededInput}`
        await store.insertRawMemory(content, 'correction', 1.5)
        correctionsFound++
      }

      // Discovery detection
      const totalTokens = sumTokens(messages)
      if (totalTokens >= 50_000) {
        const exploration = { reads: 0, searches: 0, edits: 0 }
        for (const s of sequence) {
          const t = s.tool
          // Match tool names across Claude Code (PascalCase), OpenCode (lowercase),
          // OpenCode MCP plugins (mcp_server_tool), and Claude MCP (mcp__server__tool)
          if (
            t === "Read" ||
            t === "read" ||
            t.includes("cachebro_read_file") ||
            t.includes("cachebro_read_files")
          ) {
            exploration.reads++
          } else if (
            t === "Grep" ||
            t === "grep" ||
            t === "Glob" ||
            t === "glob" ||
            t === "LSP" ||
            t === "lsp"
          ) {
            exploration.searches++
          } else if (
            t === "Edit" ||
            t === "edit" ||
            t === "Write" ||
            t === "write"
          ) {
            exploration.edits++
          }
        }
        const ratio =
          (exploration.reads + exploration.searches) /
          Math.max(
            exploration.reads + exploration.searches + exploration.edits,
            1,
          )

        if (ratio > 0.5) {
          const texts = extractTextBlocks(messages)
          if (texts.length > 0) {
            const sorted = [...texts].sort((a, b) => b.length - a.length)
            const combined = new Set([
              ...sorted.slice(0, 5),
              ...texts.slice(-2),
            ])
            const ordered = texts.filter((t) => combined.has(t))
            const summary = ordered
              .map((t) => t.slice(0, 500))
              .join('\n\n')
              .slice(0, 2000)

            if (summary.length >= 100) {
              await store.insertRawMemory(
                `[Discovery after ${Math.round(totalTokens / 1000)}k tokens, ${sequence.length} tool calls]\n\n${summary}`,
                'discovery',
                1.0,
              )
              discoveryStored = true
            }
          }
        }
      }

      // Penalize injected memories when the session was expensive
      const totalTokens2 = sumTokens(messages)
      if (totalTokens2 >= 20_000) {
        const session = storeManager.getSessionState(sessionId)
        const injectedIds = session?.injectedMemoryIds ?? []
        if (injectedIds.length > 0) {
          let penalized = 0
          for (const id of injectedIds) {
            await store.penalizeMemory(id, 0.999)
            penalized++
          }
          if (penalized > 0) {
            await client.app.log({
              body: {
                service: 'memelord',
                level: 'info',
                message: `penalized ${penalized} injected memories (session used ${Math.round(totalTokens2 / 1000)}k tokens)`,
              },
            })
          }
        }
      }
    }

    // Failure pattern detection (from on-disk failures file)
    const failures = storeManager.getFailures(sessionId)
    if (failures.length > 0) {
      const toolFailCounts = new Map<string, number>()
      for (const f of failures) {
        toolFailCounts.set(
          f.toolName,
          (toolFailCounts.get(f.toolName) ?? 0) + 1,
        )
      }

      for (const [toolName, count] of toolFailCounts) {
        if (count >= 3) {
          const examples = failures
            .filter((f) => f.toolName === toolName)
            .slice(0, 2)
            .map((f) => f.errorSummary.slice(0, 100))
            .join('; ')
          await store.insertRawMemory(
            `Repeated failures with ${toolName} (${count}x in session): ${examples}`,
            'correction',
            1.0,
          )
          correctionsFound++
        }
      }
    }

    if (correctionsFound > 0) {
      await client.app.log({
        body: {
          service: 'memelord',
          level: 'info',
          message: `stored ${correctionsFound} auto-detected corrections`,
        },
      })
    }
    if (discoveryStored) {
      await client.app.log({
        body: {
          service: 'memelord',
          level: 'info',
          message: 'stored 1 discovery from high-token exploration',
        },
      })
    }
  } catch (e: any) {
    await client.app.log({
      body: {
        service: 'memelord',
        level: 'error',
        message: `Stop error: ${e.message}`,
      },
    })
  }
}

/**
 * session.deleted → embed pending memories, run decay, clean up.
 * Equivalent to memelord's hookSessionEnd.
 */
export async function onSessionDeleted(
  sessionId: string,
  client: PluginInput['client'],
  storeManager: StoreManager,
): Promise<void> {
  try {
    const store = await storeManager.getLiveStore()

    const embedded = await store.embedPending()
    if (embedded > 0) {
      await client.app.log({
        body: {
          service: 'memelord',
          level: 'info',
          message: `embedded ${embedded} pending memories`,
        },
      })
    }

    const decayResult = await store.decay()
    if (decayResult.deleted > 0) {
      await client.app.log({
        body: {
          service: 'memelord',
          level: 'info',
          message: `cleaned up ${decayResult.deleted} stale memories`,
        },
      })
    }

    storeManager.cleanupSession(sessionId)
  } catch (e: any) {
    await client.app.log({
      body: {
        service: 'memelord',
        level: 'error',
        message: `SessionEnd error: ${e.message}`,
      },
    })
  }
}
