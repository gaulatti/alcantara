import { isIPv4, isIPv6 } from 'node:net';

/**
 * Parses any spelling of an IPv6 address (expanded, zero-padded, mixed case,
 * dotted-quad tail, zone id) into its eight 16-bit words; undefined when the
 * input is not an IPv6 address.
 */
function ipv6Words(address: string): number[] | undefined {
  if (!isIPv6(address)) return undefined;
  const zoneAt = address.indexOf('%');
  const bare = (zoneAt < 0 ? address : address.slice(0, zoneAt))
    .toLowerCase()
    .replace(
      /(\d+)\.(\d+)\.(\d+)\.(\d+)$/,
      (_, a, b, c, d) =>
        `${((+a << 8) | +b).toString(16)}:${((+c << 8) | +d).toString(16)}`,
    );
  const groups = (text: string) =>
    text === ''
      ? []
      : text.split(':').map((group) => Number.parseInt(group, 16));
  const halves = bare.split('::');
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const gap = halves.length === 2 ? 8 - head.length - tail.length : 0;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

/**
 * alcantara#207: which addresses the backend may connect to on behalf of a
 * URL someone else supplied. Unsafe: unspecified, loopback, private (RFC
 * 1918, ULA), carrier-grade NAT, link-local (including the 169.254.169.254
 * cloud metadata address), multicast and reserved, documentation and
 * benchmarking ranges, 6to4 (2002::/16), Teredo (2001::/32) and
 * site-local (fec0::/10) IPv6, and IPv4 embedded in IPv4-mapped or NAT64 IPv6.
 * Anything that does not parse as an address is unsafe. Shared by the
 * external-source pull URL check and the outbound fetch policy.
 */
export function unsafeAddress(address: string): boolean {
  if (address.includes(':')) {
    const words = ipv6Words(address);
    if (!words) return true;
    const [w0, w1, , , , w5, w6, w7] = words;
    if (
      (w0 === 0x64 &&
        w1 === 0xff9b &&
        words.slice(2, 6).every((w) => w === 0)) ||
      (words.slice(0, 5).every((w) => w === 0) && w5 === 0xffff)
    )
      return unsafeAddress(`${w6 >> 8}.${w6 & 255}.${w7 >> 8}.${w7 & 255}`);
    return (
      w0 >> 8 === 0 ||
      (w0 & 0xffc0) === 0xfe80 ||
      (w0 & 0xffc0) === 0xfec0 ||
      (w0 & 0xfe00) === 0xfc00 ||
      (w0 & 0xff00) === 0xff00 ||
      w0 === 0x100 ||
      w0 === 0x2002 ||
      (w0 === 0x2001 && (w1 === 0 || w1 === 0xdb8 || w1 === 0x10 || w1 === 2))
    );
  }
  if (!isIPv4(address)) return true;
  const parts = address.split('.').map(Number);
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && parts[2] === 113)
  );
}
