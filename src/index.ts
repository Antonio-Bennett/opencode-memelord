/**
 * opencode-memelord: Standalone OpenCode plugin for memelord persistent memory.
 *
 * Uses the memelord SDK directly — no MCP server, no `memelord init`,
 * no per-project configuration needed. Databases are stored globally
 * at ~/.config/memelord/projects/<project-key>/memory.db, keyed by
 * git remote URL so multiple worktrees share the same database.
 *
 * Provides:
 *   - 5 custom tools (memory_start_task, memory_report, memory_end_task,
 *     memory_contradict, memory_status) replacing the MCP server
 *   - Lifecycle hooks (session.created, tool.execute.after, session.idle,
 *     session.deleted) for automatic memory instrumentation
 */
import type { Plugin } from '@opencode-ai/plugin'
import type { Event } from '@opencode-ai/sdk'
import { createStoreManager } from './store.js'
import { createTools } from './tools.js'
import {
  onSessionCreated,
  onToolAfter,
  onSessionIdle,
  onSessionDeleted,
} from './hooks.js'

export const MemelordPlugin: Plugin = async ({ client, worktree, $ }) => {
  const storeManager = await createStoreManager(worktree, $)

  return {
    // Custom tools (replaces MCP server)
    tool: createTools(storeManager),

    // Tool failure recording
    'tool.execute.after': async (input, output) => {
      onToolAfter(
        input.sessionID,
        input.tool,
        input.args,
        output.output ?? '',
        output.metadata,
        storeManager,
      )
    },

    // Lifecycle events
    event: async (input: { event: Event }) => {
      const { event } = input

      if (event.type === 'session.created') {
        await onSessionCreated(event.properties.info.id, client, storeManager)
      } else if (event.type === 'session.idle') {
        // Fire and forget — don't block the UI
        onSessionIdle(event.properties.sessionID, client, storeManager).catch(
          () => {},
        )
      } else if (event.type === 'session.deleted') {
        await onSessionDeleted(event.properties.info.id, client, storeManager)
      }
    },
  }
}
