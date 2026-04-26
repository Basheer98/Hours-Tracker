import { type PoolConfig } from 'pg'

/**
 * Parses `postgres(ql)://[user:password@]host:port[/database][?query]` without WHATWG `URL`
 * (which breaks when the password includes @ or : that are not percent-encoded).
 * Splits the authority using the *last* `@` before the path.
 */
export function parsePostgresConnectionStringLoose(s: string): PoolConfig | null {
  const trimmed = s.trim()
  if (!trimmed) {
    return null
  }
  if (!/^postgres(?:ql)?:\/\//i.test(trimmed)) {
    return null
  }

  const noQuery = trimmed.split('?')[0] ?? ''
  const withoutScheme = noQuery.replace(/^postgres(?:ql)?:\/\//i, '')

  const firstSlash = withoutScheme.indexOf('/')
  const authorityAndMaybePort =
    firstSlash < 0 ? withoutScheme : withoutScheme.slice(0, firstSlash)
  const databasePath =
    firstSlash < 0 ? '' : withoutScheme.slice(firstSlash + 1).split('/')[0] ?? ''

  if (!authorityAndMaybePort) {
    return null
  }

  const at = authorityAndMaybePort.lastIndexOf('@')
  if (at < 0) {
    const { host, port } = parseHostAndPort(authorityAndMaybePort)
    if (!host) {
      return null
    }
    return {
      user: 'postgres',
      password: '',
      host,
      port,
      database: databasePath || undefined,
    }
  }

  const userInfo = authorityAndMaybePort.slice(0, at)
  const hostPart = authorityAndMaybePort.slice(at + 1)
  if (!userInfo || !hostPart) {
    return null
  }

  const colon = userInfo.indexOf(':')
  const user = colon < 0 ? decodeToken(userInfo) : decodeToken(userInfo.slice(0, colon))
  const password = colon < 0 ? undefined : decodeToken(userInfo.slice(colon + 1))

  const { host, port } = parseHostAndPort(hostPart)
  if (!host) {
    return null
  }

  return {
    user,
    password: password ?? '',
    host,
    port,
    database: databasePath || undefined,
  }
}

function decodeToken(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function parseHostAndPort(s: string): { host: string; port?: number } {
  if (s.startsWith('[')) {
    const end = s.indexOf(']')
    if (end < 0) {
      return { host: s }
    }
    const host = s.slice(0, end + 1)
    const after = s.slice(end + 1)
    if (after.startsWith(':') && /^\d+$/.test(after.slice(1))) {
      return { host, port: Number.parseInt(after.slice(1), 10) }
    }
    return { host }
  }
  const lastCol = s.lastIndexOf(':')
  if (lastCol > 0) {
    const portStr = s.slice(lastCol + 1)
    if (/^\d+$/.test(portStr)) {
      return {
        host: s.slice(0, lastCol),
        port: Number.parseInt(portStr, 10),
      }
    }
  }
  return { host: s }
}

/**
 * If the value was accidentally stored as JSON, e.g. `{"url":"postgres://..."}`.
 */
export function unwrapJsonDatabaseUrl(s: string): string | null {
  const t = s.trim()
  if (!t.startsWith('{') || !t.endsWith('}')) {
    return null
  }
  try {
    const o = JSON.parse(t) as { url?: string; connectionString?: string; DATABASE_URL?: string }
    const inner = o.url ?? o.connectionString ?? o.DATABASE_URL
    if (typeof inner === 'string' && inner.length > 0) {
      return inner
    }
  } catch {
    return null
  }
  return null
}
