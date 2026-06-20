import * as crypto from 'crypto';
import * as StellarSdk from "@stellar/stellar-sdk";
import { eq } from 'drizzle-orm';
import { db } from '../../database';
import { users } from '../../database/schema';
import { redis } from '../../config/redis'; // Assumed connection instance path
import { getNetworkPassphrase } from '../../stellar/client'; // Assumed network lookup helper
import { ChallengeResponse, AuthResponse } from './auth.types';

// Custom error mappings matching project structure specifications
class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

const CHALLENGE_PREFIX = 'auth_challenge:';
const CHALLENGE_TTL_SECONDS = 300; // 5 minute tracking cutoff window

export class AuthService {
  /**
   * Generates an official on-chain SEP-10 challenge transaction envelope structure
   */
  async createChallenge(stellarAddress: string): Promise<ChallengeResponse> {
    const account = new StellarSdk.Account(stellarAddress, "0");
    const challengeNonce = crypto.randomBytes(32).toString("base64");
    
    const transaction = new StellarSdk.TransactionBuilder(account, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: getNetworkPassphrase(),
    })
      .addOperation(
        StellarSdk.Operation.manageData({
          name: "chainlearn_auth",
          value: challengeNonce,
        })
      )
      .addMemo(StellarSdk.Memo.text("ChainLearn Auth"))
      .setTimeout(CHALLENGE_TTL_SECONDS)
      .build();

    const challengeXDR = transaction.toXDR();

    // Store the raw XDR blueprint securely inside the single-use temporary cache bounds
    await redis.setex(
      `${CHALLENGE_PREFIX}${stellarAddress}`,
      CHALLENGE_TTL_SECONDS,
      challengeXDR
    );

    return {
      challenge: challengeXDR,
      networkPassphrase: getNetworkPassphrase(),
    };
  }

  /**
   * Decodes, audits, and cryptographically verifies the integrity of signed user challenges
   */
  async verifyChallenge(stellarAddress: string, signedChallengeXDR: string): Promise<AuthResponse> {
    // 1. Retrieve stored challenge blueprint from single-use cache
    const storedXDR = await redis.get(`${CHALLENGE_PREFIX}${stellarAddress}`);
    if (!storedXDR) {
      throw new UnauthorizedError("Challenge expired or not found");
    }

    // 2. Decode the incoming signed transaction sequence envelope
    let signedTx: StellarSdk.Transaction;
    try {
      signedTx = new StellarSdk.Transaction(
        signedChallengeXDR,
        getNetworkPassphrase()
      );
    } catch {
      throw new UnauthorizedError("Invalid transaction format");
    }

    // 3. Verify the transaction source identity matches the claimed workspace address
    if (signedTx.source !== stellarAddress) {
      throw new UnauthorizedError("Transaction source does not match address");
    }

    // 4. Verify cryptographic signature parameters
    const keypair = StellarSdk.Keypair.fromPublicKey(stellarAddress);
    const signatureValid = signedTx.signatures.some((sig) => {
      try {
        return keypair.verify(signedTx.hash(), sig.signature());
      } catch {
        return false;
      }
    });

    if (!signatureValid) {
      throw new UnauthorizedError("Invalid signature verification failed");
    }

    // 5. Enforce explicit chronological expiration constraints
    if (!signedTx.timeBounds) {
      throw new UnauthorizedError("Transaction missing essential time bounds configuration");
    }
    
    const now = Math.floor(Date.now() / 1000);
    if (now > Number(signedTx.timeBounds.maxTime)) {
      throw new UnauthorizedError("Challenge execution window has expired");
    }

    // 6. Confirm presence of expected registration metadata operations
    const hasManageData = signedTx.operations.some(
      (op) => op.type === "manageData" && op.name === "chainlearn_auth"
    );

    if (!hasManageData) {
      throw new UnauthorizedError("Invalid challenge parameters: missing configuration bounds");
    }

    // 7. Atomic invalidation of token to neutralize replay vulnerability risks
    await redis.del(`${CHALLENGE_PREFIX}${stellarAddress}`);

    // 8. Provision authenticated identity mapping records within storage layer
    let user = await db.query.users.findFirst({
      where: eq(users.stellarAddress, stellarAddress),
    });

    let isNewUser = false;
    if (!user) {
      const usersArray = await db.insert(users).values({ stellarAddress }).returning();
      user = usersArray[0];
      isNewUser = true;
    }

    // Return payload context ready for local JWT production layers
    return {
      token: "mock-session-jwt-placeholder",
      user: {
        id: user.id,
        stellarAddress: user.stellarAddress,
        displayName: user.displayName ?? null,
        isNewUser,
      },
    };
  }
}
