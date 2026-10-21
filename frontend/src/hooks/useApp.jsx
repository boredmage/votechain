import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { toast as heroToast } from "@heroui/react";
import { api, setSessionToken, getSessionToken } from "../lib/api.js";
import { buildContracts, decodeError } from "../lib/contracts.js";
import { connectInjected, connectDemo, readProvider, onAccountsChanged } from "../lib/wallet.js";
import { env } from "../lib/env.js";

const AppContext = createContext(null);

const DEMO_MODE = env.DEMO_MODE;

export function AppProvider({ children }) {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState(null);
  const [wallet, setWallet] = useState(null); // { kind, provider, signer, address }
  const [role, setRole] = useState(null); // stakeholder record from chain
  const [election, setElection] = useState(null);
  const [tick, setTick] = useState(0);
  const [demoAccounts, setDemoAccounts] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [busy, setBusy] = useState(false);
  const [backendDown, setBackendDown] = useState(false);
  const tickRef = useRef(0);

  const refresh = useCallback(() => {
    tickRef.current += 1;
    setTick(tickRef.current);
  }, []);

  /** Shows a HeroUI toast. kind: info | success | error | warning; ttl in ms (0 = sticky). */
  const toast = useCallback((message, kind = "info", ttl = 6000) => {
    const opts = { timeout: ttl };
    if (kind === "success") return heroToast.success(message, opts);
    if (kind === "error") return heroToast.danger(message, opts);
    if (kind === "warning") return heroToast.warning(message, opts);
    return heroToast.info(message, opts);
  }, []);

  // ---- bootstrap: backend config + demo accounts -------------------------------
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.config();
        setConfig(cfg);
        if (DEMO_MODE && cfg.demoMode) {
          try {
            setDemoAccounts(await api.demoAccounts());
          } catch {
            setDemoAccounts(null);
          }
        }
      } catch (err) {
        setConfigError(err.message);
      }
    })();
  }, []);

  // ---- election summary polling ---------------------------------------------------
  useEffect(() => {
    if (!config) return undefined;
    let stop = false;
    const load = async () => {
      try {
        const e = await api.election();
        if (!stop) {
          setElection(e);
          setBackendDown(false);
        }
      } catch {
        if (!stop) setBackendDown(true); // backend unreachable or restarting: warn, keep retrying
      }
    };
    load();
    const id = setInterval(load, 6000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [config, tick]);

  // ---- role lookup when the wallet changes -----------------------------------------
  useEffect(() => {
    if (!wallet) {
      setRole(null);
      return;
    }
    let stop = false;
    api
      .stakeholder(wallet.address)
      .then((r) => !stop && setRole(r))
      .catch(() => !stop && setRole({ category: "None" }));
    return () => {
      stop = true;
    };
  }, [wallet, tick]);

  // ---- injected wallet account/chain changes ---------------------------------------
  useEffect(() => {
    if (wallet?.kind !== "injected") return undefined;
    return onAccountsChanged(() => {
      connectInjected(config?.chainId)
        .then(setWallet)
        .catch(() => setWallet(null));
    });
  }, [wallet?.kind, config?.chainId]);

  // ---- notifications (needs a backend session) --------------------------------------
  const loadNotifications = useCallback(async () => {
    if (!wallet || !getSessionToken()) return;
    try {
      setNotifications(await api.notifications());
    } catch (err) {
      if (err.status === 401) setSessionToken(null);
    }
  }, [wallet]);

  useEffect(() => {
    if (!wallet) return undefined;
    loadNotifications();
    const id = setInterval(loadNotifications, 8000);
    return () => clearInterval(id);
  }, [wallet, tick, loadNotifications]);

  const signIn = useCallback(async () => {
    if (!wallet) return;
    try {
      const { message } = await api.authNonce(wallet.address);
      const signature = await wallet.signer.signMessage(message);
      const res = await api.authVerify(wallet.address, signature);
      setSessionToken(res.token);
      await loadNotifications();
      toast("Signed in – notifications enabled.", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  }, [wallet, loadNotifications, toast]);

  // ---- wallet connection ------------------------------------------------------------
  const connectWallet = useCallback(async () => {
    try {
      const w = await connectInjected(config?.chainId);
      setSessionToken(null);
      setRole(null); // never let a previous wallet's role render against the new wallet
      setWallet(w);
      toast(`Connected ${w.address.slice(0, 8)}…`, "success");
    } catch (err) {
      toast(decodeError(err), "error");
    }
  }, [config, toast]);

  const connectDemoAccount = useCallback((privateKey) => {
    setSessionToken(null);
    setRole(null);
    setWallet(connectDemo(privateKey));
  }, []);

  const disconnect = useCallback(() => {
    setSessionToken(null);
    setRole(null);
    setWallet(null);
    setNotifications([]);
  }, []);

  // ---- contracts ---------------------------------------------------------------------
  const readContracts = useMemo(() => (config ? buildContracts(config.contracts, readProvider()) : null), [config]);
  const contracts = useMemo(() => (config && wallet ? buildContracts(config.contracts, wallet.signer) : null), [config, wallet]);

  /** Sends a transaction with toasts + refresh; returns the receipt or null on failure. */
  const sendTx = useCallback(
    async (label, fn) => {
      if (!contracts) {
        toast("Connect a wallet first.", "error");
        return null;
      }
      setBusy(true);
      try {
        const tx = await fn(contracts);
        toast(`${label}: transaction sent ${tx.hash.slice(0, 10)}…`, "info", 4000);
        const receipt = await tx.wait();
        toast(`${label}: confirmed in block ${receipt.blockNumber}`, "success");
        refresh();
        return receipt;
      } catch (err) {
        toast(decodeError(err), "error", 10000);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [contracts, toast, refresh],
  );

  const value = useMemo(
    () => ({
      config,
      configError,
      wallet,
      role,
      election,
      tick,
      refresh,
      toast,
      demoAccounts,
      demoMode: DEMO_MODE,
      connectWallet,
      connectDemoAccount,
      disconnect,
      contracts,
      readContracts,
      sendTx,
      busy,
      backendDown,
      notifications,
      loadNotifications,
      signIn,
      signedIn: Boolean(getSessionToken()),
      ethers,
    }),
    [config, configError, wallet, role, election, tick, refresh, toast, demoAccounts, connectWallet, connectDemoAccount, disconnect, contracts, readContracts, sendTx, busy, backendDown, notifications, loadNotifications, signIn],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used inside AppProvider");
  return ctx;
}

/** Polls a backend read function every `ms` and re-runs it after every confirmed transaction. */
export function usePolled(fn, deps = [], ms = 5000) {
  const { tick } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stop = false;
    const run = async () => {
      try {
        const d = await fnRef.current();
        if (!stop) {
          setData(d);
          setError(null);
        }
      } catch (err) {
        if (!stop) setError(err.message);
      } finally {
        if (!stop) setLoading(false);
      }
    };
    run();
    const id = setInterval(run, ms);
    return () => {
      stop = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ms, ...deps]);
  return { data, error, loading, reload: () => fnRef.current().then(setData).catch((e) => setError(e.message)) };
}
