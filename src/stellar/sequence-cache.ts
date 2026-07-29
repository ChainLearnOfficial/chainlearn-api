import { redis } from "../config/redis.js";
import { stellarClient } from "./client.js";

const KEY_PREFIX = "chainlearn:stellar:sequence:";
// Bounds how long a cached sequence can be trusted before we re-sync with
// Horizon, so sequence changes made outside this cache (e.g. by another
// tool, or a deploy that bypassed the queue) can't strand the cache forever.
const TTL_SECONDS = 300;

// Atomically increments the cached "next sequence" value and refreshes its
// TTL, but only if the key already exists. Returns nil when the key is
// missing so the caller knows it needs to seed the cache from Horizon.
const INCREMENT_SCRIPT = `
  if redis.call('EXISTS', KEYS[1]) == 1 then
    local val = redis.call('INCR', KEYS[1])
    redis.call('EXPIRE', KEYS[1], ARGV[1])
    return val
  end
  return false
`;

// Seeds the cache with the sequence number loaded from Horizon, unless
// another process already seeded it first (NX), in which case we fall back
// to incrementing the value that process wrote. This keeps the cache shared
// and monotonic across multiple instances of the service.
const SEED_AND_INCREMENT_SCRIPT = `
  local ok = redis.call('SET', KEYS[1], ARGV[2], 'NX', 'EX', ARGV[1])
  if ok then
    return ARGV[2]
  end
  local val = redis.call('INCR', KEYS[1])
  redis.call('EXPIRE', KEYS[1], ARGV[1])
  return val
`;

export class SequenceCache {
  private key(accountId: string): string {
    return `${KEY_PREFIX}${accountId}`;
  }

  async getNextSequence(accountId: string): Promise<string> {
    const key = this.key(accountId);

    const incremented = (await redis.eval(INCREMENT_SCRIPT, 1, key, TTL_SECONDS)) as
      | string
      | number
      | null
      | false;
    if (incremented !== null && incremented !== false) {
      return incremented.toString();
    }

    // Cache miss (never seeded, expired, or invalidated) — load the
    // authoritative sequence from Horizon and seed the shared cache.
    // We seed with the *current* sequence (N) so that callers pass it
    // directly to `new Account(publicKey, N)`.  TransactionBuilder
    // internally adds 1, producing a transaction with sequence N+1.
    // Seeding with N+1 (the old behaviour) caused Account(N+1) →
    // TransactionBuilder → sequence N+2, which is off by one — #206.
    const account = await stellarClient.getAccount(accountId);
    const seq = BigInt(account.sequence);

    const result = (await redis.eval(
      SEED_AND_INCREMENT_SCRIPT,
      1,
      key,
      TTL_SECONDS,
      seq.toString()
    )) as string | number;
    return result.toString();
  }

  async invalidate(accountId: string): Promise<void> {
    await redis.del(this.key(accountId));
  }

  async resetTo(accountId: string, seq: bigint): Promise<void> {
    await redis.set(this.key(accountId), seq.toString(), "EX", TTL_SECONDS);
  }
}

export const sequenceCache = new SequenceCache();
