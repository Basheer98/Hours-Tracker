import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ApiError, deleteEntry, fetchEntriesRange, saveEntry } from './lib/api'
import {
  monthLabel,
  parseDateKey,
  shiftMonth,
  toDateKey,
  weekOfMonth,
} from './lib/dates'
import {
  formatClock,
  paidHoursForDay,
  parseTimeOnDate,
  SHIFT_SPAN_HOURS,
  targetLogout,
} from './lib/shift'
import {
  getOrCreateEntry,
  loadState,
  saveState,
  type AppState,
  type DayEntry,
} from './lib/storage'

function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate()
}

function monthDateKeys(viewMonth: Date): string[] {
  const y = viewMonth.getFullYear()
  const m = viewMonth.getMonth()
  const n = daysInMonth(y, m)
  const keys: string[] = []
  for (let d = 1; d <= n; d++) {
    keys.push(toDateKey(new Date(y, m, d, 12, 0, 0, 0)))
  }
  return keys
}

function formatHours(n: number): string {
  if (Number.isNaN(n) || n === 0) return n === 0 ? '0' : '—'
  const h = Math.floor(n)
  const m = Math.round((n - h) * 60)
  if (m === 0) return `${h}h`
  return `${h}h ${m}m`
}

function formatMoney(n: number, currency: string): string {
  if (!Number.isFinite(n)) return '—'
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: currency || 'USD',
    maximumFractionDigits: 2,
  }).format(n)
}

