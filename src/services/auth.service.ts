import { createHash, randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt (memory-hard, built into Node: no native dependency). Parameters are stored with the hash.
const PARAMS = { N: 16_384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function derive(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, keyLength, { ...options, maxmem: MAX_MEMORY }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Format: scrypt$N$r$p$salt(base64)$key(base64) */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, KEY_LENGTH, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, key] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;
/** Spends the same time as a real check when the e-mail does not exist (no user enumeration by timing). */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}
