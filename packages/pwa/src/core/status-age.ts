import { msg } from '../i18n.svelte';

// How long a workspace has held its current status, compact enough for a phone row.
// `since` is the agent's clock and `now` the phone's, so a skewed future stamp reads as fresh.
export function statusAge(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000);
  if (minutes < 1) return msg().status.age.underMinute;
  if (minutes < 60) return msg().status.age.minutes(minutes);
  if (minutes < 1440) return msg().status.age.hours(Math.floor(minutes / 60));
  return msg().status.age.days(Math.floor(minutes / 1440));
}
