/**
 * Store management: DB path resolution, store factory, and session state on disk.
 *
 * Databases live at ~/.config/memelord/projects/<project-key>/memory.db
 * where project-key is derived from the git remote URL (stable across worktrees).
 *
 * Session state (injected memory IDs, failures) is stored alongside the DB
 * in a sessions/ subdirectory, surviving OpenCode restarts.
 */
import { createMemoryStore, type MemoryStore, type EmbedFn } from 'memelord'
import { createHash } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  unlinkSync,
} from 'fs'
import type { PluginInput } from '@opencode-ai/plugin'
type BunShell = PluginInput['$']
import { createEmbedder } from './embedder.js'

// ---------------------------------------------------------------------------
// Project key derivation (cached)
// ---------------------------------------------------------------------------

const projectKeyCache = new Map<string, string>()

/**
 * Derive a stable project key from the git remote URL.
 * Falls back to hashing the worktree path if no remote is available.
 * Results are cached so the hash is only computed once per worktree.
 */
export async function getProjectKey(
  worktree: string,
  $: BunShell,
): Promise<string> {
  const cached = projectKeyCache.get(worktree)
  if (cached) return cached

  let source = worktree
  try {
    const remoteUrl = await $`git -C ${worktree} remote get-url origin`
      .quiet()
      .nothrow()
      .text()
    if (remoteUrl.trim()) {
      source = remoteUrl.trim()
    }
  } catch {}

  const key = createHash('sha256').update(source).digest('hex').slice(0, 16)
  projectKeyCache.set(worktree, key)
  return key
}

// ---------------------------------------------------------------------------
// Database path
// ---------------------------------------------------------------------------

function getProjectDir(projectKey: string): string {
  const dir = join(homedir(), '.config', 'memelord', 'projects', projectKey)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function getSessionsDir(projectKey: string): string {
  const dir = join(getProjectDir(projectKey), 'sessions')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------------------
// Session state (on disk)
// ---------------------------------------------------------------------------

export interface SessionState {
  sessionId: string
  startedAt: number
  injectedMemoryIds: string[]
}

export interface ToolFailure {
  timestamp: number
  toolName: string
  toolInput: unknown
  errorSummary: string
}

function sessionFilePath(projectKey: string, sessionId: string): string {
  return join(getSessionsDir(projectKey), `${sessionId}.json`)
}

function failuresFilePath(projectKey: string, sessionId: string): string {
  return join(getSessionsDir(projectKey), `${sessionId}.failures.jsonl`)
}

// ---------------------------------------------------------------------------
// Store manager
// ---------------------------------------------------------------------------

export interface StoreManager {
  /** Light store with dummy embedder — for hooks (fast, no model loading). */
  getStore(): Promise<MemoryStore>
  /** Live store with real embedder — for tools + session.deleted (lazy-loads model). */
  getLiveStore(): Promise<MemoryStore>
  /** Set the current session ID (called on session.created). */
  setCurrentSessionId(sessionId: string): void

  // Session state
  getSessionState(sessionId: string): SessionState | null
  setSessionState(sessionId: string, state: SessionState): void
  getFailures(sessionId: string): ToolFailure[]
  appendFailure(sessionId: string, failure: ToolFailure): void
  cleanupSession(sessionId: string): void
}

export async function createStoreManager(
  worktree: string,
  $: BunShell,
): Promise<StoreManager> {
  const projectKey = await getProjectKey(worktree, $)
  const dbPath = join(getProjectDir(projectKey), 'memory.db')

  const dummyEmbed: EmbedFn = async () => new Float32Array(384)

  let currentSessionId = "unknown"
  let lightStore: MemoryStore | null = null
  let liveStore: MemoryStore | null = null
  let lightStoreSessionId = ""
  let liveStoreSessionId = ""

  function setCurrentSessionId(sessionId: string): void {
    currentSessionId = sessionId
  }

  async function getStore(): Promise<MemoryStore> {
    if (!lightStore || lightStoreSessionId !== currentSessionId) {
      if (lightStore) await lightStore.close().catch(() => {})
      lightStore = createMemoryStore({
        dbPath,
        sessionId: currentSessionId,
        embed: dummyEmbed,
      })
      await lightStore.init()
      lightStoreSessionId = currentSessionId
    }
    return lightStore
  }

  async function getLiveStore(): Promise<MemoryStore> {
    if (!liveStore || liveStoreSessionId !== currentSessionId) {
      if (liveStore) await liveStore.close().catch(() => {})
      const embed = await createEmbedder()
      liveStore = createMemoryStore({
        dbPath,
        sessionId: currentSessionId,
        embed,
      })
      await liveStore.init()
      liveStoreSessionId = currentSessionId
    }
    return liveStore
  }

  function getSessionState(sessionId: string): SessionState | null {
    const path = sessionFilePath(projectKey, sessionId)
    if (!existsSync(path)) return null
    try {
      return JSON.parse(readFileSync(path, 'utf-8'))
    } catch {
      return null
    }
  }

  function setSessionState(sessionId: string, state: SessionState): void {
    writeFileSync(sessionFilePath(projectKey, sessionId), JSON.stringify(state))
  }

  function getFailures(sessionId: string): ToolFailure[] {
    const path = failuresFilePath(projectKey, sessionId)
    if (!existsSync(path)) return []
    try {
      return readFileSync(path, "utf-8")
        .trim()
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean) as ToolFailure[]
    } catch {
      return []
    }
  }

  function appendFailure(sessionId: string, failure: ToolFailure): void {
    appendFileSync(
      failuresFilePath(projectKey, sessionId),
      JSON.stringify(failure) + "\n",
    )
  }

  function cleanupSession(sessionId: string): void {
    const sf = sessionFilePath(projectKey, sessionId)
    const ff = failuresFilePath(projectKey, sessionId)
    if (existsSync(sf))
      try {
        unlinkSync(sf)
      } catch {}
    if (existsSync(ff))
      try {
        unlinkSync(ff)
      } catch {}
  }

  return {
    getStore,
    getLiveStore,
    setCurrentSessionId,
    getSessionState,
    setSessionState,
    getFailures,
    appendFailure,
    cleanupSession,
  }
}
