import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "../config/index.js";
import { getSorobanServer, getNetworkPassphrase } from "../config/stellar.js";
import { logger } from "../utils/logger.js";

/**
 * Reads the canonical content hash for a course from the progress-tracker
 * contract, for the enrollment-time check in issue #294.
 *
 * Returns null (meaning "skip verification") whenever the hash cannot be
 * determined: the contract isn't configured, the RPC call fails, or the
 * response can't be parsed. The check this backs is explicitly
 * non-blocking, so a missing/unreachable contract must never fail
 * enrollment — it just means the comparison is skipped for this request.
 */
export async function getOnChainContentHash(
  courseId: string,
): Promise<string | null> {
  const contractId = config.STELLAR_PROGRESS_TRACKER_CONTRACT_ID;
  if (!contractId) {
    return null;
  }

  try {
    const soroban = getSorobanServer();
    const contract = new StellarSdk.Contract(contractId);

    // A read-only simulation doesn't submit anything, so it can use a
    // throwaway source account with sequence 0 rather than the platform
    // account (avoids burning a real sequence number on a query).
    const sourceAccount = new StellarSdk.Account(
      StellarSdk.Keypair.random().publicKey(),
      "0",
    );

    const tx = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        contract.call(
          "get_content_hash",
          StellarSdk.nativeToScVal(courseId, { type: "string" }),
        ),
      )
      .setTimeout(30)
      .build();

    const result = await soroban.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(result)) {
      logger.warn(
        { courseId, error: result.error },
        "progress-tracker simulation returned an error — skipping content hash verification",
      );
      return null;
    }
    if (!StellarSdk.rpc.Api.isSimulationSuccess(result) || !result.result?.retval) {
      return null;
    }

    const value = StellarSdk.scValToNative(result.result.retval);
    return typeof value === "string" ? value : null;
  } catch (err) {
    logger.warn(
      { err, courseId },
      "Failed to read on-chain content hash — skipping content hash verification",
    );
    return null;
  }
}