type SaveUi = { kind: 'idle' } | { kind: 'loading' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

export default function App() {
  const [state, setState] = useState<AppState>(() => loadState())
  const [viewMonth, setViewMonth] = useState(() => {
    const t = new Date()
    return new Date(t.getFullYear(), t.getMonth(), 1, 12, 0, 0, 0)
  })
  const [activeDateKey, setActiveDateKey] = useState(() => toDateKey(new Date()))
  const [showSettings, setShowSettings] = useState(false)
  const [saveUi, setSaveUi] = useState<SaveUi>({ kind: 'idle' })
  const [monthSyncError, setMonthSyncError] = useState<string | null>(null)

  const stateRef = useRef(state)
  useLayoutEffect(() => {
    stateRef.current = state
  }, [state])

  const monthKeys = useMemo(() => monthDateKeys(viewMonth), [viewMonth])
  const persist = useCallback((updater: (prev: AppState) => AppState) => {
    setState((prev) => {
      const next = updater(prev)
      saveState(next)
      return next
    })
  }, [])

  const saveTimers = useRef<ReturnType<typeof setTimeout> | null>(null)

  const setEntry = useCallback(
    (dateKey: string, patch: Partial<DayEntry>) => {
      setState((prev) => {
        const entry: DayEntry = {
          ...getOrCreateEntry(prev.entries, dateKey),
          ...patch,
          dateKey,
        }
        const next: AppState = {
          ...prev,
          entries: { ...prev.entries, [dateKey]: entry },
        }
        saveState(next)

        if (next.settings.apiKey.trim()) {
          setSaveUi({ kind: 'saving' })
          if (saveTimers.current) clearTimeout(saveTimers.current)
          const apiKey = next.settings.apiKey.trim()
          saveTimers.current = setTimeout(() => {
            const e = getOrCreateEntry(stateRef.current.entries, dateKey)
            void (async () => {
              try {
                const saved = await saveEntry(
                  dateKey,
                  { login: e.login, logout: e.logout },
                  apiKey,
                )
                setState((s) => ({
                  ...s,
                  entries: { ...s.entries, [dateKey]: saved },
                }))
                setSaveUi({ kind: 'saved' })
                window.setTimeout(() => setSaveUi((u) => (u.kind === 'saved' ? { kind: 'idle' } : u)), 2000)
              } catch (err) {
                const message =
                  err instanceof ApiError && err.status === 401
                    ? 'Invalid API key (check server DTC_API_KEY and Settings).'
                    : err instanceof Error
                      ? err.message
                      : 'Save failed'
                setSaveUi({ kind: 'error', message })
              }
            })()
          }, 450)
        } else {
          setSaveUi({ kind: 'idle' })
        }

        return next
      })
    },
    [],
  )

  const flushNow = useCallback(
    (dateKey: string) => {
      const akey = stateRef.current.settings.apiKey.trim()
      if (!akey) return
      if (saveTimers.current) {
        clearTimeout(saveTimers.current)
        saveTimers.current = null
      }
      const e = getOrCreateEntry(stateRef.current.entries, dateKey)
      setSaveUi({ kind: 'saving' })
      void (async () => {
        try {
          const saved = await saveEntry(
            dateKey,
            { login: e.login, logout: e.logout },
            akey,
          )
          setState((s) => ({ ...s, entries: { ...s.entries, [dateKey]: saved } }))
          setSaveUi({ kind: 'saved' })
          window.setTimeout(() => setSaveUi((u) => (u.kind === 'saved' ? { kind: 'idle' } : u)), 2000)
        } catch (err) {
          const message =
            err instanceof ApiError && err.status === 401
              ? 'Invalid API key.'
              : err instanceof Error
                ? err.message
                : 'Save failed'
          setSaveUi({ kind: 'error', message })
        }
      })()
    },
    [],
  )

  const setSettings = useCallback(
    (patch: Partial<AppState['settings']>) => {
      persist((prev) => ({
        ...prev,
        settings: { ...prev.settings, ...patch },
      }))
    },
    [persist],
  )

  const apiKey = state.settings.apiKey.trim()

  useEffect(() => {
    const keys = monthDateKeys(viewMonth)
    const f = keys[0] ?? ''
    const t = keys[keys.length - 1] ?? ''
    if (!apiKey || !f || !t) {
      return
    }
    let cancel = false
    void (async () => {
      if (saveTimers.current) {
        clearTimeout(saveTimers.current)
        saveTimers.current = null
      }
      setSaveUi({ kind: 'loading' })
      try {
        const data = await fetchEntriesRange(f, t, apiKey)
        if (cancel) return
        setState((s) => {
          const next = { ...s.entries }
          for (const k of keys) {
            if (data[k]) next[k] = data[k]!
            else delete next[k]
          }
          return { ...s, entries: next }
        })
        setMonthSyncError(null)
        setSaveUi({ kind: 'idle' })
      } catch (err) {
        if (cancel) return
        setMonthSyncError(
          err instanceof ApiError && err.status === 401
            ? 'Not authorized. Check your API key matches the server DTC_API_KEY.'
            : err instanceof Error
              ? err.message
              : 'Could not load this month from the server.',
        )
        setSaveUi({ kind: 'error', message: 'Month load failed' })
      }
    })()
    return () => {
      cancel = true
    }
  }, [apiKey, viewMonth])

  const activeEntry = getOrCreateEntry(state.entries, activeDateKey)
  const loginAt =
    activeEntry.login != null
      ? parseTimeOnDate(activeDateKey, activeEntry.login)
      : null
  const targetOut = loginAt != null ? targetLogout(loginAt) : null
  const paid =
    activeEntry.login && activeEntry.logout
      ? paidHoursForDay(activeDateKey, activeEntry.login, activeEntry.logout)
      : null

  const weekStats = useMemo(() => {
    const hours: Record<1 | 2 | 3 | 4, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
    const rate = state.settings.hourlyRate
    for (const key of monthKeys) {
      const e = state.entries[key]
      if (!e?.login || !e?.logout) continue
      const p = paidHoursForDay(key, e.login, e.logout)
      const w = weekOfMonth(parseDateKey(key))
      hours[w] += p
    }
    const pay = (h: number) => (rate > 0 ? h * rate : 0)
    return { hours, pay }
  }, [state.entries, monthKeys, state.settings.hourlyRate])

  const monthRows = useMemo(() => {
    return monthKeys
      .map((k) => {
        const e = getOrCreateEntry(state.entries, k)
        if (!e.login && !e.logout) return null
        const p =
          e.login && e.logout
            ? paidHoursForDay(k, e.login, e.logout)
            : null
        return { k, e, p, w: weekOfMonth(parseDateKey(k)) }
      })
      .filter((x): x is NonNullable<typeof x> => x != null)
      .sort((a, b) => b.k.localeCompare(a.k))
  }, [state.entries, monthKeys])

  const clearDay = useCallback(() => {
    if (apiKey) {
      if (saveTimers.current) {
        clearTimeout(saveTimers.current)
        saveTimers.current = null
      }
      void (async () => {
        try {
          await deleteEntry(activeDateKey, apiKey)
          setState((s) => {
            const next = { ...s.entries }
            delete next[activeDateKey]
            return { ...s, entries: next }
          })
          setSaveUi({ kind: 'idle' })
        } catch (err) {
          setSaveUi({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Delete failed',
          })
        }
      })()
    } else {
      persist((prev) => {
        const next = { ...prev.entries }
        delete next[activeDateKey]
        return { ...prev, entries: next }
      })
    }
  }, [apiKey, activeDateKey, persist])

  return (
    <div className="font-sans mx-auto flex min-h-dvh max-w-lg flex-col gap-6 px-4 py-6 pb-24 sm:px-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-50 sm:text-3xl">
            DTC Hours
          </h1>
          <p className="mt-0.5 text-sm text-slate-400">
            {SHIFT_SPAN_HOURS}h shift · 8h paid · 0.5h break
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowSettings((s) => !s)}
          className="self-start rounded-lg border border-slate-600/80 bg-slate-800/60 px-3 py-1.5 text-sm font-medium text-slate-200 transition hover:border-cyan-500/50 hover:bg-slate-800"
        >
          {showSettings ? 'Done' : 'Settings'}
        </button>
      </header>

      {showSettings && (
        <section className="rounded-2xl border border-slate-700/80 bg-slate-800/40 p-4 shadow-lg shadow-black/20">
          <h2 className="text-sm font-medium uppercase tracking-wide text-slate-500">
            Server & pay
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            With an API key, login and logout are stored on your Railway database. The key
            is only in this browser; set the same value as <code className="text-cyan-300/90">DTC_API_KEY</code> on the server.
          </p>
          <label className="mt-4 flex flex-col gap-1">
            <span className="text-xs text-slate-500">Server API key</span>
            <input
              className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-slate-100 focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/40 focus:outline-none"
              type="password"
              autoComplete="off"
              value={state.settings.apiKey}
              onChange={(e) => {
                setSettings({ apiKey: e.target.value })
                setSaveUi({ kind: 'idle' })
                setMonthSyncError(null)
              }}
              placeholder="Same as Railway DTC_API_KEY"
            />
          </label>
          <p className="mt-1 text-xs text-slate-500">Leave empty to use this device only (no Postgres).</p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-slate-500">Hourly rate</span>
              <input
                className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-slate-100 focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/40 focus:outline-none"
                type="number"
                min={0}
                step="0.01"
                value={state.settings.hourlyRate || ''}
                onChange={(e) => {
                  const v = e.target.value === '' ? 0 : Number(e.target.value)
                  if (!Number.isNaN(v)) setSettings({ hourlyRate: v })
                }}
                placeholder="0"
              />
            </label>
            <label className="flex w-full flex-col gap-1 sm:max-w-[140px]">
              <span className="text-xs text-slate-500">Currency</span>
              <input
                className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-2 text-slate-100 uppercase focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/40 focus:outline-none"
                value={state.settings.currency}
                onChange={(e) => setSettings({ currency: e.target.value.slice(0, 3) })}
                maxLength={3}
                placeholder="USD"
              />
            </label>
          </div>
        </section>
      )}

      {monthSyncError && apiKey && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-3 py-2 text-sm text-amber-200/90">
          {monthSyncError}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          className="rounded-lg border border-slate-600/80 p-2 text-slate-300 hover:bg-slate-800/80"
          onClick={() => setViewMonth((m) => shiftMonth(m, -1))}
          aria-label="Previous month"
        >
          ←
        </button>
        <h2 className="text-center text-lg font-medium text-slate-200">
          {monthLabel(viewMonth)}
        </h2>
        <button
          type="button"
          className="rounded-lg border border-slate-600/80 p-2 text-slate-300 hover:bg-slate-800/80"
          onClick={() => setViewMonth((m) => shiftMonth(m, 1))}
          aria-label="Next month"
        >
          →
        </button>
      </div>

      <section className="rounded-2xl border border-cyan-500/25 bg-linear-to-b from-slate-800/50 to-slate-900/50 p-4 shadow-lg shadow-cyan-950/20">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-sm font-medium text-slate-300">Work day</h2>
          <div className="flex items-center gap-2">
            <input
              type="date"
              className="rounded-lg border border-slate-600 bg-slate-900/90 px-2 py-1.5 text-sm text-slate-100 focus:border-cyan-500/70 focus:ring-1 focus:ring-cyan-500/40 focus:outline-none"
              value={activeDateKey}
              onChange={(e) => {
                if (e.target.value) {
                  flushNow(activeDateKey)
                  setActiveDateKey(e.target.value)
                  const [Y, M] = e.target.value.split('-').map(Number)
                  setViewMonth(new Date(Y, M - 1, 1, 12, 0, 0, 0))
                }
              }}
            />
            <button
              type="button"
              className="rounded-md bg-slate-700/80 px-2.5 py-1.5 text-xs font-medium text-cyan-200 hover:bg-slate-600"
              onClick={() => {
                flushNow(activeDateKey)
                const t = new Date()
                setActiveDateKey(toDateKey(t))
                setViewMonth(new Date(t.getFullYear(), t.getMonth(), 1, 12, 0, 0, 0))
              }}
            >
              Today
            </button>
          </div>
        </div>

        {apiKey && (
          <p className="mb-3 text-xs text-slate-500">
            {saveUi.kind === 'loading' && 'Loading this month from server…'}
            {saveUi.kind === 'saving' && 'Saving to server…'}
            {saveUi.kind === 'saved' && (
              <span className="text-emerald-400/90">Saved to database.</span>
            )}
            {saveUi.kind === 'idle' && !monthSyncError && 'Changes save automatically to Postgres.'}
            {saveUi.kind === 'error' && (
              <span className="text-red-400/90">{saveUi.message}</span>
            )}
          </p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-500">Login</span>
            <input
              type="time"
              className="rounded-xl border border-slate-600 bg-slate-900/90 px-3 py-3 text-lg text-slate-100 focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/30 focus:outline-none"
              value={activeEntry.login ?? ''}
              onChange={(e) => setEntry(activeDateKey, { login: e.target.value || null })}
              onBlur={() => flushNow(activeDateKey)}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-slate-500">Logout</span>
            <input
              type="time"
              className="rounded-xl border border-slate-600 bg-slate-900/90 px-3 py-3 text-lg text-slate-100 focus:border-cyan-500/60 focus:ring-2 focus:ring-cyan-500/30 focus:outline-none"
              value={activeEntry.logout ?? ''}
              onChange={(e) => setEntry(activeDateKey, { logout: e.target.value || null })}
              onBlur={() => flushNow(activeDateKey)}
            />
          </label>
        </div>

        {targetOut && (
          <div className="mt-4 rounded-xl border border-cyan-500/30 bg-cyan-950/30 px-4 py-3">
            <p className="text-xs text-cyan-200/80">Target leave time (login + 8h 30m)</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums text-cyan-100">
              {formatClock(targetOut)}
            </p>
          </div>
        )}

        {activeEntry.login && activeEntry.logout && paid != null && (
          <div className="mt-4 flex items-baseline justify-between border-t border-slate-600/50 pt-4">
            <span className="text-sm text-slate-400">Paid this day (after 0.5h break, max 8h)</span>
            <span className="text-lg font-semibold text-slate-100">
              {formatHours(paid)}
            </span>
          </div>
        )}

        <button
          type="button"
          className="mt-4 w-full rounded-xl border border-slate-500/50 py-2.5 text-sm text-slate-300 hover:border-red-500/50 hover:text-red-200"
          onClick={clearDay}
        >
          Clear this day
        </button>
        {!apiKey && (
          <p className="mt-2 text-center text-xs text-slate-500">Stored in this browser only (no key).</p>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-500">
          Weeks 1–4 (this month)
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2">
          {([1, 2, 3, 4] as const).map((w) => (
            <li
              key={w}
              className="rounded-2xl border border-slate-700/80 bg-slate-800/35 px-4 py-3"
            >
              <div className="text-xs text-slate-500">Week {w}</div>
              <div className="mt-1 text-xl font-semibold text-slate-100">
                {formatHours(weekStats.hours[w])} paid
              </div>
              {state.settings.hourlyRate > 0 && (
                <div className="mt-1 text-sm text-emerald-400/90">
                  {formatMoney(weekStats.pay(weekStats.hours[w]), state.settings.currency)}
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          Week 1: days 1–7 · Week 2: 8–14 · Week 3: 15–21 · Week 4: 22–end
        </p>
      </section>

      {monthRows.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-slate-500">
            Logged days this month
          </h2>
          <ul className="max-h-64 space-y-2 overflow-y-auto rounded-xl border border-slate-700/60 p-2">
            {monthRows.map(({ k, p, w }) => (
              <li key={k}>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-lg px-2 py-2 text-left text-sm hover:bg-slate-800/60"
                  onClick={() => {
                    flushNow(activeDateKey)
                    setActiveDateKey(k)
                  }}
                >
                  <span className="text-slate-300">
                    {parseDateKey(k).toLocaleDateString(undefined, {
                      weekday: 'short',
                      month: 'short',
                      day: 'numeric',
                    })}{' '}
                    <span className="text-slate-500">· W{w}</span>
                  </span>
                  {p != null && (
                    <span className="font-medium text-cyan-200/90">
                      {formatHours(p)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center text-xs text-slate-600">
        PWA: add to home screen. One server: API + this app. Set{' '}
        <code className="text-slate-500">DATABASE_URL</code> and <code className="text-slate-500">DTC_API_KEY</code> on Railway.
      </p>
    </div>
  )
}
