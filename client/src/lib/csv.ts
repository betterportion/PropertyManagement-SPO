/**
 * One cell of a CSV the user opens in a spreadsheet. A leading = + - @ makes
 * Excel or Sheets run the cell as a formula, and names can arrive from an
 * imported CSV, so those get an apostrophe that keeps them text.
 */
export function csvCell(value: string | null | undefined): string {
  const raw = String(value ?? "");
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
