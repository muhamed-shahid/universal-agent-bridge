import { randomBytes as nodeRandomBytes } from 'node:crypto';

/** Crockford base32 (no I, L, O, U): readable, unambiguous when typed or read aloud. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export type RandomBytes = (size: number) => Buffer;

/** Random identifier `<prefix><length Crockford chars>`, 5 bits of entropy per character. */
export function randomId(
  prefix: string,
  length: number,
  random: RandomBytes = nodeRandomBytes,
): string {
  const bytes = random(length);
  let out = prefix;
  for (let i = 0; i < length; i++) {
    out += CROCKFORD.charAt((bytes[i] ?? 0) & 31);
  }
  return out;
}

export const crockfordPattern = (length: number): string => `[0-9A-HJKMNP-TV-Z]{${String(length)}}`;
