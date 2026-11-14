// Input checks shared by the web API admin routes. Bodies come from the
// panel (signed), but they're still checked strictly: a panel bug must not
// reach the database as odd data.

/** Brace-wrapped account id, as the game and Mix use ("{...}", 3-66 chars). */
export const isSwid = (v: unknown): v is string => typeof v === "string" && /^\{[0-9A-Za-z-]{1,64}\}$/.test(v);

/** A string of min..max characters (code units), or undefined. */
export function str(v: unknown, min: number, max: number): string | undefined {
  return typeof v === "string" && v.length >= min && v.length <= max ? v : undefined;
}

/** An integer in min..max, or undefined. */
export function int(v: unknown, min: number, max: number): number | undefined {
  return Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : undefined;
}

/** A reason: 1..500 characters after trimming. */
export function reason(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return s.length >= 1 && s.length <= 500 ? s : undefined;
}
