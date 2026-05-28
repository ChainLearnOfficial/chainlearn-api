import * as StellarSdk from "@stellar/stellar-sdk";
import {
  getHorizonServer,
  getSorobanServer,
  getNetworkPassphrase,
  getPlatformKeypair,
} from "../config/stellar.js";
import { logger } from "../utils/logger.js";
import { StellarError } from "../utils/errors.js";

/**
 * Core Stellar client wrapping Horizon + Soroban RPC interactions.
 */
export class StellarClient {
  private horizon: StellarSdk.Horizon.Server;
  private soroban: StellarSdk.SorobanRpc.Server;
  private networkPassphrase: string;

  constructor() {
    this.horizon = getHorizonServer();
    this.soroban = getSorobanServer();
    this.networkPassphrase = getNetworkPassphrase();
  }

  /** Load account record from Horizon. */
  async getAccount(publicKey: string): Promise<StellarSdk.Horizon.AccountResponse> {
    try {
      return await this.horizon.loadAccount(publicKey);
    } catch (err) {
      logger.error({ err, publicKey }, "Failed to load Stellar account");
      throw new StellarError(`Account ${publicKey} not found or unreachable`);
    }
  }

  /** Check if an account exists on the network. */
  async accountExists(publicKey: string): Promise<boolean> {
    try {
      await this.horizon.loadAccount(publicKey);
      return true;
    } catch {
      return false;
    }
  }

  /** Submit a pre-built transaction envelope to the network. */
  async submitTransaction(
    txEnvelope: StellarSdk.Transaction | StellarSdk.FeeBumpTransaction
  ): Promise<StellarSdk.Horizon.SubmitTransactionResponse> {
    try {
      const result = await this.horizon.submitTransaction(txEnvelope);
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
  ): Promise<StellarSdk.xdr.ScVal> {
    try {
      const contract = new StellarSdk.Contract(contractId);
      const result = await this.soroban.getContractData(
        contractId,
        StellarSdk.xdr.ScVal.scvSymbol(method)
      );
      return result;
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
  getSorobanRpc(): StellarSdk.SorobanRpc.Server {
    return this.soroban;
  }
}

export const stellarClient = new StellarClient();
