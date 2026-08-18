/**
 * The two partitions a rider's credit can live in.
 *
 * Its own module so the pure `partition.ts` can name it without importing
 * `credits.ts`, which reaches the auth store and cannot load under plain node.
 */
export type CreditVisibility = "private" | "public";
