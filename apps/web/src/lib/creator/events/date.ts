/** Format a Date as a `datetime-local` input value in the user's LOCAL time
 *  (YYYY-MM-DDTHH:mm). `toISOString()` would shift to UTC and mis-set the
 *  picker, so we build the string from the local field getters. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** `datetime-local` value for `now + offsetMinutes`, local time. */
export function localInputFromNow(offsetMinutes: number): string {
  return toLocalInput(new Date(Date.now() + offsetMinutes * 60_000));
}
