/// <reference lib="webworker" />
/**
 * Opens the organiser's sealed orders off the page's thread (#965). All logic is in
 * `order-opener-core.ts`; this file only connects it to the worker's messages.
 */
import { orderSealContext } from "@woco/shared/crypto/sealed-box";
import { openJsonWithAnyKey } from "../../keyring/order-keys.js";
import { createOpenerCore, type OpenerReply, type OpenerRequest } from "./order-opener-core.js";

const scope = self as unknown as DedicatedWorkerGlobalScope;
const handle = createOpenerCore({
  open: openJsonWithAnyKey,
  context: orderSealContext,
  post: (reply: OpenerReply) => scope.postMessage(reply),
  close: () => scope.close(),
});
scope.onmessage = (e: MessageEvent<OpenerRequest>) => void handle(e.data);
