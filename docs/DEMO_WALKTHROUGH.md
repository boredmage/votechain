# Demo walkthrough (defence script)

Runs on the seeded local election (`npm run seed:local:prefill`): 2 LGAs (Ibadan North, Akinyele),
4 wards, 8 polling units, 3 parties (PA, DC, LF). LGA 2 (Akinyele) is already collated to ward level so the
audience sees the hierarchy partly filled; LGA 1 (Ibadan North) is walked through live. Every role has an
entry in the demo role switcher (top bar) — no MetaMask needed. Total time ≈ 12 minutes.

| Step | Role (switcher) | What to do | What the audience sees / the point being made |
|---|---|---|---|
| 1 | *(no wallet)* | Open the **Public verification** tab | Live collation tree: Akinyele wards Approved, Ibadan North Open. Click any Akinyele PU: figures, form scan, three signatures, hash integrity badge. |
| 2 | #4 Presiding Officer OY/11/01/001 | Enter figures that break a rule, e.g. total cast 310 with accredited 300 | The live check turns red ("Total votes cast must not exceed accredited voters"); the submit button stays disabled. Rule 1 of Table 3.2. |
| 3 | same | Correct to 812 / 300 / 290 / 285 / 5 / PA 150 / DC 100 / LF 35, upload the EC8A photo, **Submit** | Toast "confirmed in block N"; status → *Pending signatures*; CID shown; figures hash displayed. |
| 4 | PA agent — PU OY/11/01/001 | **Sign — figures are correct** | Signature row turns green (1/3). Explain hash binding. |
| 5 | DC agent — PU OY/11/01/001 | **Reject — raise dispute**, reason "Form shows 160 for PA", optional photo | Status → *Frozen (dispute)*; the LF agent's portal now shows "Signing is paused". Dispute freeze invariant. |
| 6 | #4 Presiding Officer | The form is now titled *Correct the figures*; change PA to 160, valid 295, cast 300, accredited 310, upload, **Resubmit** | Status → *Resolved – awaiting agent*; dispute card shows "corrected the figures (new signing round)". |
| 7 | DC agent | **Accept resolution**, then **Sign** | Round 2 opens; the PA signature from round 1 does not carry over. |
| 8 | PA agent, then LF agent | PA: Sign. LF: **Sign with objection** ("kept outside during counting") | Status → *Approved*; LF's objection is permanent but did not block. Section 3.6. |
| 9 | #5 Presiding Officer OY/11/01/002 + its 3 agents | Upload consistent figures and sign | Second PU approved → ward 1 is collatable. |
| 10 | #12 Ward Collation Officer (Agbowo) | Click **Fill from computed aggregate**, then add 100 to PA and **Confirm** | Pre-check warns; transaction succeeds but records a **mismatch alert**; status stays *Awaiting figures*; the banner "1 mismatch alert(s) permanently recorded". Table 3.2 rule 6 with evidence. |
| 11 | same | Fill from computed aggregate again (honest), **Confirm** | Status → *Pending signatures* for the ward. |
| 12 | 3 ward agents (Agbowo) | Sign | Ward 1 Approved. |
| 13 | PUs 3–4, ward 2, then #16/#17 LGA officers and their agents | Repeat upload/sign/collate (or use `hardhat/simulate.js` for speed) | LGA 1 and LGA 2 Approved. |
| 14 | #1 State Returning Officer + 3 state agents | Confirm EC8D, sign | State Approved; auditor notified. |
| 15 | #2 Independent Auditor | Show the readiness checklist and the full chain trace; upload the report; **1. Sign digest**, **2. Record on-chain** | Show `auditDigest()` in the UI; explain ecrecover. `Audit approval recorded` banner. |
| 16 | #3 Result Publisher | Before step 15 the button was blocked with *AuditNotApproved*; now **Declare the final result** | Phase → Declared. |
| 17 | *(no wallet)* | Public tab: declared result card, winner, audit signature, hash; click any unit and show "recomputed sum matches" | Public verifiability (Section 6.5). |

Talking points per objective (Section 1.3.2):

1. **Hierarchical architecture with nine roles** — the role switcher lists every category; try an action
   from the wrong role (e.g. the auditor clicking sign) to show the contract-level rejection.
2. **Automatic mathematical validation** — steps 2–3.
3. **Multi-party digital signatures bound to figures** — steps 4, 7–8 and the hash badge.
4. **On-chain dispute management** — steps 5–7 (and the escalation branch: officer confirms the original
   instead, agent escalates, auditor dismisses/upholds).
5. **Independent auditor gate** — steps 15–16.
6. **Role-specific portals** — one per row above.
7. **Evaluation** — `docs/EVALUATION.md` (gas, throughput, latency), `docs/SECURITY_STRIDE.md`, test suites.
