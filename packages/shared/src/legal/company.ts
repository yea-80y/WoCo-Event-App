/**
 * The operating company, as UK trading-disclosure rules require it on the
 * website and on business email: registered name, where it is registered, its
 * number and its registered office (Companies Act 2006; SI 2015/17 reg. 25).
 *
 * One constant so every email, page and legal document says the same thing.
 */
export const WOCO_COMPANY = {
  name: "WoCo Network Ltd",
  number: "17370809",
  registeredIn: "England and Wales",
  registeredOffice: "128 City Road, London EC1V 2NX, United Kingdom",
} as const;

/** The whole disclosure on one line. */
export const WOCO_COMPANY_LINE =
  `${WOCO_COMPANY.name} · Registered in ${WOCO_COMPANY.registeredIn}, company number ${WOCO_COMPANY.number}` +
  ` · ${WOCO_COMPANY.registeredOffice}`;
