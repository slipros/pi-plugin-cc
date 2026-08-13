/**
 * Which address a per-run proxy listens on.
 *
 * Loopback is the address you would pick — and it does not work. `host-gateway`
 * resolves to the address of the bridge the container sits behind (or, under
 * Docker Desktop, of the VM's network), never to the host's own loopback, so a
 * listener on 127.0.0.1 is reachable from the host and from nowhere else:
 * verified on WSL2 + Docker Desktop, where a container reached a proxy bound to
 * 0.0.0.0 through `host.docker.internal` and got "Couldn't connect to server"
 * against the identical proxy bound to loopback.
 *
 * What keeps the listener safe is therefore the run token, not the interface:
 * every proxy here refuses a request before touching a credential unless the
 * token matches, and the token is minted per run and dies with it. Override with
 * PI_PROXY_BIND on a host where the container reaches loopback (Docker Desktop
 * on macOS) or where a specific bridge address is preferable.
 */
export const PROXY_BIND_ADDRESS = process.env.PI_PROXY_BIND || "0.0.0.0";
