#!/usr/bin/env node
// Dev wrapper: opens an SSH tunnel to the Hetzner bee container, then runs
// tsx watch. Tunnel is a child process — when this script exits (Ctrl-C,
// tsx crash, terminal close), the tunnel dies with it. No daemons.

import { spawn, spawnSync } from "node:child_process";
import { createConnection } from "node:net";

const HOST = process.env.WOCO_BEE_HOST ?? "root@46.225.174.72";
const LOCAL_PORT = Number(process.env.WOCO_BEE_LOCAL_PORT ?? 1633);
const CONTAINER = process.env.WOCO_BEE_CONTAINER ?? "bee-node";

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = createConnection(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
    setTimeout(() => { socket.destroy(); resolve(false); }, 500);
  });
}

function resolveContainerIp() {
  const r = spawnSync("ssh", [
    "-o", "ConnectTimeout=5",
    HOST,
    `docker inspect ${CONTAINER} --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}'`,
  ], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const ip = r.stdout.trim();
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : null;
}

let tunnel = null;
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
    console.log(`[dev-tunnel] ${CONTAINER} -> ${ip}, opening localhost:${LOCAL_PORT}`);
    tunnel = spawn("ssh", [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=60",
      "-L", `${LOCAL_PORT}:${ip}:1633`,
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

const tsx = spawn("npx", ["tsx", "watch", "src/index.ts"], { stdio: "inherit" });
tsx.on("exit", (code, signal) => {
  cleanup();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
