import { Component, lazy, Suspense, useEffect, useState } from "react";
import { Button, Tabs, Toast } from "@heroui/react";
import { AppProvider, useApp } from "./hooks/useApp.jsx";
import { CATEGORY_LABEL } from "./lib/constants.js";
import { TopBar, PhaseStepper } from "./components/layout.jsx";
import { Alert, Loading } from "./components/common.jsx";
import { PublicPortal } from "./portals/PublicPortal.jsx";

// role portals load on demand: a public visitor never downloads the officer UIs
const named = (load, name) => lazy(() => load().then((m) => ({ default: m[name] })));
const AdminPortal = named(() => import("./portals/AdminPortal.jsx"), "AdminPortal");
const PresidingOfficerPortal = named(() => import("./portals/PresidingOfficerPortal.jsx"), "PresidingOfficerPortal");
const PartyAgentPortal = named(() => import("./portals/PartyAgentPortal.jsx"), "PartyAgentPortal");
const CollationOfficerPortal = named(() => import("./portals/CollationOfficerPortal.jsx"), "CollationOfficerPortal");
const AuditorPortal = named(() => import("./portals/AuditorPortal.jsx"), "AuditorPortal");
const PublisherPortal = named(() => import("./portals/PublisherPortal.jsx"), "PublisherPortal");

/** Maps the on-chain stakeholder category of the connected wallet to its portal. */
const PORTALS = {
  InecAdmin: { id: "admin", label: "INEC Admin", component: AdminPortal },
  PresidingOfficer: { id: "po", label: "Presiding Officer", component: PresidingOfficerPortal },
  PartyAgent: { id: "agent", label: "Party Agent", component: PartyAgentPortal },
  WardCollationOfficer: { id: "ward", label: "Ward Collation", component: CollationOfficerPortal },
  LgaCollationOfficer: { id: "lga", label: "LGA Collation", component: CollationOfficerPortal },
  StateReturningOfficer: { id: "state", label: "State Returning Officer", component: CollationOfficerPortal },
  Auditor: { id: "auditor", label: "Independent Auditor", component: AuditorPortal },
  ResultPublisher: { id: "publisher", label: "Result Publisher", component: PublisherPortal },
};

/** Last line of defence: a render error shows a recoverable message instead of a blank page. */
class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("VoteChain UI error", error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <Alert
          kind="danger"
          title="Something went wrong on this page"
          action={
            <Button size="sm" variant="secondary" onPress={() => this.setState({ error: null })}>
              Try again
            </Button>
          }
        >
          {String(this.state.error?.message ?? this.state.error)}. No transaction was sent; on-chain records are unaffected.
        </Alert>
      </main>
    );
  }
}

function Shell() {
  const { config, configError, wallet, role, backendDown } = useApp();
  const portal = wallet && role ? PORTALS[role.category] : null;
  const [tab, setTab] = useState("public");

  useEffect(() => {
    setTab(portal ? portal.id : "public");
  }, [portal?.id]);

  if (configError)
    return (
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
        <Alert kind="danger" title="Cannot reach the VoteChain backend" action={<Button size="sm" variant="secondary" onPress={() => window.location.reload()}>Retry</Button>}>
          {configError}. Start it with <code>npm run dev</code> in <code>backend/</code> (it needs a deployed contract set — see the README).
        </Alert>
      </main>
    );
  if (!config)
    return (
      <main className="mx-auto w-full max-w-[1280px] flex-1 px-4 sm:px-6">
        <Loading>Connecting to the backend…</Loading>
      </main>
    );

  const Portal = portal?.component;
  const tabs = [...(portal ? [{ id: portal.id, label: `${portal.label} portal` }] : []), { id: "public", label: "Public verification" }];

  return (
    <>
      <PhaseStepper />
      <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-5 px-4 py-5 sm:px-6">
        {backendDown ? (
          <Alert kind="warn" title="Connection to the VoteChain backend lost">
            The figures below may be out of date. Retrying automatically every few seconds.
          </Alert>
        ) : null}
        {wallet && role && !portal && role.category === "None" ? (
          <Alert kind="info" title="No stakeholder role">
            This wallet holds no role in this election, so only public verification is available. INEC registers wallets during the Registration phase.
          </Alert>
        ) : null}
        {portal ? (
          <Tabs selectedKey={tab} onSelectionChange={(k) => setTab(String(k))} className="w-full">
            <Tabs.ListContainer>
              <Tabs.List aria-label="Portal views">
                {tabs.map((t) => (
                  <Tabs.Tab key={t.id} id={t.id} data-testid={`tab-${t.id}`}>
                    {t.label}
                    <Tabs.Indicator />
                  </Tabs.Tab>
                ))}
              </Tabs.List>
            </Tabs.ListContainer>
            <Tabs.Panel id={portal.id} className="pt-5">
              <Suspense fallback={<Loading>Loading portal…</Loading>}>
                <Portal key={`${role.category}-${role.level}-${role.unitId}`} />
              </Suspense>
            </Tabs.Panel>
            <Tabs.Panel id="public" className="pt-5">
              <PublicPortal />
            </Tabs.Panel>
          </Tabs>
        ) : (
          <PublicPortal />
        )}
      </main>
      <footer className="border-t border-border px-4 py-6 text-center text-xs text-muted">
        <p className="mx-auto max-w-3xl">
          VoteChain — blockchain-based electoral result collation and multi-party verification with hierarchical validation (Oyo State case study). Every record is read from the Ethereum contracts; the backend is
          a display cache and IPFS gateway only.
          {role ? ` · Signed in as ${CATEGORY_LABEL[role.category] ?? role.category}` : ""}
        </p>
      </footer>
    </>
  );
}

export default function App() {
  return (
    <AppProvider>
      <div className="flex min-h-screen flex-col">
        <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-50 focus:rounded-sm focus:bg-accent focus:px-3 focus:py-2 focus:text-accent-foreground">
          Skip to content
        </a>
        <TopBar />
        <div id="main" className="flex flex-1 flex-col">
          <ErrorBoundary>
            <Shell />
          </ErrorBoundary>
        </div>
        <Toast.Provider placement="bottom end" />
      </div>
    </AppProvider>
  );
}
