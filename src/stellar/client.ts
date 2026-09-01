import * as StellarSdk from "@stellar/stellar-sdk";
import {
  getHorizonServer,
  getSorobanServer,
  getNetworkPassphrase,
} from "../config/stellar.js";
import { logger } from "../utils/logger.js";
import { StellarError } from "../utils/errors.js";
import {
  stellarRetry,
  circuitBreakerExecute,
  withTimeout,
} from "./resilience.js";
import { getRequestId } from "../utils/request-context.js";

const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;

/**
 * Core Stellar client wrapping Horizon + Soroban RPC interactions.
 * All external calls are protected by circuit breaker, retry, and timeout.
 */
export class StellarClient {
  private horizon: StellarSdk.Horizon.Server;
  private soroban: StellarSdk.rpc.Server;
  private networkPassphrase: string;

  constructor() {
    this.horizon = getHorizonServer();
    this.soroban = getSorobanServer();
    this.networkPassphrase = getNetworkPassphrase();
  }

  /** Load account record from Horizon. */
  async getAccount(
    publicKey: string,
  ): Promise<StellarSdk.Horizon.AccountResponse> {
    logger.debug({ requestId: getRequestId(), publicKey }, "Loading Stellar account");
    try {
      return await circuitBreakerExecute(
        () =>
          stellarRetry.execute(() =>
            withTimeout(this.horizon.loadAccount(publicKey), READ_TIMEOUT_MS)
          ),
        "read"
      );
    } catch (err) {
      logger.error({ err, publicKey }, "Failed to load Stellar account");
      throw new StellarError(`Account ${publicKey} not found or unreachable`);
    }
  }

  /** Submit a pre-built transaction envelope to the network. */
  async submitTransaction(
    txEnvelope: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction,
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    const requestId = getRequestId();
    logger.debug({ requestId }, "Submitting Stellar transaction");
    try {
      const result = await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(
            this.horizon.submitTransaction(txEnvelope),
            WRITE_TIMEOUT_MS,
          ),
        ),
      );
      logger.info({ requestId, hash: result.hash }, "Transaction submitted successfully");
      return result;
    } catch (err: any) {
      const extras = err.response?.data?.extras;
      if (extras) {
        logger.error(
          { resultCodes: extras.result_codes, envelope: extras.envelope_xdr },
          "Transaction failed",
        );
      }
      throw new StellarError(
        extras?.result_codes
          ? `Tx failed: ${JSON.stringify(extras.result_codes)}`
          : "Transaction submission failed",
      );
    }
  }

  /**
   * Execute a read-only Soroban contract call via simulateTransaction.
   * Uses READ_TIMEOUT_MS — write timeout is inappropriate for reads.
   */
  async callContract(
    tx: StellarSdk.Transaction,
  ): Promise<StellarSdk.rpc.Api.SimulateTransactionResponse> {
    logger.debug({ requestId: getRequestId() }, "Simulating Stellar contract call");
    try {
      return await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(this.soroban.simulateTransaction(tx), READ_TIMEOUT_MS),
        ),
      );
    } catch (err) {
      logger.error({ err }, "Soroban contract call failed");
      throw new StellarError("Contract call failed");
    }
  }

  /**
   * Check whether a Stellar account exists on the network.
   * Returns false ONLY for genuine 404 (account not found). Any other error
   * (network timeout, Horizon outage, etc.) is rethrown so callers are not
   * silently misled into treating an unreachable network as a missing account.
   */
  async accountExists(publicKey: string): Promise<boolean> {
    logger.debug({ requestId: getRequestId(), publicKey }, "Checking Stellar account");
    try {
      await circuitBreakerExecute(
        () =>
          stellarRetry.execute(() =>
            withTimeout(this.horizon.loadAccount(publicKey), READ_TIMEOUT_MS)
          ),
        "read"
      );
      return true;
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 404) return false;
      logger.error({ err, publicKey }, "accountExists check failed");
      throw new StellarError(
        `Could not verify account ${publicKey}: ${err?.message ?? err}`,
      );
    }
  }

  /** Expose Horizon server for health checks. */
  getHorizonServer(): StellarSdk.Horizon.Server {
    return this.horizon;
  }

  /**
   * Check whether a submitted Soroban transaction succeeded on-chain.
   * Uses the Soroban RPC endpoint (getTransaction) rather than Horizon so
   * that Soroban-specific result data is available. Returns a simplified
   * status: "SUCCESS", "FAILED", or "NOT_FOUND".
   * Used by the pending-reward reconciliation job (#207).
   */
  async getTransaction(txHash: string): Promise<{ status: "SUCCESS" | "FAILED" | "NOT_FOUND" }> {
    logger.debug({ requestId: getRequestId(), txHash }, "Fetching Stellar transaction");
    try {
      const result = await withTimeout(
        this.soroban.getTransaction(txHash),
        READ_TIMEOUT_MS,
      );
      if (result.status === StellarSdk.rpc.Api.GetTransactionStatus.SUCCESS) {
        return { status: "SUCCESS" };
      }
      return { status: "FAILED" };
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 404) return { status: "NOT_FOUND" };
      logger.error({ err, txHash }, "getTransaction failed");
      throw new StellarError(`Could not fetch transaction ${txHash}`);
    }
  }

  /**
   * Look up a submitted transaction on Horizon and report its on-chain
   * verification status. Used by GET /api/v1/rewards/transactions so users
   * can verify their reward transactions rather than trusting the stored
   * tx hash alone.
   *
   * Ledger lookup (for confirmation count) is best-effort — if it fails the
   * transaction's own confirmed/failed status is still returned with
   * confirmations left null, rather than failing the whole verification.
   */
  async getHorizonTransaction(txHash: string): Promise<{
    status: "confirmed" | "pending" | "failed";
    ledger: number | null;
    confirmations: number | null;
  }> {
    logger.debug({ requestId: getRequestId(), txHash }, "Verifying Stellar transaction on Horizon");
    let tx: StellarSdk.Horizon.ServerApi.TransactionRecord;
    try {
      tx = await circuitBreakerExecute(
        () =>
          stellarRetry.execute(() =>
            withTimeout(this.horizon.transactions().transaction(txHash).call(), READ_TIMEOUT_MS)
          ),
        "read"
      );
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      if (status === 404) {
        return { status: "pending", ledger: null, confirmations: null };
      }
      logger.warn({ err, txHash }, "Horizon transaction lookup failed — reporting pending");
      return { status: "pending", ledger: null, confirmations: null };
    }

    if (!tx.successful) {
      return { status: "failed", ledger: tx.ledger, confirmations: null };
    }

    let confirmations: number | null = null;
    try {
      const latestLedgers = await withTimeout(
        this.horizon.ledgers().order("desc").limit(1).call(),
        READ_TIMEOUT_MS
      );
      const latestSequence = latestLedgers.records[0]?.sequence;
      if (typeof latestSequence === "number") {
        confirmations = Math.max(latestSequence - tx.ledger + 1, 0);
      }
    } catch (err) {
      logger.warn({ err, txHash }, "Failed to fetch latest ledger for confirmation count");
    }

    return { status: "confirmed", ledger: tx.ledger, confirmations };
  }

  /** Check Soroban RPC health by calling getLatestLedger. */
  async checkSorobanHealth(): Promise<void> {
    try {
      // Use a shorter timeout for health checks (3s) to fail fast if RPC is unreachable
      await withTimeout(this.soroban.getLatestLedger(), 3_000);
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.warn({ message }, "Soroban RPC health check failed");
      throw err;
    }
  }
}

export const stellarClient = new StellarClient();
