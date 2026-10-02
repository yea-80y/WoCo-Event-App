/** Where a make-main keeps grants still to register, per account (#746 step 4). Its
 *  own module so the sign-in path can check for one without loading `make-main.ts`. */
export const makeMainPendingKey = (parent: string): string => `woco:make-main:${parent.toLowerCase()}`;
