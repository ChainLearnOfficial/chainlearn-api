import * as StellarSdk from "@stellar/stellar-sdk";
import { config } from "./index.js";

export function getHorizonServer(): StellarSdk.Horizon.Server {
  return new StellarSdk.Horizon.Server(config.STELLAR_HORIZON_URL);
}

export function getSorobanServer(): StellarSdk.SorobanRpc.Server {
  return new StellarSdk.SorobanRpc.Server(config.STELLAR_SOROBAN_RPC_URL);
}

export function getNetworkPassphrase(): string {
  return config.STELLAR_NETWORK === "mainnet"
    ? StellarSdk.Networks.PUBLIC
    : StellarSdk.Networks.TESTNET;
}

export function getPlatformKeypair(): StellarSdk.Keypair {
  return StellarSdk.Keypair.fromSecret(config.STELLAR_PLATFORM_SECRET);
}
