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

/** Rows to CSV text, every cell through `csvCell`. Pure. */
export function toCsv(rows: readonly (readonly (string | null | undefined)[])[]): string {
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/**
 * Hands the browser a CSV to save. The one place a download link is built,
 * so every export (former residents, the roster template) is offered the
 * same way and the object URL is always released.
 */
export function downloadCsv(filename: string, rows: readonly (readonly (string | null | undefined)[])[]): void {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
