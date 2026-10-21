import { ethers } from "ethers";
import { env } from "./env.js";

const RPC_URL = env.RPC_URL;

/** Read-only provider (public verification never needs a wallet). */
export function readProvider() {
  return new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
}

export function hasInjectedWallet() {
  return typeof window !== "undefined" && Boolean(window.ethereum);
}

/** Connects MetaMask (or any EIP-1193 wallet) and switches it to the expected chain when needed. */
export async function connectInjected(expectedChainId) {
  if (!hasInjectedWallet()) throw new Error("No wallet found. Install MetaMask or use the demo role switcher.");
  const provider = new ethers.BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const network = await provider.getNetwork();
  if (expectedChainId && Number(network.chainId) !== Number(expectedChainId)) {
    const hex = "0x" + Number(expectedChainId).toString(16);
    try {
      await provider.send("wallet_switchEthereumChain", [{ chainId: hex }]);
    } catch (err) {
      if (err?.code === 4902 || /Unrecognized chain/i.test(err?.message ?? "")) {
        await provider.send("wallet_addEthereumChain", [
          {
            chainId: hex,
            chainName: Number(expectedChainId) === 31337 ? "VoteChain Local (Hardhat/Anvil)" : `Chain ${expectedChainId}`,
            rpcUrls: [RPC_URL],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          },
        ]);
      } else {
        throw err;
      }
    }
  }
  const signer = await provider.getSigner();
  return { kind: "injected", provider, signer, address: await signer.getAddress() };
}

/** Demo mode: signs with one of the publicly known local-node keys (never on a real network). */
export function connectDemo(privateKey) {
  const provider = readProvider();
  const wallet = new ethers.Wallet(privateKey, provider);
  return { kind: "demo", provider, signer: wallet, address: wallet.address };
}

export function onAccountsChanged(handler) {
  if (!hasInjectedWallet()) return () => {};
  window.ethereum.on("accountsChanged", handler);
  window.ethereum.on("chainChanged", handler);
  return () => {
    window.ethereum.removeListener("accountsChanged", handler);
    window.ethereum.removeListener("chainChanged", handler);
  };
}
