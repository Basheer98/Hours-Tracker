const PAID_HOURS_CAP = 8
const BREAK_HOURS = 0.5
/** Total on-site span for a full shift (paid + break) */
export const SHIFT_SPAN_HOURS = PAID_HOURS_CAP + BREAK_HOURS

export function parseTimeOnDate(dateKey: string, time: string): Date {
  const [h, m] = time.split(':').map((x) => Number(x))
  const [y, mo, d] = dateKey.split('-').map(Number)
  return new Date(y, mo - 1, d, h, m, 0, 0)
}

export function formatClock(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

export function formatShortTime(d: Date): string {
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** Target logout = login + 8.5h (8h paid + 0.5h break). */
export function targetLogout(login: Date): Date {
  return new Date(login.getTime() + SHIFT_SPAN_HOURS * 60 * 60 * 1000)
}

/**
 * Paid hours for the day: elapsed time minus one 0.5h break, capped at 8h.
 * If logout is before login (night shift edge), logout is treated as next day.
 */
export function paidHoursForDay(dateKey: string, loginTime: string, logoutTime: string): number {
  const login = parseTimeOnDate(dateKey, loginTime)
  let logout = parseTimeOnDate(dateKey, logoutTime)
  if (logout.getTime() <= login.getTime()) {
    logout = new Date(logout.getTime() + 24 * 60 * 60 * 1000)
  }
  const elapsedH = (logout.getTime() - login.getTime()) / (60 * 60 * 1000)
  const raw = Math.max(0, elapsedH - BREAK_HOURS)
  return Math.min(PAID_HOURS_CAP, raw)
}
