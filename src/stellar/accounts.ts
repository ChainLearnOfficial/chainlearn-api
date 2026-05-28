import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarClient } from "./client.js";
import { getPlatformKeypair, getNetworkPassphrase } from "../config/stellar.js";
import { logger } from "../utils/logger.js";
import { StellarError } from "../utils/errors.js";

/**
 * Check if a Stellar address is valid.
 */
export function isValidStellarAddress(address: string): boolean {
  try {
    StellarSdk.Keypair.fromPublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/**
 * Fund a new account from the platform wallet (testnet only).
 */
export async function fundAccount(
  publicKey: string,
  amount: string = "2"
): Promise<string> {
  const platformKeypair = getPlatformKeypair();
  const platformAccount = await stellarClient.getAccount(
    platformKeypair.publicKey()
  );

  const tx = new StellarSdk.TransactionBuilder(platformAccount, {
    fee: StellarSdk.BASE_FEE,
    networkPassphrase: getNetworkPassphrase(),
  })
    .addOperation(
      StellarSdk.Operation.createAccount({
        destination: publicKey,
        startingBalance: amount,
      })
    )
    .setTimeout(60)
    .build();

  tx.sign(platformKeypair);
  const result = await stellarClient.submitTransaction(tx);
  logger.info({ publicKey, hash: result.hash }, "Account funded");
  return result.hash;
}

/**
 * Get XLM balance for an account.
 */
export async function getBalance(publicKey: string): Promise<string> {
  const account = await stellarClient.getAccount(publicKey);
  const nativeBalance = account.balances.find(
    (b) => b.asset_type === "native"
  );
  return nativeBalance?.balance ?? "0";
}
