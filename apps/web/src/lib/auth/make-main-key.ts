/** A linked passkey whose own envelope still has to be written (#746 step 4). */
export const linkedEnvelopePendingKey = (seedAddress: string): string =>
  `woco:linked-envelope:${seedAddress.toLowerCase()}`;
