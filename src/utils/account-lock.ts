import AsyncLock from "async-lock";

const accountLock = new AsyncLock({
  timeout: 10_000,
  maxPending: 50,
});

export function withAccountLock<T>(
  accountId: string,
  fn: () => Promise<T>
): Promise<T> {
  return accountLock.acquire(`account:${accountId}`, fn);
}
