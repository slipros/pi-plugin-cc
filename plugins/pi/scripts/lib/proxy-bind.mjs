/**
 * Where a per-run proxy listens, and why the container can reach it there.
 *
 * Loopback: the container arrives through `host.docker.internal`, and on Docker
 * Desktop that path lands on the host's own loopback (measured: connections show
 * up with local and remote address both 127.0.0.1). Binding wider would put a
 * listener holding real credentials on every interface for the sake of a
 * reachability problem that does not exist.
 *
 * What does exist is a race. The forwarder that carries those connections
 * notices a new listening socket with a delay — measured here at under 300ms,
 * with a request ~320ms after `listen` failing to connect and one at ~580ms
 * succeeding. Hence `PROXY_SETTLE_MS`: a run waits it out once, before the
 * container starts, instead of failing its first model call or fetch.
 */
export const PROXY_BIND_ADDRESS = process.env.PI_PROXY_BIND || "127.0.0.1";

/**
 * Grace period before the container may dial a freshly bound proxy.
 *
 * `?? 1000` rather than `|| 1000` so an explicit `PI_PROXY_SETTLE_MS=0` turns
 * the wait off, as documented — `||` treated 0 as "unset" and forced the
 * default back on. A negative or unparseable value falls back to the default.
 */
function resolveSettleMs() {
  const raw = process.env.PI_PROXY_SETTLE_MS;
  if (raw == null || raw.trim() === "") {
    return 1000;
  }
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= 0 ? value : 1000;
}

export const PROXY_SETTLE_MS = resolveSettleMs();

/**
 * Give the port forwarder time to pick up the listeners this run just opened.
 *
 * A no-op when the run has no proxy: the wait exists for the hop into the
 * container, not for the host.
 */
export async function settleProxyPorts(...proxies) {
  if (!proxies.some(Boolean) || PROXY_SETTLE_MS <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, PROXY_SETTLE_MS));
}
