/**
 * alcantara#207: which addresses the backend may connect to on behalf of a
 * URL someone else supplied. Unsafe: unspecified, loopback, private (RFC
 * 1918, ULA), carrier-grade NAT, link-local (including the 169.254.169.254
 * cloud metadata address), multicast and reserved, documentation and
 * benchmarking ranges, and IPv4 embedded in IPv4-mapped or NAT64 IPv6.
 * Anything that does not parse as an address is unsafe. Shared by the
 * external-source pull URL check and the outbound fetch policy.
 */
export function unsafeAddress(address: string): boolean {
  if (address.includes(':')) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('64:ff9b::')) {
      const tail = normalized.slice('64:ff9b::'.length);
      if (tail.includes('.')) return unsafeAddress(tail);
      const words = tail.split(':').map((word) => Number.parseInt(word, 16));
      if (words.length === 2 && words.every((word) => Number.isInteger(word)))
        return unsafeAddress(
          `${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`,
        );
      return true;
    }
    if (normalized.startsWith('::ffff:')) {
      const tail = normalized.slice('::ffff:'.length);
      if (tail.includes('.')) return unsafeAddress(tail);
      const words = tail.split(':').map((word) => Number.parseInt(word, 16));
      if (words.length === 2 && words.every((word) => Number.isInteger(word))) {
        return unsafeAddress(
          `${words[0] >> 8}.${words[0] & 255}.${words[1] >> 8}.${words[1] & 255}`,
        );
      }
      return true;
    }
    return (
      normalized === '::' ||
      normalized === '::1' ||
      /^fe[89ab]/.test(normalized) ||
      /^::[\d.]+$/.test(normalized) ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('100:') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('2001:10:') ||
      normalized.startsWith('2001:2:')
    );
  }
  const parts = address.split('.').map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return true;
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
