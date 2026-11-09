// Mirror of contracts/escrow settle_math (BigInt yocto).
export function settleMath(deposit, attendees, noShows) {
  const d = BigInt(deposit), a = BigInt(attendees), n = BigInt(noShows);
  const pool = d * n;
  if (a === 0n) return { each: 0n, dust: pool };
  const share = pool / a;
  return { each: d + share, dust: pool - share * a };
}
