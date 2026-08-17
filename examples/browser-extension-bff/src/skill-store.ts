import type { DatabaseSync } from 'node:sqlite'

export interface Skill {
  id: string
  name: string
  firstInstruction: string
  finalReplySummary: string
  createdAt: string
}

export function createSkillStore(database: DatabaseSync) {
  database.exec(`CREATE TABLE IF NOT EXISTS agent_skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    first_instruction TEXT NOT NULL,
    final_reply_summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`)

  return {
    list(): Skill[] {
      const rows = database.prepare('SELECT id, name, first_instruction, final_reply_summary, created_at FROM agent_skills ORDER BY created_at DESC').all() as Array<{
        id: string; name: string; first_instruction: string; final_reply_summary: string; created_at: string
      }>
      return rows.map(r => ({
        id: r.id,
        name: r.name,
        firstInstruction: r.first_instruction,
        finalReplySummary: r.final_reply_summary,
        createdAt: r.created_at,
      }))
    },

    save(name: string, firstInstruction: string, finalReplySummary: string): Skill {
      const id = `skill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const createdAt = new Date().toISOString()
      database.prepare('INSERT INTO agent_skills (id, name, first_instruction, final_reply_summary, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, firstInstruction, finalReplySummary, createdAt)
      return { id, name, firstInstruction, finalReplySummary, createdAt }
    },

    delete(id: string): void {
      database.prepare('DELETE FROM agent_skills WHERE id = ?').run(id)
    },
  }
}

export type SkillStore = ReturnType<typeof createSkillStore>