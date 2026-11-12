import * as fs from 'node:fs'
import * as path from 'node:path'
import { stableJson } from './json.ts'

/**
 * Failure kinds. One alert (GitHub issue) per kind and source repo, never one per run; its items
 * are the individual failures, keyed so that repeats update rather than duplicate.
 */
export const ALERT_KINDS = [
  'build-failure',
  'parity-mismatch',
  'tag-nondeterministic',
  'tag-version-mismatch',
  'test-chain-walk',
  'reconcile-gap',
  'publish-error',
] as const
export type AlertKind = (typeof ALERT_KINDS)[number]

export interface AlertItem {
  key: string
  message: string
  commit?: string
  refs?: string[]
  /** For build failures: whether the commit was a ref's head or tag (so publishing that ref resolves it). */
  head?: boolean
  tag?: string
  details?: string
}

export interface OpenAlert { kind: AlertKind; source: string; items: AlertItem[]; ref: string }

export interface AlertSink {
  describe(): string
  get(source: string, kind: AlertKind): Promise<OpenAlert | null>
  /** Opens the alert, or updates the open one, so that it lists exactly `items`. */
  upsert(source: string, kind: AlertKind, items: AlertItem[], newItems: AlertItem[], runNote: string): Promise<string>
  close(source: string, kind: AlertKind, note: string): Promise<void>
}

export const TITLES: Record<AlertKind, string> = {
  'build-failure': 'build failure',
  'parity-mismatch': 'toolchain parity mismatch',
  'tag-nondeterministic': 'tag build does not reproduce its commit',
  'tag-version-mismatch': 'tag does not match package.json version',
  'test-chain-walk': 'test-chain walk failed',
  'reconcile-gap': 'reconcile found unprocessed refs',
  'publish-error': 'publish run error',
}

export function title(source: string, kind: AlertKind): string {
  return `[registry] ${source}: ${TITLES[kind]} (${kind})`
}

export function renderBody(source: string, kind: AlertKind, items: AlertItem[]): string {
  const lines = [
    `Opened and maintained by the contract registry's publish process. Source: \`${source}\`, failure kind: \`${kind}\`.`,
    '',
    'The publish process updates this issue on every failing run and closes it when every item below is resolved.',
    '',
    `## Current items (${items.length})`,
    '',
  ]
  for (const i of items) {
    lines.push(`- **${i.key}**: ${i.message}${i.refs?.length ? ` (refs: ${i.refs.join(', ')})` : ''}`)
    if (i.details) lines.push('', '  <details><summary>details</summary>', '', '  ```', ...i.details.split('\n').slice(0, 80).map(l => '  ' + l), '  ```', '  </details>', '')
  }
  lines.push('', `<!-- registry-alert-state:${Buffer.from(JSON.stringify(items)).toString('base64')} -->`)
  return lines.join('\n')
}

export function parseBodyItems(body: string): AlertItem[] {
  const m = /<!-- registry-alert-state:([A-Za-z0-9+/=]+) -->/.exec(body)
  return m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : []
}

/** Stand-in for GitHub issues while the data repo is a local prototype: one JSON file per alert. */
export class LocalAlertSink implements AlertSink {
  readonly dir: string
  constructor(dir: string) { this.dir = dir }
  describe() { return `local:${this.dir}` }
  private file(source: string, kind: AlertKind) { return path.join(this.dir, `${source}--${kind}.json`) }
  private read(source: string, kind: AlertKind): any | null {
    const f = this.file(source, kind)
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null
  }
  async get(source: string, kind: AlertKind): Promise<OpenAlert | null> {
    const a = this.read(source, kind)
    return a && a.state === 'open' ? { kind, source, items: a.items, ref: this.file(source, kind) } : null
  }
  async upsert(source: string, kind: AlertKind, items: AlertItem[], newItems: AlertItem[], runNote: string): Promise<string> {
    const prev = this.read(source, kind)
    const now = new Date().toISOString()
    const reopened = !prev || prev.state !== 'open'
    const a = {
      title: title(source, kind),
      state: 'open',
      number: reopened ? (prev?.number ?? 0) + 1 : prev.number,
      openedAt: reopened ? now : prev.openedAt,
      items,
      body: renderBody(source, kind, items),
      comments: [...(reopened ? [] : prev.comments), { at: now, text: `${reopened ? 'Opened' : 'Updated'}: ${runNote}; ${newItems.length} new or repeated item(s): ${newItems.map(i => i.key).join(', ')}` }],
    }
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.file(source, kind), stableJson(a))
    return this.file(source, kind)
  }
  async close(source: string, kind: AlertKind, note: string): Promise<void> {
    const a = this.read(source, kind)
    if (!a || a.state !== 'open') return
    a.state = 'closed'
    a.comments.push({ at: new Date().toISOString(), text: `Closed: ${note}` })
    fs.writeFileSync(this.file(source, kind), stableJson(a))
  }
}

/** GitHub issues in the data repo, using the workflow's own token. */
export class GitHubAlertSink implements AlertSink {
  readonly slug: string
  private readonly token: string
  constructor(slug: string, token: string) { this.slug = slug; this.token = token }
  describe() { return `github:${this.slug}` }

  private async api(method: string, p: string, body?: unknown): Promise<any> {
    const res = await fetch(`https://api.github.com/repos/${this.slug}${p}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`GitHub ${method} ${p}: HTTP ${res.status} ${await res.text()}`)
    return res.status === 204 ? null : res.json()
  }

  private async find(source: string, kind: AlertKind): Promise<any | null> {
    const t = title(source, kind)
    for (let page = 1; page < 20; page++) {
      const issues: any[] = await this.api('GET', `/issues?state=open&labels=registry-alert&per_page=100&page=${page}`)
      const hit = issues.find(i => i.title === t && !i.pull_request)
      if (hit) return hit
      if (issues.length < 100) return null
    }
    return null
  }

  async get(source: string, kind: AlertKind): Promise<OpenAlert | null> {
    const i = await this.find(source, kind)
    return i ? { kind, source, items: parseBodyItems(i.body ?? ''), ref: i.html_url } : null
  }

  async upsert(source: string, kind: AlertKind, items: AlertItem[], newItems: AlertItem[], runNote: string): Promise<string> {
    const body = renderBody(source, kind, items)
    const i = await this.find(source, kind)
    const comment = `${runNote}: ${newItems.length} new or repeated item(s):\n\n${newItems.map(x => `- **${x.key}**: ${x.message}`).join('\n')}`
    if (!i) {
      const created = await this.api('POST', '/issues', { title: title(source, kind), body, labels: ['registry-alert', `source:${source}`, `kind:${kind}`] })
      return created.html_url
    }
    await this.api('PATCH', `/issues/${i.number}`, { body })
    if (newItems.length) await this.api('POST', `/issues/${i.number}/comments`, { body: comment })
    return i.html_url
  }

  async close(source: string, kind: AlertKind, note: string): Promise<void> {
    const i = await this.find(source, kind)
    if (!i) return
    await this.api('POST', `/issues/${i.number}/comments`, { body: `Resolved: ${note}` })
    await this.api('PATCH', `/issues/${i.number}`, { state: 'closed', state_reason: 'completed' })
  }
}
