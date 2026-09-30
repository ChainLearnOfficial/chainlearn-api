import * as StellarSdk from "@stellar/stellar-sdk";
import {
  getPlatformKeypair,
  getNetworkPassphrase,
  getSorobanServer,
} from "../config/stellar.js";
import { stellarClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { StellarError, StellarClientError } from "../utils/errors.js";
import { toStellarClientError } from "./errors.js";
import { getRequestId } from "../utils/request-context.js";

import { sequenceCache } from "./sequence-cache.js";
import { withAccountLock } from "../utils/account-lock.js";

const MAX_SEQ_RETRIES = 3;

/**
 * Detects if an error is a bad sequence error from Stellar.
 * Uses multiple detection methods for robustness across SDK versions.
 */
function isBadSeqError(err: StellarError): boolean {
  // Robust detection: a StellarClientError (#479) carries Horizon's parsed
  // result codes directly, no unsafe property access needed.
  if (err instanceof StellarClientError && err.resultCodes?.transaction === "tx_bad_seq") {
    return true;
  }

  // Robust detection: check Horizon response structure
  const unknownErr = err as unknown;
  if (
    unknownErr &&
    typeof unknownErr === "object" &&
    "response" in unknownErr
  ) {
    const response = (unknownErr as { response?: { status?: number; data?: { extras?: { result_codes?: { transaction?: string } } } } }).response;
    if (response?.status === 400) {
      const resultCodes = response?.data?.extras?.result_codes;
      if (resultCodes?.transaction === "tx_bad_seq") {
        return true;
      }
    }
  }

  return false;
  // Fallback string matching, for a StellarError that didn't go through
  // toStellarClientError (e.g. constructed directly elsewhere).
  return err.message.includes("bad_seq") || err.message.includes("tx_bad_seq");
}

/**
 * Build and submit a Soroban contract invocation transaction.
 */
export async function invokeContract(
  contractId: string,
  method: string,
  args: StellarSdk.xdr.ScVal[],
  signer?: StellarSdk.Keypair
): Promise<string> {
  const keypair = signer ?? getPlatformKeypair();
  const requestId = getRequestId();

  return withAccountLock(keypair.publicKey(), async () => {
    const contract = new StellarSdk.Contract(contractId);

    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      try {
        const seqNum = await sequenceCache.getNextSequence(keypair.publicKey());
        const account = new StellarSdk.Account(keypair.publicKey(), seqNum);

        // Build an initial transaction for simulation; fee doesn't matter here.
        const txForSim = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: getNetworkPassphrase(),
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(60)
          .build();

        // Simulate first to avoid submitting doomed txs (signing before
        // simulation is wasted — assembleTransaction produces a new tx that
        // must be signed separately)
        const soroban = getSorobanServer();
        const simResult = await soroban.simulateTransaction(txForSim);
        if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
          logger.error({ requestId, error: simResult.error }, "Simulation failed");
          throw new StellarClientError(`Simulation failed: ${simResult.error}`, "soroban", {
            sorobanError: simResult.error,
          });
        }

        // #218: Compute the total fee from the simulation result.
        // minResourceFee covers Soroban resource costs; BASE_FEE covers
        // ledger inclusion. A 20 % buffer absorbs fee-market fluctuations
        // between simulation and submission without over-paying significantly.
        const resourceFee = BigInt(
          (simResult as StellarSdk.rpc.Api.SimulateTransactionSuccessResponse)
            .minResourceFee ?? "0",
        );
        const inclusionFee = BigInt(StellarSdk.BASE_FEE);
        const totalFee = String(
          inclusionFee + (resourceFee * 120n) / 100n,
        );

        // Rebuild the transaction with the computed fee before assembling.
        const txWithFee = new StellarSdk.TransactionBuilder(account, {
          fee: totalFee,
          networkPassphrase: getNetworkPassphrase(),
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(60)
          .build();

        // Prepare the transaction with the simulation results
        const preparedTx = StellarSdk.rpc.assembleTransaction(txWithFee, simResult).build();
        preparedTx.sign(keypair);

        const result = await stellarClient.submitTransaction(preparedTx);
        return result.hash;
      } catch (err: unknown) {
      } catch (err) {
        if (err instanceof StellarError && isBadSeqError(err)) {
          await sequenceCache.invalidate(keypair.publicKey());
          logger.warn({ requestId, attempt, err }, "Sequence number conflict, retrying with fresh sequence");
          continue;
        }
        if (err instanceof StellarError) throw err;
        throw toStellarClientError(err, "Contract invocation failed");
      }
    }
    throw new StellarClientError(
      `Failed after ${MAX_SEQ_RETRIES} attempts due to sequence conflicts`,
      "horizon",
    );
  });
}

