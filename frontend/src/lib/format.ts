/** "98.7%" — one decimal below 99.5%, none above, so 99.7% does not round up to a claim of perfection. */
export function pct(ratio: number | null | undefined): string {
  if (ratio == null) return '—';
  const p = ratio * 100;
  return `${p >= 99.95 ? p.toFixed(0) : p >= 10 ? p.toFixed(1).replace(/\.0$/, '') : p.toFixed(1)}%`;
}

/** How long ago, the way a worklist says it: "just now", "5m", "3h", "2d". */
export function ago(iso: string, now: number = Date.now()): string {
  const m = Math.floor((now - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** Minutes as people say them: "6.8 min", "42 min", "5.2 h". */
export function duration(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  if (minutes < 1) return '<1 min';
  if (minutes < 10) return `${minutes.toFixed(1).replace(/\.0$/, '')} min`;
  if (minutes < 120) return `${Math.round(minutes)} min`;
  const h = minutes / 60;
  return `${h < 100 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h)} h`;
}
