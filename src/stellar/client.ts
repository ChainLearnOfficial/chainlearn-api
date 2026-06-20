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
  async getAccount(publicKey: string): Promise<StellarSdk.Horizon.AccountResponse> {
    try {
      return await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(this.horizon.loadAccount(publicKey), READ_TIMEOUT_MS)
        )
      );
    } catch (err) {
      logger.error({ err, publicKey }, "Failed to load Stellar account");
      throw new StellarError(`Account ${publicKey} not found or unreachable`);
    }
  }

  /** Check if an account exists on the network. */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.getAccount(publicKey);
      return true;
    } catch {
      return false;
    }
  }

  /** Submit a pre-built transaction envelope to the network. */
  async submitTransaction(
    txEnvelope: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction
  ): Promise<StellarSdk.Horizon.HorizonApi.SubmitTransactionResponse> {
    try {
      const result = await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(this.horizon.submitTransaction(txEnvelope), WRITE_TIMEOUT_MS)
        )
      );
      logger.info({ hash: result.hash }, "Transaction submitted successfully");
      return result;
    } catch (err: any) {
      const extras = err.response?.data?.extras;
      if (extras) {
        logger.error(
          { resultCodes: extras.result_codes, envelope: extras.envelope_xdr },
          "Transaction failed"
        );
      }
      throw new StellarError(
        extras?.result_codes
          ? `Tx failed: ${JSON.stringify(extras.result_codes)}`
          : "Transaction submission failed"
      );
    }
  }

  /** Invoke a Soroban contract function (read-only). */
  async callContract(
    contractId: string,
    method: string,
    ...args: StellarSdk.xdr.ScVal[]
  ): Promise<StellarSdk.rpc.Api.LedgerEntryResult> {
    try {
      return await circuitBreakerExecute(() =>
        stellarRetry.execute(() =>
          withTimeout(
            this.soroban.getContractData(
              contractId,
              StellarSdk.xdr.ScVal.scvSymbol(method)
            ),
            WRITE_TIMEOUT_MS
          )
        )
      );
    } catch (err) {
      logger.error({ err, contractId, method }, "Contract call failed");
      throw new StellarError(`Contract call ${method} failed`);
    }
  }

  /** Get the network passphrase for signing. */
  getPassphrase(): string {
    return this.networkPassphrase;
  }

  /** Get the Soroban RPC server for advanced usage. */
  getSorobanRpc(): StellarSdk.rpc.Server {
    return this.soroban;
  }

  /** Expose Horizon server for health checks. */
  getHorizonServer(): StellarSdk.Horizon.Server {
    return this.horizon;
  }
}

export const stellarClient = new StellarClient();
