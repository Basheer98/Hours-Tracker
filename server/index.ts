import 'dotenv/config'
import cors from 'cors'
import express, { type Request, type Response, type NextFunction } from 'express'
import { parseIntoClientConfig } from 'pg-connection-string'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg, { type PoolConfig } from 'pg'
import { parsePostgresConnectionStringLoose, unwrapJsonDatabaseUrl } from './pgUrl'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, '../dist')
const isProd = process.env.NODE_ENV === 'production'

/** Common when pasting into Railway: wrapped in quotes, which breaks URL parsing. */
function normalizeDatabaseUrl(s: string): string {
  let t = s.replace(/^\uFEFF/, '').replace(/[\n\r]+/g, '').trim()
  if (t.length >= 2) {
    const q0 = t[0]
    const q1 = t[t.length - 1]
    if ((q0 === '"' && q1 === '"') || (q0 === "'" && q1 === "'")) {
      t = t.slice(1, -1).trim()
    }
  }
  return t
}

/**
 * If the password contains a literal @ (not percent-encoded as %40), the URL will have
 * more than one @ before the hostname and node-postgres cannot parse it. This rebuilds
 * the userinfo with an encoded password.
 */
function repairPasswordWithUnencodedAt(url: string): string {
  const scheme = url.match(/^(postgres(?:ql)?:\/\/)/i)?.[0]
  if (!scheme) return url
  const rest = url.slice(scheme.length)
  const parts = rest.split('@')
  if (parts.length < 3) {
    return url
  }
  const first = parts[0] ?? ''
  const hostAndPath = parts[parts.length - 1] ?? ''
  const col = first.indexOf(':')
  if (col < 0) {
    return url
  }
  const user = first.slice(0, col)
  const passPrefix = first.slice(col + 1)
  const passMiddle = parts.slice(1, -1)
  const password = [passPrefix, ...passMiddle].join('@')
  return `${scheme}${user}:${encodeURIComponent(password)}@${hostAndPath}`
}

function buildPoolFromIndividualPgEnvs(): PoolConfig | null {
  const host = process.env.PGHOST?.trim()
  const user = process.env.PGUSER?.trim()
  const database = process.env.PGDATABASE?.trim()
  if (!host || !user || !database) {
    return null
  }
  const port = process.env.PGPORT ? Number.parseInt(process.env.PGPORT, 10) : 5432
  return {
    host,
    port: Number.isNaN(port) ? 5432 : port,
    user,
    password: process.env.PGPASSWORD ?? '',
    database,
  }
}

function applySslToRemoteHosts(config: PoolConfig): PoolConfig {
  if (process.env.DATABASE_SSL === '0' || process.env.DATABASE_SSL === 'false') {
    return { ...config, ssl: false }
  }
  const host = config.host ?? ''
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === ''
  if (host && !isLocal) {
    return { ...config, ssl: { rejectUnauthorized: false } }
  }
  return config
}

function buildPoolConfig(): PoolConfig {
  let raw = normalizeDatabaseUrl(process.env.DATABASE_URL ?? '')
  const jsonUnwrapped = unwrapJsonDatabaseUrl(raw)
  if (jsonUnwrapped) {
    raw = normalizeDatabaseUrl(jsonUnwrapped)
  }
  if (!raw) {
    const fromEnv = buildPoolFromIndividualPgEnvs()
    if (fromEnv) {
      return applySslToRemoteHosts(fromEnv)
    }
    console.error('DATABASE_URL is missing. Set it from the Railway Postgres service, or set PGHOST, PGUSER, PGDATABASE, PGPASSWORD, PGPORT.',
    )
    process.exit(1)
  }
  if (!/^postgres(ql)?:\/\//i.test(raw)) {
    const fromEnv = buildPoolFromIndividualPgEnvs()
    if (fromEnv) {
      return applySslToRemoteHosts(fromEnv)
    }
    console.error(
      'DATABASE_URL must start with postgres:// or postgresql://\nGot prefix:',
      raw.slice(0, 40),
    )
    process.exit(1)
  }

  const repaired = repairPasswordWithUnencodedAt(raw)
  const unique = [raw, repaired].filter((c, i, arr) => arr.indexOf(c) === i)

  for (const candidate of unique) {
    try {
      const config = parseIntoClientConfig(candidate) as PoolConfig
      return applySslToRemoteHosts(config)
    } catch {
      // try next
    }
  }

  for (const candidate of unique) {
    const manual = parsePostgresConnectionStringLoose(candidate)
    if (manual) {
      return applySslToRemoteHosts(manual)
    }
  }

  const fromEnv = buildPoolFromIndividualPgEnvs()
  if (fromEnv) {
    console.error(
      'Note: DATABASE_URL was invalid, but using PG* environment variables for the connection.',
    )
    return applySslToRemoteHosts(fromEnv)
  }

  const hint =
    process.env.DATABASE_URL == null || process.env.DATABASE_URL.trim() === ''
      ? 'DATABASE_URL is not set. In Railway, link Postgres and add a Reference, or set PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE on this service.'
      : 'Copy the connection URL from Postgres again, or in this service add: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE (from the Postgres service Variables tab) so the app can connect without parsing DATABASE_URL.'
  console.error('Could not turn DATABASE_URL into a connection.\n' + hint)
  process.exit(1)
}

