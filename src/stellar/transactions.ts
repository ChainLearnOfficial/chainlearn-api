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

        const tx = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: getNetworkPassphrase(),
        })
          .addOperation(contract.call(method, ...args))
          .setTimeout(60)
          .build();

        tx.sign(keypair);

        // Simulate first to avoid submitting doomed txs
        const soroban = getSorobanServer();
        const simResult = await soroban.simulateTransaction(tx);
        if (StellarSdk.rpc.Api.isSimulationError(simResult)) {
          logger.error({ error: simResult.error }, "Simulation failed");
          throw new StellarError(`Simulation failed: ${simResult.error}`);
        }

        // Prepare the transaction with the simulation results
        const preparedTx = StellarSdk.rpc.assembleTransaction(tx, simResult).build();
        preparedTx.sign(keypair);

        const result = await stellarClient.submitTransaction(preparedTx);
        return result.hash;
      } catch (err: any) {
        if (err instanceof StellarError && (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq"))) {
          sequenceCache.invalidate(keypair.publicKey());
          logger.warn({ attempt, err }, "Sequence number conflict, retrying with fresh sequence");
          continue;
        }
        throw err;
      }
    }
    throw new StellarError(`Failed after ${MAX_SEQ_RETRIES} attempts due to sequence conflicts`);
  });
}

/**
 * Build a payment transaction (XLM transfer).
 */
export async function sendPayment(
  destination: string,
  amount: string,
  signer?: StellarSdk.Keypair
): Promise<string> {
  const keypair = signer ?? getPlatformKeypair();

  return withAccountLock(keypair.publicKey(), async () => {
    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      try {
        const seqNum = await sequenceCache.getNextSequence(keypair.publicKey());
        const account = new StellarSdk.Account(keypair.publicKey(), seqNum);

        const tx = new StellarSdk.TransactionBuilder(account, {
          fee: StellarSdk.BASE_FEE,
          networkPassphrase: getNetworkPassphrase(),
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination,
              asset: StellarSdk.Asset.native(),
              amount,
            })
          )
          .setTimeout(60)
          .build();

        tx.sign(keypair);
        const result = await stellarClient.submitTransaction(tx);
        return result.hash;
      } catch (err: any) {
        if (err instanceof StellarError && (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq"))) {
          sequenceCache.invalidate(keypair.publicKey());
          logger.warn({ attempt, err }, "Sequence number conflict, retrying with fresh sequence");
          continue;
        }
        throw err;
      }
    }
    throw new StellarError(`Failed after ${MAX_SEQ_RETRIES} attempts due to sequence conflicts`);
  });
}
