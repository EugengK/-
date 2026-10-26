// Dates of a fixed cost (고정 지출). All dates are calendar dates "YYYY-MM-DD" (no time zone involved).

export type RuleKind = "monthly_day" | "monthly_weekday" | "weekly" | "fortnightly";

export interface Rule {
  rule: RuleKind;
  day_of_month?: number | null; // monthly_day; 31 means "last day of the month"
  nth?: number | null; // monthly_weekday; 1-4, 5 = last
  weekday?: number | null; // 0 = Sunday … 6 = Saturday
  anchor_date?: string | null; // fortnightly: one known payment date
  start_date: string;
  end_date?: string | null;
}

const toUTC = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUTC = (t: number) => new Date(t).toISOString().slice(0, 10);
const DAY = 86_400_000;

export function addDays(d: string, n: number): string {
  return fromUTC(toUTC(d) + n * DAY);
}

function lastDayOfMonth(d: string): number {
  return new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
}

export function matches(r: Rule, d: string): boolean {
  const dom = +d.slice(8, 10);
  const wd = new Date(toUTC(d)).getUTCDay();
  switch (r.rule) {
    case "monthly_day":
      return dom === Math.min(r.day_of_month ?? 1, lastDayOfMonth(d));
    case "monthly_weekday":
      if (wd !== r.weekday) return false;
      return r.nth === 5 ? dom + 7 > lastDayOfMonth(d) : Math.ceil(dom / 7) === r.nth;
    case "weekly":
      return wd === r.weekday;
    case "fortnightly": {
      const diff = Math.round((toUTC(d) - toUTC(r.anchor_date ?? r.start_date)) / DAY);
      return ((diff % 14) + 14) % 14 === 0;
    }
  }
}

/** Payment dates of `r` between from and to (inclusive), within the rule's own start/end. */
export function occurrences(r: Rule, from: string, to: string): string[] {
  const start = from > r.start_date ? from : r.start_date;
  const end = r.end_date && r.end_date < to ? r.end_date : to;
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) if (matches(r, d)) out.push(d);
  return out;
}

/** How many times `weekday` falls in the month of date d (4 or 5). */
export function weekdaysInMonth(d: string, weekday: number): number {
  const first = `${d.slice(0, 8)}01`;
  const firstWd = new Date(toUTC(first)).getUTCDay();
  const firstHit = 1 + ((weekday - firstWd + 7) % 7);
  return Math.floor((lastDayOfMonth(d) - firstHit) / 7) + 1;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** Korean description, e.g. "매월 첫째 주 일요일". */
export function describeRule(r: Rule): string {
  const wd = r.weekday != null ? `${WEEKDAYS[r.weekday]}요일` : "";
  switch (r.rule) {
    case "monthly_day":
      return r.day_of_month === 31 ? "매월 말일" : `매월 ${r.day_of_month}일`;
    case "monthly_weekday":
      return `매월 ${["", "첫째", "둘째", "셋째", "넷째", "마지막"][r.nth ?? 1]} 주 ${wd}`;
    case "weekly":
      return `매주 ${wd}`;
    case "fortnightly":
      return `2주마다 (${r.anchor_date} 기준)`;
  }
}