const pool = new Pool(buildPoolConfig())
const app = express()
const port = Number(process.env.PORT) || 8787
const requiredKey = process.env.DTC_API_KEY

app.use(
  cors(
    isProd
      ? { origin: false }
      : { origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] },
  ),
)
app.use(express.json({ limit: '32kb' }))

app.use((req, res, next) => {
  if (req.path === '/api/health' || !req.path.startsWith('/api')) {
    return next()
  }
  if (!dbReady) {
    res.status(503).json({ error: 'Database unavailable' })
    return
  }
  return next()
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^\d{2}:\d{2}$/

type Row = {
  work_date: string
  login: string | null
  logout: string | null
  updated_at: Date
}

function oneStr(p: string | string[] | undefined): string {
  if (p == null) return ''
  return Array.isArray(p) ? (p[0] ?? '') : p
}

let dbReady = false

function describePgError(err: unknown): string {
  const e = err as { code?: string; message?: string }
  const c = e.code
  if (c === 'ECONNREFUSED') {
    return 'Postgres is not accepting connections (wrong host/port, or database not up yet).'
  }
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') {
    return 'Postgres host name could not be resolved. Check PGHOST / DATABASE_URL.'
  }
  if (c === 'ETIMEDOUT' || c === 'ESOCKETTIMEDOUT') {
    return 'Connection to Postgres timed out (security group, or wrong network URL).'
  }
  if (c === '28P01') {
    return 'Postgres rejected the password. Copy credentials again from the Postgres service.'
  }
  if (c === 'SELF_SIGNED_CERT_IN_CHAIN' || c === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return 'SSL certificate issue — try setting DATABASE_SSL=true in Railway and redeploy, or use the URL from the same cloud provider.'
  }
  return e.message ?? String(err)
}

async function ensureTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS day_entry (
      work_date TEXT PRIMARY KEY,
      login TEXT,
      logout TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}

function auth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (requiredKey == null || requiredKey.length === 0) {
    next()
    return
  }
  const header =
    (req.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '').trim() ||
    (req.get('X-API-Key') ?? '').trim()
  if (header !== requiredKey) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  next()
}

app.get('/api/health', async (_req, res) => {
  if (!dbReady) {
    res.status(503).json({ ok: false, db: false, reason: 'Database not ready' })
    return
  }
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true, db: true })
  } catch {
    res.status(503).json({ ok: false, db: false })
  }
})

app.get('/api/entries', auth, async (req, res) => {
  const from = String(oneStr(req.query.from as string | string[] | undefined))
  const to = String(oneStr(req.query.to as string | string[] | undefined))
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    res.status(400).json({ error: 'from and to must be YYYY-MM-DD' })
    return
  }
  if (from > to) {
    res.status(400).json({ error: 'from must be before to' })
    return
  }
  const { rows } = await pool.query<Row>(
    `SELECT work_date, login, logout, updated_at
     FROM day_entry
     WHERE work_date >= $1 AND work_date <= $2
     ORDER BY work_date ASC`,
    [from, to],
  )
  res.json(
    rows.map((r) => ({
      workDate: r.work_date,
      login: r.login,
      logout: r.logout,
      updatedAt: (r.updated_at as Date).toISOString(),
    })),
  )
})

