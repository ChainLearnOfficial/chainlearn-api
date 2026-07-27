import * as StellarSdk from "@stellar/stellar-sdk";
import { stellarClient } from "./client.js";
import { getPlatformKeypair, getNetworkPassphrase } from "../config/stellar.js";
import { logger } from "../utils/logger.js";
import { StellarError } from "../utils/errors.js";
import { sequenceCache } from "./sequence-cache.js";
import { withAccountLock } from "../utils/account-lock.js";

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
const MAX_SEQ_RETRIES = 3;

export async function fundAccount(
  publicKey: string,
  amount: string = "2"
): Promise<string> {
  const platformKeypair = getPlatformKeypair();
  
  return withAccountLock(platformKeypair.publicKey(), async () => {
    for (let attempt = 0; attempt < MAX_SEQ_RETRIES; attempt++) {
      try {
        const seqNum = await sequenceCache.getNextSequence(platformKeypair.publicKey());
        const account = new StellarSdk.Account(platformKeypair.publicKey(), seqNum);

        const tx = new StellarSdk.TransactionBuilder(account, {
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
      } catch (err: any) {
        if (err instanceof StellarError && (err.message.includes("bad_seq") || err.message.includes("tx_bad_seq"))) {
          sequenceCache.invalidate(platformKeypair.publicKey());
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
 * Get XLM balance for an account.
 */
export async function getBalance(publicKey: string): Promise<string> {
  const account = await stellarClient.getAccount(publicKey);
  const nativeBalance = account.balances.find(
    (b) => b.asset_type === "native"
  );
  return nativeBalance?.balance ?? "0";
}
