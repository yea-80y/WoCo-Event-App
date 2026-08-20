#!/usr/bin/env node
// Dev wrapper: opens an SSH tunnel to the Hetzner bee container, then runs
// tsx watch. Tunnel is a child process — when this script exits (Ctrl-C,
// tsx crash, terminal close), the tunnel dies with it. No daemons.

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const HOST = process.env.WOCO_BEE_HOST ?? "root@46.225.174.72";
const LOCAL_PORT = Number(process.env.WOCO_BEE_LOCAL_PORT ?? 1633);
const CONTAINER = process.env.WOCO_BEE_CONTAINER ?? "bee-node";
const PROXY_LOCAL_PORT = Number(process.env.WOCO_PROXY_LOCAL_PORT ?? 3000);
const PROXY_CONTAINER = process.env.WOCO_PROXY_CONTAINER ?? "bee-proxy";

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, 500);
  });
}

function resolveContainerIp(container = CONTAINER) {
  // The IP, not the name. `bee-proxy` / `bee-node` resolve only INSIDE the
  // docker network, and ssh binds its forward on the VM's HOST, where those
  // names mean nothing — a `-L` to a docker name silently yields a tunnel that
  // accepts connections and carries no traffic (curl reports HTTP 000).
  const r = spawnSync("ssh", [
    "-o", "ConnectTimeout=5",
    HOST,
    `docker inspect ${container} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
  ], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}

let tunnel = null;
let tunnelledProxy = false;
function cleanup() {
  if (tunnel && !tunnel.killed) tunnel.kill("SIGTERM");
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

if (await portInUse(LOCAL_PORT)) {
  console.log(`[dev-tunnel] localhost:${LOCAL_PORT} already listening — reusing`);
} else {
  console.log(`[dev-tunnel] resolving ${CONTAINER} IP on ${HOST}...`);
  const ip = resolveContainerIp();
  if (!ip) {
    console.warn(`[dev-tunnel] could not resolve container IP — server will rely on BEE_URL_FALLBACK`);
  } else {
    const proxyIp = resolveContainerIp(PROXY_CONTAINER);
    if (!proxyIp) {
      console.warn(`[dev-tunnel] could not resolve ${PROXY_CONTAINER} — whitelisting will use PROXY_URL from .env and may be RATE LIMITED (50/15min)`);
    }
    tunnelledProxy = Boolean(proxyIp);
    console.log(`[dev-tunnel] ${CONTAINER} -> ${ip}, opening localhost:${LOCAL_PORT}`);
    // TWO forwards. bee (1633) is the obvious one. The PROXY (3000) matters for a
    // reason that is easy to miss: the gateway whitelists a chunk's address at
    // write time, and since 2026-08-20 that call is FATAL — an unwhitelisted
    // chunk now reads as ABSENT to clients, so a write we cannot make readable
    // is refused rather than published.
    //
    // The proxy exempts local callers from its rate limiters, but only by SOURCE
    // IP. Calling it over the public internet (PROXY_URL=https://gateway...)
    // means dev is NOT exempt, and its admin limiter is 50 requests per 15
    // minutes — so a dev session doing more than ~50 writes started failing them
    // outright. Through this tunnel the request reaches the proxy from
    // 127.0.0.1 on the VM, which IS exempt, so dev behaves like production.
    tunnel = spawn("ssh", [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=60",
      "-L", `${LOCAL_PORT}:${ip}:1633`,
      ...(proxyIp ? ["-L", `${PROXY_LOCAL_PORT}:${proxyIp}:3000`] : []),
      HOST,
    ], { stdio: ["ignore", "inherit", "inherit"] });

    tunnel.on("exit", (code, signal) => {
      // If the tunnel dies while dev is running, surface it but keep dev alive.
      if (signal !== "SIGTERM") {
        console.warn(`[dev-tunnel] ssh exited (code=${code} signal=${signal}) — bee reads/writes will fail until you restart`);
      }
    });

    // Wait briefly for the bind, then continue regardless.
    for (let i = 0; i < 20; i++) {
      if (await portInUse(LOCAL_PORT)) {
        console.log(`[dev-tunnel] tunnel up (pid ${tunnel.pid})`);
        break;
      }
      if (tunnel.killed || tunnel.exitCode !== null) {
        console.warn(`[dev-tunnel] ssh exited before tunnel was ready`);
        tunnel = null;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// Route whitelisting through the tunnel by default (see the two-forward comment
// above). An explicit PROXY_URL in the environment still wins, so anyone who
// needs the public gateway can say so.
const devEnv = { ...process.env };
if (tunnel && tunnelledProxy && !process.env.PROXY_URL_EXPLICIT) {
  devEnv.PROXY_URL = `http://localhost:${PROXY_LOCAL_PORT}`;
  console.log(`[dev-tunnel] PROXY_URL -> ${devEnv.PROXY_URL} (rate-limit exempt; set PROXY_URL_EXPLICIT=1 to keep .env's value)`);
}
const tsx = spawn("npx", ["tsx", "watch", "src/index.ts"], { stdio: "inherit", env: devEnv });
tsx.on("exit", (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
