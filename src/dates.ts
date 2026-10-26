/** Today's date in Hobart (the church's calendar), as YYYY-MM-DD. */
export function todayInHobart(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Hobart", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
