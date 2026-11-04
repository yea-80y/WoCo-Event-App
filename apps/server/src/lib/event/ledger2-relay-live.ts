/** Production wiring for the ledger2 relay (`ledger2-relay.ts`). */

import { getActiveChainId, ledger2Address } from "../chain/event-contract.js";
import {
  readChainNowSecs,
  readSeatNonce,
  readSeriesChainState,
  readSlotChainState,
  relayConfigured,
  sendRelayBatch,
  simulateRelayBatch,
  verifyRelayCode,
  waitRelayReceipt,
} from "../chain/ledger2-relay-chain.js";
import { cancellationGate } from "./cancellations.js";
import { invalidateChainEnd } from "./end-date-guard.js";
import { lookupOnChainEventId, registrationContractFor } from "./onchain-registry.js";
import { claimRelaySeats, holdsFor } from "./reservation-store.js";
import type { Ledger2RelayDeps, RelayTx } from "./ledger2-relay.js";
import type { TransactionResponse } from "ethers";

export const liveLedger2RelayDeps: Ledger2RelayDeps = {
  activeChainId: getActiveChainId,
  ledger2Address,
  registration(eventId, seriesId) {
    const onChainEventId = lookupOnChainEventId(eventId, seriesId);
    const contract = registrationContractFor(eventId, seriesId);
    return onChainEventId && contract ? { onChainEventId, contract } : null;
  },
  relayConfigured,
  verifyCode: verifyRelayCode,
  chainNow: readChainNowSecs,
  seriesState: readSeriesChainState,
  slotState: readSlotChainState,
  seatNonce: readSeatNonce,
  holds: holdsFor,
  claimSeats: claimRelaySeats,
  cancellationGate,
  simulate: simulateRelayBatch,
  send: sendRelayBatch,
  waitReceipt: (tx: RelayTx, ms: number) => waitRelayReceipt(tx as TransactionResponse, ms),
  onExtended: invalidateChainEnd,
  log: (msg) => console.log(msg),
};
