import { ethers } from "ethers";
import { RULES, RULE_TEXT } from "./constants.js";

/** Blank figures object for `n` candidates. */
export function emptyFigures(n) {
  return { registeredVoters: "", accreditedVoters: "", totalVotesCast: "", validVotes: "", rejectedVotes: "", candidateVotes: Array.from({ length: n }, () => "") };
}

/** Converts form strings/numbers into BigInt-based figures suitable for a contract call. */
export function toChainFigures(f) {
  const b = (v) => BigInt(String(v ?? "").trim() === "" ? 0 : String(v).trim());
  return {
    registeredVoters: b(f.registeredVoters),
    accreditedVoters: b(f.accreditedVoters),
    totalVotesCast: b(f.totalVotesCast),
    validVotes: b(f.validVotes),
    rejectedVotes: b(f.rejectedVotes),
    candidateVotes: (f.candidateVotes ?? []).map(b),
  };
}

export function fromChainFigures(f) {
  return {
    registeredVoters: Number(f.registeredVoters),
    accreditedVoters: Number(f.accreditedVoters),
    totalVotesCast: Number(f.totalVotesCast),
    validVotes: Number(f.validVotes),
    rejectedVotes: Number(f.rejectedVotes),
    candidateVotes: Array.from(f.candidateVotes).map(Number),
  };
}

export function isComplete(f) {
  const vals = [f.registeredVoters, f.accreditedVoters, f.totalVotesCast, f.validVotes, f.rejectedVotes, ...(f.candidateVotes ?? [])];
  return vals.every((v) => String(v ?? "").trim() !== "" && /^\d+$/.test(String(v).trim()));
}

/**
 * Client-side mirror of VoteChainTypes.checkFigures (Table 3.2) so the officer sees which rule
 * a figure violates *before* a transaction is sent. The contract remains the authority.
 */
export function checkFigures(input, candidateCount, registerValue = 0) {
  const f = toChainFigures(input);
  const results = [];
  const rule = (name, pass, detail) => results.push({ name, text: RULE_TEXT[name], pass, detail });

  rule("CastExceedsAccredited", f.totalVotesCast <= f.accreditedVoters, `${f.totalVotesCast} cast vs ${f.accreditedVoters} accredited`);
  rule("CastExceedsRegistered", f.totalVotesCast <= f.registeredVoters, `${f.totalVotesCast} cast vs ${f.registeredVoters} registered`);
  rule("ValidPlusRejectedMismatch", f.validVotes + f.rejectedVotes === f.totalVotesCast, `${f.validVotes} + ${f.rejectedVotes} = ${f.validVotes + f.rejectedVotes} vs ${f.totalVotesCast} cast`);
  const sum = f.candidateVotes.reduce((s, v) => s + v, 0n);
  rule("CandidateSumMismatch", f.candidateVotes.length === candidateCount && sum === f.validVotes, `candidates sum to ${sum} vs ${f.validVotes} valid`);
  rule("AccreditedExceedsRegistered", f.accreditedVoters <= f.registeredVoters, `${f.accreditedVoters} accredited vs ${f.registeredVoters} registered`);
  if (registerValue) rule("RegisterMismatch", f.registeredVoters === BigInt(registerValue), `${f.registeredVoters} entered vs ${registerValue} in the INEC register`);

  const firstFail = results.find((r) => !r.pass);
  return { ok: !firstFail, rules: results, violated: firstFail?.name ?? RULES[0] };
}

/** keccak256(abi.encode(level, unitId, ...figures, formCid)) — identical to VoteChainTypes.figuresHash. */
export function figuresHash(levelIndex, unitId, figures, formCid) {
  const f = toChainFigures(figures);
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return ethers.keccak256(
    coder.encode(
      ["uint8", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256", "uint256[]", "string"],
      [levelIndex, unitId, f.registeredVoters, f.accreditedVoters, f.totalVotesCast, f.validVotes, f.rejectedVotes, f.candidateVotes, formCid],
    ),
  );
}

export function sumFigures(list, candidateCount) {
  const acc = { registeredVoters: 0, accreditedVoters: 0, totalVotesCast: 0, validVotes: 0, rejectedVotes: 0, candidateVotes: Array.from({ length: candidateCount }, () => 0) };
  for (const f of list) {
    if (!f) continue;
    acc.registeredVoters += Number(f.registeredVoters);
    acc.accreditedVoters += Number(f.accreditedVoters);
    acc.totalVotesCast += Number(f.totalVotesCast);
    acc.validVotes += Number(f.validVotes);
    acc.rejectedVotes += Number(f.rejectedVotes);
    f.candidateVotes.forEach((v, i) => (acc.candidateVotes[i] += Number(v)));
  }
  return acc;
}
