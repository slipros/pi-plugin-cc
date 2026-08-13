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

/** Grace period before the container may dial a freshly bound proxy. */
export const PROXY_SETTLE_MS = Number.parseInt(process.env.PI_PROXY_SETTLE_MS ?? "", 10) || 1000;

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
