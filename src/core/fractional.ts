/**
 * Fractional order keys (PRD Section 3, "built for collaboration").
 *
 * A key is a base-36 string read as a fraction between 0 and 1 ("i" ≈ 0.5).
 * A new key can always be made between any two keys, so two people inserting
 * or reordering at the same time never need to renumber anything, and plain
 * string comparison (a < b) gives the order. Keys never end in "0", which
 * keeps every key distinct and every gap splittable.
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;
const VALID = /^[0-9a-z]*[1-9a-z]$/;

const digit = (c: string): number => {
  const d = DIGITS.indexOf(c);
  if (d < 0) throw new Error(`Invalid order key character "${c}"`);
  return d;
};

export function isOrderKey(k: unknown): k is string {
  return typeof k === 'string' && k.length <= 1024 && VALID.test(k);
}

/** Midpoint of fractions a (may be '' for 0) and b (null for 1). Requires a < b. */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]) : 0;
  const db = b !== null ? digit(b[0]) : BASE;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)];
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[da] + midpoint(a.slice(1), null);
}

/**
 * The shortest key just above a, made by bumping one digit. Appending is the
 * most common insert (new items go to the end), and stepping by one digit
 * grows keys about seven times more slowly than halving the gap to 1.
 */
function after(a: string): string {
  for (let len = 1; ; len++) {
    const head = a.slice(0, len).padEnd(len, '0');
    const last = digit(head[len - 1]);
    if (last < BASE - 1) {
      const cand = head.slice(0, -1) + DIGITS[last + 1];
      if (cand > a) return cand;
    }
  }
}

/** A key strictly between a and b; null means "no bound" (start or end of the list). */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && !isOrderKey(a)) throw new Error(`Invalid order key "${a}"`);
  if (b !== null && !isOrderKey(b)) throw new Error(`Invalid order key "${b}"`);
  if (a !== null && b !== null && a >= b) throw new Error(`Order keys out of order: "${a}" >= "${b}"`);
  if (a !== null && b === null) return after(a);
  return midpoint(a ?? '', b);
}

/** n evenly spaced keys for a fresh list: short keys, plenty of room between them. */
export function spreadKeys(n: number): string[] {
  if (n <= 0) return [];
  let len = 1;
  while (BASE ** len < (n + 1) * 4) len++;
  const span = BASE ** len;
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    const v = Math.floor((i * span) / (n + 1));
    out.push(v.toString(36).padStart(len, '0').replace(/0+$/, ''));
  }
  return out;
}
