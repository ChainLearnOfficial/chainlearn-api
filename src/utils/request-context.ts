import { AsyncLocalStorage } from "node:async_hooks";

const requestContext = new AsyncLocalStorage<{ requestId: string }>();

export function runWithRequestContext(
  requestId: string,
  callback: () => void,
): void {
  requestContext.run({ requestId }, callback);
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