app.put('/api/entries/:workDate', auth, async (req, res) => {
  const workDate = oneStr(req.params.workDate)
  if (!DATE_RE.test(workDate)) {
    res.status(400).json({ error: 'Invalid workDate' })
    return
  }
  const body = req.body as { login?: string | null; logout?: string | null }
  const nextLogin =
    'login' in body ? (body.login === '' || body.login == null ? null : String(body.login)) : undefined
  const nextLogout =
    'logout' in body
      ? body.logout === '' || body.logout == null
        ? null
        : String(body.logout)
      : undefined

  if (nextLogin != null && !TIME_RE.test(nextLogin)) {
    res.status(400).json({ error: 'login must be HH:MM' })
    return
  }
  if (nextLogout != null && !TIME_RE.test(nextLogout)) {
    res.status(400).json({ error: 'logout must be HH:MM' })
    return
  }

  const existing = await pool.query<Row>(
    'SELECT work_date, login, logout, updated_at FROM day_entry WHERE work_date = $1',
    [workDate],
  )
  const e = existing.rows[0] ?? null
  const login = nextLogin !== undefined ? nextLogin : (e?.login ?? null)
  const logout = nextLogout !== undefined ? nextLogout : (e?.logout ?? null)

  const { rows: out } = await pool.query<Row>(
    `INSERT INTO day_entry (work_date, login, logout, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (work_date) DO UPDATE SET
       login = $2, logout = $3, updated_at = NOW()
     RETURNING work_date, login, logout, updated_at`,
    [workDate, login, logout],
  )
  const row = out[0]!
  res.json({
    workDate: row.work_date,
    login: row.login,
    logout: row.logout,
    updatedAt: (row.updated_at as Date).toISOString(),
  })
})

app.delete('/api/entries/:workDate', auth, async (req, res) => {
  const workDate = oneStr(req.params.workDate)
  if (!DATE_RE.test(workDate)) {
    res.status(400).json({ error: 'Invalid workDate' })
    return
  }
  await pool.query('DELETE FROM day_entry WHERE work_date = $1', [workDate])
  res.status(204).end()
})

if (isProd) {
  app.use(express.static(distDir, { maxAge: '1h' }))
  app.get(/[\s\S]*/, (req, res) => {
    if (req.path.startsWith('/api') || path.extname(req.path)) {
      res.status(404).end()
      return
    }
    res.sendFile(path.join(distDir, 'index.html'), (err) => {
      if (err) res.status(500).end()
    })
  })
}

const DB_RETRIES = 8
const DB_RETRY_MS = 3000
const allowStartNoDb = process.env.ALLOW_START_WITHOUT_DB === '1' || process.env.ALLOW_START_WITHOUT_DB === 'true'

void (async () => {
  for (let attempt = 1; attempt <= DB_RETRIES; attempt++) {
    try {
      await ensureTable()
      dbReady = true
      console.log('Postgres connected and day_entry table is ready.')
      break
    } catch (err) {
      const e = err as { code?: string; message?: string }
      console.error(
        `Database setup (attempt ${attempt}/${DB_RETRIES}): [${e.code ?? 'n/a'}] ${describePgError(err)}`,
      )
      if (e.message && e.code !== 'ECONNREFUSED') {
        console.error('(details)', e.message)
      }
      if (attempt < DB_RETRIES) {
        await new Promise((r) => setTimeout(r, DB_RETRY_MS))
      }
    }
  }

  if (!dbReady) {
    if (allowStartNoDb) {
      console.error(
        'Starting HTTP without database (ALLOW_START_WITHOUT_DB=1). API will return 503 until Postgres works.',
      )
    } else {
      console.error('Giving up. Fix DATABASE_URL / PG* vars, then redeploy. Set ALLOW_START_WITHOUT_DB=1 to boot the app anyway for debugging.')
      process.exit(1)
    }
  }

  app.listen(port, '0.0.0.0', () => {
    if (isProd) {
      console.log(`DTC server listening on ${port}, static from ${distDir}, dbReady=${dbReady}`)
    } else {
      console.log(`DTC API listening on ${port}, dbReady=${dbReady}`)
    }
  })
})()
