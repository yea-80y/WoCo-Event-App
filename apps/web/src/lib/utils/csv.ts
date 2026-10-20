/**
 * Writing CSV files people open in a spreadsheet: the one helper every export
 * uses (guest lists, the contact list), so the safety rules live in one place.
 *
 * The cells hold text other people typed - attendee names, order-form answers,
 * imported rows - so a cell is untrusted. A spreadsheet runs a cell that starts
 * with `=`, `+`, `-` or `@` as a formula (OWASP "CSV injection"), and tab or CR
 * at the start lets one slip past that check in some apps. Such a cell is
 * written with a leading `'`, which spreadsheets read as "this is text".
 */

/** First characters a spreadsheet may read as the start of a formula. */
const FORMULA_START = /^[=+\-@\t\r]/;

/** UTF-8 byte order mark: without it Excel reads the file as ANSI and mangles accents. */
export const CSV_BOM = "﻿";

/** One cell: formula-guarded, then quoted per RFC 4180 when it needs it. */
export function csvCell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole file: BOM, CRLF line ends (RFC 4180), every cell through {@link csvCell}. */
export function buildCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  return CSV_BOM + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/**
 * Undo {@link csvCell}'s guard when reading a file back in, so our own export
 * re-imports unchanged ("+44 7700 900123" stays a phone number, not "'+44...").
 * Only a `'` followed by a guarded character is removed: that is exactly what
 * the guard adds, and a real value of that shape is vanishingly rare.
 */
export function unguardCsvCell(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

/** Hand the browser a CSV file to save. Nothing leaves the device. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoked later, not straight after click(): that can cancel the save in some browsers (FileSaver waits 40 s).
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
