import * as StellarSdk from "@stellar/stellar-sdk";
import {
  getPlatformKeypair,
  getNetworkPassphrase,
  getSorobanServer,
} from "../config/stellar.js";
import { config } from "../config/index.js";
import { stellarClient } from "./client.js";
import { logger } from "../utils/logger.js";
import { StellarError } from "../utils/errors.js";

import { sequenceCache } from "./sequence-cache.js";
import { withAccountLock } from "../utils/account-lock.js";

const MAX_SEQ_RETRIES = 3;

/**
 * Detects if an error is a bad sequence error from Stellar.
 * Uses multiple detection methods for robustness across SDK versions.
 */
function isBadSeqError(err: StellarError): boolean {
  // Primary detection: string matching (backwards compatible)
  if (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq")) {
    return true;
  }
  
  // Robust detection: check Horizon response structure
  const response = (err as any)?.response;
  if (response?.status === 400) {
    const resultCodes = response?.data?.extras?.result_codes;
    if (resultCodes?.transaction === "tx_bad_seq") {
      return true;
    }
  }
  
  return false;
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
          logger.error({ error: simResult.error }, "Simulation failed");
          throw new StellarError(`Simulation failed: ${simResult.error}`);
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
      } catch (err: any) {
        if (err instanceof StellarError && isBadSeqError(err)) {
          await sequenceCache.invalidate(keypair.publicKey());
          logger.warn({ attempt, err }, "Sequence number conflict, retrying with fresh sequence");
          continue;
        }
        throw err;
      }
    }
    throw new StellarError(`Failed after ${MAX_SEQ_RETRIES} attempts due to sequence conflicts`);
  });
}

