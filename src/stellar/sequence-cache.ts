import { stellarClient } from "./client.js";

export class SequenceCache {
  private localSeq: Map<string, bigint> = new Map();

  async getNextSequence(accountId: string): Promise<string> {
    // 1. Check local in-memory cache first
    const local = this.localSeq.get(accountId);
    if (local !== undefined) {
      const next = local + 1n;
      this.localSeq.set(accountId, next);
      return next.toString();
    }

    // 2. Load from Horizon
    const account = await stellarClient.getAccount(accountId);
    const seq = BigInt(account.sequence);
    this.localSeq.set(accountId, seq);
    return seq.toString();
  }

  invalidate(accountId: string): void {
    this.localSeq.delete(accountId);
  }

  resetTo(accountId: string, seq: bigint): void {
    this.localSeq.set(accountId, seq);
  }
}

export const sequenceCache = new SequenceCache();
