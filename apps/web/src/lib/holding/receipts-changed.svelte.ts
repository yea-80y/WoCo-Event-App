/**
 * A counter a screen that lists receipts reads, bumped when the automatic collection
 * saved or erased something (`collect-live.ts`): Profile > Tickets then reads its marks
 * again. Imports nothing, so a screen can read it without loading the collection.
 */
export const receiptsChanged = $state({ n: 0 });

export function bumpReceiptsChanged(): void {
  receiptsChanged.n++;
}
