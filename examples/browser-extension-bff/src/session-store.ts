import type { DatabaseSync } from 'node:sqlite'

export interface SessionMeta {
  id: string
  title: string
  titleGenerated: boolean
  createdAt: string
  updatedAt: string
}

export function createSessionStore(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS agent_session_meta (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    title_generated INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`)

  return {
    get(id: string): SessionMeta | null {
      const row = database.prepare('SELECT id, title, title_generated, created_at, updated_at FROM agent_session_meta WHERE id = ?').get(id) as
        | { id: string; title: string; title_generated: number; created_at: string; updated_at: string }
        | undefined
      if (!row) return null
      return {
        id: row.id,
        title: row.title,
        titleGenerated: row.title_generated === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    },

    ensure(id: string): SessionMeta {
      const existing = this.get(id)
      if (existing) return existing
      const now = new Date().toISOString()
      database.prepare('INSERT OR IGNORE INTO agent_session_meta (id, title, title_generated, created_at, updated_at) VALUES (?, ?, 0, ?, ?)')
        .run(id, '', now, now)
      return { id, title: '', titleGenerated: false, createdAt: now, updatedAt: now }
    },

    updateTitle(id: string, title: string): void {
      database.prepare('UPDATE agent_session_meta SET title = ?, title_generated = 1, updated_at = ? WHERE id = ?')
        .run(title, new Date().toISOString(), id)
    },

    touch(id: string): void {
      database.prepare('UPDATE agent_session_meta SET updated_at = ? WHERE id = ?')
        .run(new Date().toISOString(), id)
    },

    list(): SessionMeta[] {
      const rows = database.prepare('SELECT id, title, title_generated, created_at, updated_at FROM agent_session_meta ORDER BY updated_at DESC').all() as Array<{
        id: string; title: string; title_generated: number; created_at: string; updated_at: string
      }>
      return rows.map(r => ({
        id: r.id,
        title: r.title,
        titleGenerated: r.title_generated === 1,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      }))
    },

    delete(id: string): void {
      database.prepare('DELETE FROM agent_session_meta WHERE id = ?').run(id)
      database.prepare('DELETE FROM agent_sessions WHERE session_id = ?').run(id)
    },
  }
}

export type SessionMetaStore = ReturnType<typeof createSessionStore>