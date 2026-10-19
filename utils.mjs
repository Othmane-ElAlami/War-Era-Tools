/* ─── Helpers ─── */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const rand = (lo, hi) => Math.floor(Math.random() * (hi - lo + 1)) + lo;
export const delay = () => sleep(rand(1500, 3000));

export function log(tag, status, msg = "") {
  const ts = new Date().toLocaleTimeString();
  console.log(`[${ts}] [${tag.padEnd(12)}] [${status.padEnd(8)}] ${msg}`);
}
