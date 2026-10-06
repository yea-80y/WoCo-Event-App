/**
 * Listing an organiser's names (#782).
 *
 * `getOwnedLabels` scanned `Transfer` logs from block 0, which the public
 * Arbitrum RPC now refuses (`only 10000000 are allowed`), so
 * `/api/sub-ens/owned` answered 500 on every call. The scan now starts at the
 * registry's deploy block and walks windows the RPC accepts. The end-to-end
 * test runs the real function against a fake RPC that enforces the same cap.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SUB_ENS_DEPLOYMENTS } from "@woco/shared";
import {
  LOG_SCAN_WINDOW,
  getOwnedLabels,
  logScanWindows,
  registryScanStartBlock,
} from "../src/lib/chain/sub-ens-contract.js";

const MAINNET = SUB_ENS_DEPLOYMENTS[42161];

function assertCovers(windows: Array<[number, number]>, start: number, latest: number): void {
  assert.equal(windows[0]![0], start, "starts where asked");
  assert.equal(windows.at(-1)![1], latest, "ends at latest");
  for (const [i, [from, to]] of windows.entries()) {
    assert.ok(to >= from, `window ${i} is not empty`);
    assert.ok(to - from + 1 <= LOG_SCAN_WINDOW, `window ${i} spans ${to - from + 1} blocks`);
    if (i > 0) assert.equal(from, windows[i - 1]![1] + 1, `window ${i} leaves no gap and no overlap`);
  }
}

test("windows cover start..latest exactly, none wider than the RPC allows", () => {
  for (const [start, latest] of [
    [0, 0],
    [100, 100 + LOG_SCAN_WINDOW - 1],
    [100, 100 + LOG_SCAN_WINDOW],
    [MAINNET.deployBlock, MAINNET.deployBlock + 3 * LOG_SCAN_WINDOW + 7],
  ] as const) {
    assertCovers(logScanWindows(start, latest), start, latest);
  }
  assert.equal(logScanWindows(100, 100 + LOG_SCAN_WINDOW - 1).length, 1, "a full window is one call");
});

test("a start past latest scans nothing", () => {
  assert.deepEqual(logScanWindows(10, 9), []);
});

test("the scan starts at the registry's deploy block, and at genesis for a registry this build does not know", () => {
  const saved = process.env.SUB_ENS_REGISTRY_ADDRESS;
  try {
    delete process.env.SUB_ENS_REGISTRY_ADDRESS;
    assert.equal(registryScanStartBlock(42161), MAINNET.deployBlock);
    process.env.SUB_ENS_REGISTRY_ADDRESS = MAINNET.registry.toLowerCase();
    assert.equal(registryScanStartBlock(42161), MAINNET.deployBlock, "same registry, different case");
    process.env.SUB_ENS_REGISTRY_ADDRESS = "0x00000000000000000000000000000000000000aa";
    assert.equal(registryScanStartBlock(42161), 0, "a starting block for another contract would skip its names");
  } finally {
    if (saved === undefined) delete process.env.SUB_ENS_REGISTRY_ADDRESS;
    else process.env.SUB_ENS_REGISTRY_ADDRESS = saved;
  }
});

test("getOwnedLabels lists through an RPC that refuses wide log queries", async () => {
  const latest = MAINNET.deployBlock + 2 * LOG_SCAN_WINDOW + 12_345;
  const ranges: Array<[number, number]> = [];

  const answer = (req: { id: unknown; method: string; params?: unknown[] }) => {
    switch (req.method) {
      case "eth_chainId": return { jsonrpc: "2.0", id: req.id, result: "0xa4b1" };
      case "eth_blockNumber": return { jsonrpc: "2.0", id: req.id, result: "0x" + latest.toString(16) };
      case "eth_getLogs": {
        const f = req.params![0] as { fromBlock: string; toBlock: string };
        const from = Number(f.fromBlock), to = Number(f.toBlock);
        const span = to - from + 1;
        if (span > LOG_SCAN_WINDOW) {
          return { jsonrpc: "2.0", id: req.id, error: {
            code: -32602,
            message: `query spans ${span} blocks (${from} to ${to}), but only ${LOG_SCAN_WINDOW} are allowed for this request; narrow the block range`,
          } };
        }
        ranges.push([from, to]);
        return { jsonrpc: "2.0", id: req.id, result: [] };
      }
      default: return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `unexpected ${req.method}` } };
    }
  };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(answer) : answer(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

  const saved = { rpc: process.env.RPC_URL_42161, chain: process.env.SUB_ENS_CHAIN_ID, reg: process.env.SUB_ENS_REGISTRY_ADDRESS };
  process.env.RPC_URL_42161 = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  delete process.env.SUB_ENS_CHAIN_ID;
  delete process.env.SUB_ENS_REGISTRY_ADDRESS;
  try {
    assert.deepEqual(await getOwnedLabels("0x00000000000000000000000000000000000000bb"), []);
    assertCovers(ranges, MAINNET.deployBlock, latest);
    assert.equal(ranges.length, 3);
  } finally {
    for (const [k, v] of [["RPC_URL_42161", saved.rpc], ["SUB_ENS_CHAIN_ID", saved.chain], ["SUB_ENS_REGISTRY_ADDRESS", saved.reg]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
