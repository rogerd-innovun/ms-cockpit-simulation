import { describe, expect, it } from 'vitest';
import { ago, duration, pct } from './format';

describe('pct', () => {
  it('shows a missing figure as a dash, not 0%', () => {
    expect(pct(null)).toBe('—');
    expect(pct(undefined)).toBe('—');
  });
  it('keeps a decimal where it matters and never rounds 99.7% up to 100%', () => {
    expect(pct(0)).toBe('0.0%');
    expect(pct(0.5)).toBe('50%');
    expect(pct(0.8333)).toBe('83.3%');
    expect(pct(0.9971)).toBe('99.7%');
    expect(pct(0.9999)).toBe('100%');
    expect(pct(1)).toBe('100%');
  });
});

describe('ago', () => {
  const now = new Date('2026-10-04T12:00:00Z').getTime();
  const at = (minutes: number) => new Date(now - minutes * 60000).toISOString();
  it('says it the way a worklist does', () => {
    expect(ago(at(0), now)).toBe('just now');
    expect(ago(at(5), now)).toBe('5m');
    expect(ago(at(59), now)).toBe('59m');
    expect(ago(at(180), now)).toBe('3h');
    expect(ago(at(60 * 49), now)).toBe('2d');
  });
});

describe('duration', () => {
  it('reads like a person would say it', () => {
    expect(duration(null)).toBe('—');
    expect(duration(0.4)).toBe('<1 min');
    expect(duration(6.8)).toBe('6.8 min');
    expect(duration(5)).toBe('5 min');
    expect(duration(41)).toBe('41 min');
    expect(duration(120)).toBe('2 h');
    expect(duration(310)).toBe('5.2 h');
  });
});
