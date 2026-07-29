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
    try {
      return await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(
            this.horizon.loadAccount(publicKey),
            READ_TIMEOUT_MS,
            "read",
          ),
        ),
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
    try {
      const result = await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(
            this.horizon.submitTransaction(txEnvelope),
            WRITE_TIMEOUT_MS,
            "write",
          ),
        ),
      );
      logger.info({ hash: result.hash }, "Transaction submitted successfully");
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
    try {
      return await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(
            this.soroban.simulateTransaction(tx),
            READ_TIMEOUT_MS,
            "read",
          ),
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
    try {
      await this.horizon.loadAccount(publicKey);
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

  /** Check Soroban RPC health by calling getLatestLedger. */
  async checkSorobanHealth(): Promise<void> {
    try {
      // Use a shorter timeout for health checks (3s) to fail fast if RPC is unreachable
      await withTimeout(this.soroban.getLatestLedger(), 3_000, "read");
    } catch (err: any) {
      const message = err?.message || String(err);
      logger.warn({ message }, "Soroban RPC health check failed");
      throw err;
    }
  }
}

export const stellarClient = new StellarClient();
