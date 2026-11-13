import * as fs from 'node:fs'
import * as path from 'node:path'

/** Deterministic JSON text: callers build objects in canonical key order; maps are sorted here. */
export function stableJson(v: unknown): string {
  return JSON.stringify(v, null, 2) + '\n'
}

export function sortedRecord<T>(r: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

export function writeFileIfChanged(file: string, content: string): boolean {
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
  return true
}

export function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...listJsonFiles(p))
    else if (e.name.endsWith('.json')) out.push(p)
  }
  return out.sort()
}
