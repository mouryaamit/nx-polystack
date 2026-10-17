/**
 * Build time formatting without a date library. Tokens: YYYY, MMM (Jan), MM, DD, HH (00–23),
 * hh (01–12), mm, ss, A (AM/PM), z (short zone name, or `label`); `[text]` is literal text.
 * Other characters are kept.
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function formatStamp(date: Date, timezone: string, format: string, label?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const pad = (v: string | number) => String(v).padStart(2, '0');
  const hour = Number(parts['hour']) % 24;
  const values: Record<string, string> = {
    YYYY: parts['year'],
    MMM: MONTHS[Number(parts['month']) - 1],
    MM: pad(parts['month']),
    DD: pad(parts['day']),
    HH: pad(hour),
    hh: pad(hour % 12 === 0 ? 12 : hour % 12),
    mm: pad(parts['minute']),
    ss: pad(parts['second']),
    A: hour < 12 ? 'AM' : 'PM',
    z: label ?? parts['timeZoneName'] ?? timezone,
  };
  // `[text]` is kept as is (e.g. `[at] HH:mm`).
  return format.replace(/\[([^\]]*)\]|YYYY|MMM|MM|DD|HH|hh|mm|ss|A|z/g, (t, lit?: string) =>
    lit !== undefined ? lit : values[t],
  );
}
