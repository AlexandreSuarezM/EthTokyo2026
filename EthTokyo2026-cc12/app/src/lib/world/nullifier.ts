/** Canonical decimal form of a 256-bit nullifier given as bigint, decimal or 0x-hex. */
export function normalizeNullifier(value: string | bigint): string {
  let n: bigint;
  if (typeof value === "bigint") n = value;
  else if (/^0x[0-9a-fA-F]{1,64}$/.test(value)) n = BigInt(value);
  else if (/^[0-9]{1,78}$/.test(value)) n = BigInt(value);
  else throw new TypeError("nullifier must be a decimal or 0x-hex string");
  if (n < 0n || n >= 1n << 256n) throw new RangeError("nullifier out of 256-bit range");
  return n.toString(10);
}
