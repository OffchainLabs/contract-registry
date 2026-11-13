/** Minimal glob: `**` matches across `/`, `*` and `?` don't. Anchored at both ends. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') { i++; re += '(?:.*/)?' } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(path: string, globs: string[]): boolean {
  return globs.some(g => globToRegExp(g).test(path))
}

/** Ref patterns (branches, tags): `*` matches anything, including `/`. */
export function refMatches(name: string, patterns: string[]): boolean {
  return patterns.some(p => new RegExp(`^${p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(name))
}
