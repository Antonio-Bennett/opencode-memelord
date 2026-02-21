/**
 * opencode-memelord: OpenCode plugin for memelord persistent memory.
 *
 * Thin wrapper that delegates to `memelord hook <event>` CLI commands.
 * No business logic is ported — all analysis, storage, embedding, and
 * decay happens in the memelord CLI.
 *
 * Hook mapping:
 *   session.created  → memelord hook session-start
 *   tool.execute.after → memelord hook post-tool-use
 *   session.idle     → memelord hook stop
 *   session.deleted  → memelord hook session-end
 */
import type { Plugin } from "@opencode-ai/plugin"
import type { Event, Part, Message, AssistantMessage } from "@opencode-ai/sdk"
import { dirname, join } from "path"
import { createRequire } from "module"
import { writeFileSync, unlinkSync, existsSync } from "fs"
import { tmpdir } from "os"

// ---------------------------------------------------------------------------
// Resolve memelord CLI binary from installed dependency
// ---------------------------------------------------------------------------

function resolveMemelordBin(): string {
  try {
    const require = createRequire(import.meta.url)
    const pkgPath = require.resolve("memelord/package.json")
    return join(dirname(pkgPath), "dist", "cli.mjs")
  } catch {
    // Fallback: assume memelord is in PATH
    return ""
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const MemelordPlugin: Plugin = async ({ client, directory, worktree, $ }) => {
  const cwd = worktree || directory
  const memelordBin = resolveMemelordBin()

  // Track current session ID (set on session.created, used by other hooks)
  let currentSessionId = ""

  /**
   * Spawn `memelord hook <event>` with JSON on stdin, return stdout.
   * Uses the resolved binary from node_modules, falls back to PATH.
   */
  async function callHook(event: string, stdinData: Record<string, unknown>): Promise<string> {
    const json = JSON.stringify(stdinData)
    try {
      if (memelordBin) {
        return await $`echo ${json} | node ${memelordBin} hook ${event}`.quiet().nothrow().text()
      }
      return await $`echo ${json} | memelord hook ${event}`.quiet().nothrow().text()
    } catch {
      return ""
    }
  }

  /**
   * Convert OpenCode messages to the Claude transcript JSONL format
   * expected by `memelord hook stop`.
   *
   * Claude format (per line):
   *   { role, content: [{ type: "tool_use"|"tool_result"|"text", ... }], usage?: { ... } }
   *
   * OpenCode format:
   *   { info: Message, parts: Part[] }[]
   */
  function convertTranscript(
    messages: Array<{ info: Message; parts: Part[] }>,
  ): string {
    const lines: string[] = []

    for (const { info, parts } of messages) {
      const content: Record<string, unknown>[] = []

      for (const part of parts) {
        if (part.type === "text") {
          content.push({ type: "text", text: part.text })
        } else if (part.type === "tool") {
          // Emit tool_use + tool_result pair (the format extractToolSequences expects)
          content.push({
            type: "tool_use",
            name: part.tool,
            input: part.state.status !== "pending" ? part.state.input : {},
          })
          if (part.state.status === "completed") {
            content.push({ type: "tool_result", content: part.state.output })
          } else if (part.state.status === "error") {
            content.push({
              type: "tool_result",
              content: part.state.error,
              is_error: true,
            })
          }
        }
      }

      const msg: Record<string, unknown> = { role: info.role, content }

      // Attach token usage for assistant messages (used by sumTokens)
      if (info.role === "assistant") {
        const a = info as AssistantMessage
        msg.usage = {
          input_tokens: a.tokens.input,
          output_tokens: a.tokens.output,
          cache_creation_input_tokens: a.tokens.cache.write,
        }
      }

      lines.push(JSON.stringify(msg))
    }

    return lines.join("\n")
  }

  // -------------------------------------------------------------------------
  // session.created → memelord hook session-start
  // -------------------------------------------------------------------------

  async function onSessionCreated(sessionId: string): Promise<void> {
    currentSessionId = sessionId

    // Skip if no .memelord in this project
    if (!existsSync(join(cwd, ".memelord"))) return

    const stdout = await callHook("session-start", {
      session_id: sessionId,
      cwd,
    })

    // Parse the hook output for additionalContext to inject
    if (!stdout.trim()) return
    try {
      const parsed = JSON.parse(stdout)
      const context = parsed?.hookSpecificOutput?.additionalContext
      if (context) {
        await client.session.prompt({
          path: { id: sessionId },
          body: {
            noReply: true,
            parts: [{ type: "text", text: context }],
          },
        })
      }
    } catch {
      // Hook output wasn't valid JSON — ignore
    }
  }

  // -------------------------------------------------------------------------
  // session.idle → memelord hook stop
  // -------------------------------------------------------------------------

  async function onSessionIdle(sessionId: string): Promise<void> {
    if (!existsSync(join(cwd, ".memelord"))) return

    const stdinData: Record<string, unknown> = {
      session_id: sessionId,
      cwd,
    }

    // Try to get transcript from OpenCode and convert to Claude format
    try {
      const response = await client.session.messages({
        path: { id: sessionId },
      })
      const messages = response.data
      if (messages && messages.length > 0) {
        const transcript = convertTranscript(messages)
        const tmpFile = join(tmpdir(), `memelord-transcript-${sessionId}.jsonl`)
        writeFileSync(tmpFile, transcript)
        stdinData.transcript_path = tmpFile

        await callHook("stop", stdinData)

        // Clean up temp file
        try {
          unlinkSync(tmpFile)
        } catch {}
        return
      }
    } catch {
      // Client SDK unavailable or failed — fall back to no-transcript mode
    }

    // Fallback: run stop without transcript (still does failure pattern analysis)
    await callHook("stop", stdinData)
  }

  // -------------------------------------------------------------------------
  // session.deleted → memelord hook session-end
  // -------------------------------------------------------------------------

  async function onSessionDeleted(sessionId: string): Promise<void> {
    if (!existsSync(join(cwd, ".memelord"))) return

    await callHook("session-end", {
      session_id: sessionId,
      cwd,
    })
  }

  // -------------------------------------------------------------------------
  // Return hooks
  // -------------------------------------------------------------------------

  return {
    // -- Tool use recording (memelord filters for failures internally) --
    "tool.execute.after": async (input, output) => {
      if (!existsSync(join(cwd, ".memelord"))) return
      if (!currentSessionId) return

      // Fire and forget — don't block the agent
      callHook("post-tool-use", {
        session_id: currentSessionId,
        cwd,
        tool_name: input.tool,
        tool_input: input.args,
        tool_response: output.output ?? "",
      }).catch(() => {})
    },

    // -- Lifecycle events --
    event: async (input: { event: Event }) => {
      const { event } = input

      if (event.type === "session.created") {
        await onSessionCreated(event.properties.info.id)
      } else if (event.type === "session.idle") {
        // Fire and forget — don't block the UI
        onSessionIdle(event.properties.sessionID).catch(() => {})
      } else if (event.type === "session.deleted") {
        await onSessionDeleted(event.properties.info.id)
      }
    },
  }
}
