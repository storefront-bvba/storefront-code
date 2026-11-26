import { elapsedShare, type LimitPoolMember, type LimitPoolWindow } from "./usageLimits.ts";

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/** One account's part of a pooled meter, in percent of the whole meter. */
export interface PoolMeterPiece {
  readonly member: LimitPoolMember;
  /** The account's column number, shared with its legend row and its column in other windows. */
  readonly index: number;
  readonly start: number;
  readonly width: number;
}

export interface PoolMeter {
  readonly pieces: readonly PoolMeterPiece[];
  /** What each account's next reset restores, placed right after the fill. */
  readonly refills: readonly PoolMeterPiece[];
  /** Where the fill would stand if every account had spent at even pace. */
  readonly paceMark: number | null;
}

/**
 * Lays a pool window out as one meter: each account adds what it has left times its share of the
 * pool's capacity, so the fill ends at the pool's remaining percentage.
 */
export function poolMeter(window: LimitPoolWindow, now: number): PoolMeter {
  const withReset = new Set(window.resets.map((reset) => reset.member));
  const share = (member: LimitPoolMember) => window.shares.get(member.account.key) ?? 0;
  const pieces: PoolMeterPiece[] = [];
  let end = 0;
  window.columns.forEach((column, position) => {
    if (!column.window) return;
    const member = column as LimitPoolMember;
    const width = share(member) * (100 - clampPercent(member.window.usedPercent));
    pieces.push({ member, index: position + 1, start: end, width });
    end += width;
  });
  const refills: PoolMeterPiece[] = [];
  for (const piece of pieces) {
    const { member } = piece;
    if (!withReset.has(member)) continue;
    const used = clampPercent(member.window.usedPercent);
    const width = share(member) * Math.min(used, clampPercent(member.refillPercent));
    if (width <= 0) continue;
    refills.push({ ...piece, start: end, width });
    end += width;
  }
  const elapsed = pieces.map((piece) => elapsedShare(piece.member.window, now));
  const paceMark = elapsed.every((value) => value !== null)
    ? pieces.reduce((sum, piece, index) => sum + share(piece.member) * (1 - elapsed[index]!), 0) *
      100
    : null;
  return { pieces, refills, paceMark: pieces.length > 0 ? paceMark : null };
}
