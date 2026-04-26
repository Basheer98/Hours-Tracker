import type { DayEntry } from './storage'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const base = () => (import.meta.env.VITE_API_BASE as string | undefined) ?? ''

function authHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` }
}

export async function fetchEntriesRange(
  from: string,
  to: string,
  apiKey: string,
): Promise<Record<string, DayEntry>> {
  const q = new URLSearchParams({ from, to })
  const r = await fetch(`${base()}/api/entries?${q}`, {
    headers: authHeaders(apiKey),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new ApiError(t || r.statusText, r.status)
  }
  const rows = (await r.json()) as {
    workDate: string
    login: string | null
    logout: string | null
  }[]
  const out: Record<string, DayEntry> = {}
  for (const row of rows) {
    out[row.workDate] = {
      dateKey: row.workDate,
      login: row.login,
      logout: row.logout,
    }
  }
  return out
}

export async function saveEntry(
  dateKey: string,
  entry: { login: string | null; logout: string | null },
  apiKey: string,
): Promise<DayEntry> {
  const r = await fetch(`${base()}/api/entries/${encodeURIComponent(dateKey)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify({ login: entry.login, logout: entry.logout }),
  })
  if (!r.ok) {
    const t = await r.text()
    throw new ApiError(t || r.statusText, r.status)
  }
  const row = (await r.json()) as {
    workDate: string
    login: string | null
    logout: string | null
  }
  return {
    dateKey: row.workDate,
    login: row.login,
    logout: row.logout,
  }
}

export async function deleteEntry(dateKey: string, apiKey: string): Promise<void> {
  const r = await fetch(`${base()}/api/entries/${encodeURIComponent(dateKey)}`, {
    method: 'DELETE',
    headers: authHeaders(apiKey),
  })
  if (r.status === 204) return
  if (!r.ok) {
    const t = await r.text()
    throw new ApiError(t || r.statusText, r.status)
  }
}
