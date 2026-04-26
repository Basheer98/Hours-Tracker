export type DayEntry = {
  /** YYYY-MM-DD */
  dateKey: string
  login: string | null
  logout: string | null
}

export type AppSettings = {
  hourlyRate: number
  currency: string
  /** If set, day entries are loaded/saved via the API (server must use the same DTC_API_KEY) */
  apiKey: string
}

export type AppState = {
  version: 2
  /** Used only when apiKey is empty (offline) */
  entries: Record<string, DayEntry>
  settings: AppSettings
}

const KEY = 'dtc-hours-tracker-v2'
const MIGRATED = 'dtc-hours-tracker-v1'

const defaultSettings: AppSettings = {
  hourlyRate: 0,
  currency: 'USD',
  apiKey: '',
}

function migrateV1ToV2(): AppState | null {
  try {
    const raw = localStorage.getItem(MIGRATED)
    if (!raw) return null
    const p = JSON.parse(raw) as { version?: number; entries?: Record<string, DayEntry>; settings?: AppSettings }
    if (p.version !== 1) return null
    const next: AppState = {
      version: 2,
      entries: p.entries ?? {},
      settings: { ...defaultSettings, ...p.settings, apiKey: '' },
    }
    return next
  } catch {
    return null
  }
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      const fromV1 = migrateV1ToV2()
      if (fromV1) {
        saveState(fromV1)
        return fromV1
      }
      return { version: 2, entries: {}, settings: { ...defaultSettings } }
    }
    const parsed = JSON.parse(raw) as AppState
    if (parsed.version !== 2) {
      return { version: 2, entries: {}, settings: { ...defaultSettings } }
    }
    return {
      version: 2,
      entries: parsed.entries ?? {},
      settings: { ...defaultSettings, ...parsed.settings },
    }
  } catch {
    return { version: 2, entries: {}, settings: { ...defaultSettings } }
  }
}

export function saveState(state: AppState): void {
  if (state.settings.apiKey) {
    const toStore: AppState = {
      version: 2,
      entries: {},
      settings: { ...state.settings },
    }
    localStorage.setItem(KEY, JSON.stringify(toStore))
  } else {
    localStorage.setItem(KEY, JSON.stringify(state))
  }
}

export function getOrCreateEntry(
  entries: Record<string, DayEntry>,
  dateKey: string,
): DayEntry {
  return entries[dateKey] ?? { dateKey, login: null, logout: null }
}
