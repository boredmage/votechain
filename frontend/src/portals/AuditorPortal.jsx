import { useState } from "react";
import { ethers } from "ethers";
import { Accordion, Button, Table } from "@heroui/react";
import { useApp, usePolled } from "../hooks/useApp.jsx";
import { api } from "../lib/api.js";
import { STATE_UNIT_ID } from "../lib/constants.js";
import { fmtNum, shortAddr, fmtTime } from "../lib/format.js";
import { Alert, Empty, Badge, StatusBadge, IpfsUpload, FiguresTable, KeyValues, Panel, Checklist, HashValue, Loading, Columns } from "../components/common.jsx";
import { useUnit } from "../components/geography.jsx";
import { UnitHeader, DisputesPanel, SignaturesPanel } from "../components/unit.jsx";
import { NotificationsPanel } from "../components/layout.jsx";

/**
 * Independent state auditor: read-only access to the full chain, rulings on escalated disputes,
 * and the ECDSA verification signature that gates the final declaration (Section 3.5.5).
 */
export function AuditorPortal() {
  const { election, sendTx, busy, wallet, contracts, toast } = useApp();
  const audit = usePolled(() => api.audit(), [], 6000);
  const escalated = usePolled(() => api.escalated(), [], 6000);
  const chain = usePolled(() => api.chain(), [], 15000);
  const state = useUnit("State", STATE_UNIT_ID);
  const [reportCid, setReportCid] = useState("");
  const [signature, setSignature] = useState("");
  const candidates = election?.candidates.map((c) => ({ ...c, acronym: election.parties.find((p) => p.id === c.partyId)?.acronym })) ?? [];

  const signDigest = async () => {
    try {
      const digest = await contracts.audit.auditDigest();
      const sig = await wallet.signer.signMessage(ethers.getBytes(digest));
      setSignature(sig);
      toast("Audit digest signed with your wallet key (off-chain). Now record it on-chain.", "success");
    } catch (err) {
      toast(err.message, "error");
    }
  };
  const record = () => sendTx("Record audit approval", (c) => c.audit.verifyAndSign(signature, reportCid));

  const a = audit.data;
  const checks = chain.data
    ? [
        ...Object.entries(chain.data.consistency.wards).map(([id, ok]) => ({ label: `Ward #${id} = Σ approved polling units`, ok })),
        ...Object.entries(chain.data.consistency.lgas).map(([id, ok]) => ({ label: `LGA #${id} = Σ approved wards`, ok })),
        { label: "State = Σ approved LGAs", ok: chain.data.consistency.state },
      ]
    : [];
  const stateApproved = state.data?.status === "Approved" || state.data?.status === "Declared";

  return (
    <div className="flex flex-col gap-5" data-testid="auditor-portal">
      <Columns
        main={
          <>
            <Panel title="Audit readiness" description="The verification signature can only be recorded once every condition holds.">
              <div className="flex flex-col gap-4">
                <Checklist
                  items={[
                    { done: stateApproved, content: <>State collation approved by all state party agents {state.data ? <StatusBadge status={state.data.status} /> : null}</> },
                    { done: a && a.escalatedDisputeIds.length === 0, content: `No escalated disputes awaiting a ruling (${a?.escalatedDisputeIds.length ?? "…"} pending)` },
                    { done: checks.length > 0 && checks.every((c) => c.ok === true), content: `Every collation recomputes correctly from the level below (${checks.filter((c) => c.ok === true).length}/${checks.length})` },
                    { done: a?.audit.approved, content: "Auditor signature recorded on-chain" },
                  ]}
                />
                {a && !a.ready && !a.audit.approved ? <Alert kind="warn" title="Not ready yet">{a.readyReason}</Alert> : null}
                {a?.audit.approved ? (
                  <Alert kind="ok" title="Audit approval recorded">
                    By {shortAddr(a.audit.auditor)} on {fmtTime(a.audit.approvedAt)}. Report CID <code className="break-all">{a.audit.reportCid}</code>.
                  </Alert>
                ) : null}
              </div>
            </Panel>

            {a?.ready ? (
              <Panel
                title="Sign the state result hash"
                description={
                  <>
                    Step 1 signs <code>auditDigest()</code> = keccak256("VoteChain.AuditApproval", chainId, contract, stateResultHash) with your wallet (EIP-191). Step 2 submits the signature; the contract recovers the signer with{" "}
                    <code>ecrecover</code> and only accepts the registered auditor.
                  </>
                }
              >
                <div className="flex flex-col gap-4">
                  <KeyValues items={[["State result hash", <HashValue value={state.data?.figuresHash} key="h" />]]} />
                  <IpfsUpload label="Audit report (PDF or image)" required purpose="audit-report" uploader={wallet?.address} onUploaded={setReportCid} />
                  <ol className="flex flex-wrap gap-2">
                    <li>
                      <Button variant={signature ? "secondary" : "primary"} onPress={signDigest} isDisabled={busy}>
                        {signature ? "✓ Digest signed" : "1. Sign digest with wallet"}
                      </Button>
                    </li>
                    <li>
                      <Button variant="primary" onPress={record} isDisabled={busy || !signature || !reportCid}>
                        2. Record verification on-chain
                      </Button>
                    </li>
                  </ol>
                  {signature ? <HashValue value={signature} /> : null}
                </div>
              </Panel>
            ) : null}

            <Panel title="Escalated disputes" description="Disputes where the agent rejected the officer's resolution. Your ruling is final.">
              {!escalated.data ? <Loading /> : null}
              {escalated.data?.length === 0 ? <Empty>None pending.</Empty> : null}
              <div className="flex flex-col gap-5">
                {escalated.data?.map((d) => (
                  <EscalatedDispute key={d.id} dispute={d} />
                ))}
              </div>
            </Panel>
          </>
        }
        side={
          <>
            {state.data ? (
              <>
                <UnitHeader unit={state.data} />
                {state.data.figures ? (
                  <Panel title="EC8D state figures">
                    <FiguresTable label="EC8D state figures" figures={state.data.figures} candidates={candidates} compare={state.data.aggregate?.complete ? state.data.aggregate.figures : null} compareLabel="Σ approved LGAs" />
                  </Panel>
                ) : null}
                <SignaturesPanel unit={state.data} />
              </>
            ) : null}
            <NotificationsPanel />
          </>
        }
      />

      <Panel title="Full chain trace" description="Every state figure traced to its source polling units. Consistency is re-verified by calling CollationEngine.verifyConsistency for each collation.">
        {!chain.data ? <Loading>Loading the chain…</Loading> : null}
        {chain.data ? (
          <Accordion allowsMultipleExpanded className="w-full">
            {chain.data.lgas.map((lga) => (
              <Accordion.Item key={lga.unitId} id={String(lga.unitId)}>
                <Accordion.Heading>
                  <Accordion.Trigger className="flex w-full flex-wrap items-center gap-2">
                    <span className="font-semibold">{lga.name} LGA</span>
                    <StatusBadge status={lga.status} />
                    <Consistency ok={chain.data.consistency.lgas[lga.unitId]} />
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body>
                    <Table variant="secondary">
                      <Table.ScrollContainer>
                        <Table.Content aria-label={`${lga.name} LGA wards`} className="min-w-[640px]">
                          <Table.Header>
                            <Table.Column isRowHeader>Ward</Table.Column>
                            <Table.Column>Status</Table.Column>
                            <Table.Column className="vc-num">Valid votes</Table.Column>
                            <Table.Column>Polling units</Table.Column>
                            <Table.Column>Consistency</Table.Column>
                          </Table.Header>
                          <Table.Body>
                            {lga.wards.map((w) => (
                              <Table.Row key={w.unitId} id={String(w.unitId)}>
                                <Table.Cell className="font-medium">{w.name}</Table.Cell>
                                <Table.Cell>
                                  <StatusBadge status={w.status} />
                                </Table.Cell>
                                <Table.Cell className="vc-num">{w.figures ? fmtNum(w.figures.validVotes) : "—"}</Table.Cell>
                                <Table.Cell>
                                  <ul className="flex flex-col gap-1 text-xs">
                                    {w.pollingUnits.map((pu) => (
                                      <li key={pu.unitId} className="flex flex-wrap items-center gap-1.5">
                                        <span className="font-mono">{pu.code}</span>
                                        <span className="tabular-nums">{pu.figures ? fmtNum(pu.figures.validVotes) : "—"}</span>
                                        <StatusBadge status={pu.status} />
                                        {pu.disputes?.length ? <Badge kind="warn">{pu.disputes.length} dispute(s)</Badge> : null}
                                      </li>
                                    ))}
                                  </ul>
                                </Table.Cell>
                                <Table.Cell>
                                  <Consistency ok={chain.data.consistency.wards[w.unitId]} />
                                </Table.Cell>
                              </Table.Row>
                            ))}
                          </Table.Body>
                        </Table.Content>
                      </Table.ScrollContainer>
                    </Table>
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        ) : null}
      </Panel>
    </div>
  );
}

function Consistency({ ok }) {
  if (ok === null || ok === undefined) return <Badge>Not collated</Badge>;
  return ok ? <Badge kind="ok">Consistent</Badge> : <Badge kind="danger">Inconsistent</Badge>;
}

function EscalatedDispute({ dispute }) {
  const unit = useUnit(dispute.level, dispute.unitId);
  if (!unit.data) return <Loading />;
  return (
    <div className="flex flex-col gap-3">
      <UnitHeader unit={unit.data} />
      <DisputesPanel unit={unit.data} />
    </div>
  );
}
