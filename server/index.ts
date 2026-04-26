import 'dotenv/config'
import cors from 'cors'
import express, { type Request, type Response, type NextFunction } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const { Pool } = pg

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.join(__dirname, '../dist')
const isProd = process.env.NODE_ENV === 'production'

if (!process.env.DATABASE_URL) {
  console.error('Missing DATABASE_URL (PostgreSQL connection string).')
  process.exit(1)
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
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
  try {
    await pool.query('SELECT 1')
    res.json({ ok: true })
  } catch {
    res.status(503).json({ ok: false })
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

void (async () => {
  try {
    await ensureTable()
  } catch (err) {
    console.error('Database setup failed:', err)
    process.exit(1)
  }
  app.listen(port, () => {
    if (isProd) {
      console.log(`DTC server listening on ${port}, static from ${distDir}`)
    } else {
      console.log(`DTC API + Postgres listening on ${port}`)
    }
  })
})()
