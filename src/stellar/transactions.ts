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
  const account = await stellarClient.getAccount(keypair.publicKey());
  const contract = new StellarSdk.Contract(contractId);

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
  if (StellarSdk.SorobanRpc.Api.isSimulationError(simResult)) {
    logger.error({ error: simResult.error }, "Simulation failed");
    throw new StellarError(`Simulation failed: ${simResult.error}`);
  }

  // Prepare the transaction with the simulation results
  const preparedTx = StellarSdk.SorobanRpc.assembleTransaction(tx, simResult).build();
  preparedTx.sign(keypair);

  const result = await stellarClient.submitTransaction(preparedTx);
  return result.hash;
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
  const account = await stellarClient.getAccount(keypair.publicKey());

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
}
