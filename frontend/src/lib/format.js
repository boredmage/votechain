export function shortAddr(a) {
  if (!a) return "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function fmtTime(ts) {
  if (!ts) return "—";
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function fmtNum(n) {
  if (n === undefined || n === null || n === "") return "—";
  return Number(n).toLocaleString("en-NG");
}

export function pct(part, whole) {
  if (!whole) return "0%";
  return `${((100 * Number(part)) / Number(whole)).toFixed(1)}%`;
}

export function shortHash(h) {
  if (!h) return "—";
  return `${h.slice(0, 10)}…${h.slice(-6)}`;
}
