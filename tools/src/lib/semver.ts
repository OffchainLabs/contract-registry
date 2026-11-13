/** Orders tags by semver precedence where they parse, then by name. */
export function compareTags(a: string, b: string): number {
  const pa = parse(a), pb = parse(b)
  if (pa && pb) {
    for (let i = 0; i < 3; i++) if (pa.core[i] !== pb.core[i]) return pa.core[i] - pb.core[i]
    if (!pa.pre.length && pb.pre.length) return 1
    if (pa.pre.length && !pb.pre.length) return -1
    for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
      const x = pa.pre[i], y = pb.pre[i]
      if (x === undefined) return -1
      if (y === undefined) return 1
      const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y)
      if (nx && ny && Number(x) !== Number(y)) return Number(x) - Number(y)
      if (nx !== ny) return nx ? -1 : 1
      if (x !== y) return x < y ? -1 : 1
    }
  } else if (pa || pb) return pa ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

function parse(tag: string): { core: number[]; pre: string[] } | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(tag)
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : null
}

/** A tag is a prerelease when its semver has prerelease identifiers (e.g. `v3.2.0-beta.0`). */
export function isPrerelease(tag: string): boolean {
  const p = parse(tag)
  return !!p && p.pre.length > 0
}
