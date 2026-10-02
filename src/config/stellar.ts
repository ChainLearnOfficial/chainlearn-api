import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "./index.js";

// Cache the platform keypair as a singleton to avoid repeated cryptographic operations
let cachedPlatformKeypair: StellarSdk.Keypair | null = null;

export function getHorizonServer(): StellarSdk.Horizon.Server {
  return new StellarSdk.Horizon.Server(config.STELLAR_HORIZON_URL);
}

export function getSorobanServer(): StellarSdk.rpc.Server {
  return new StellarSdk.rpc.Server(config.STELLAR_SOROBAN_RPC_URL);
}

export function getNetworkPassphrase(): string {
  return config.STELLAR_NETWORK === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;
}

export function getPlatformKeypair(): StellarSdk.Keypair {
  if (!cachedPlatformKeypair) {
    cachedPlatformKeypair = StellarSdk.Keypair.fromSecret(config.STELLAR_PLATFORM_SECRET);
  }
  return cachedPlatformKeypair;
}
