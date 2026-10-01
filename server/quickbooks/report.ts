/**
 * Reading repair & maintenance spend out of a QuickBooks Profit and Loss
 * report summarized by class.
 *
 * Why this report rather than adding up transactions: it is the figure
 * QuickBooks itself shows SPO's bookkeeper, on the company's own accounting
 * basis, and it already folds in every transaction type that can hit an
 * expense account (bills, checks, expenses, credit card charges, journal
 * entries, vendor credits) and every split line. Adding up transactions by
 * hand would mean querying each of those types and re-implementing that
 * logic; one report call per fiscal year covers every house at once.
 *
 * Pure: a parsed report in, cents per column out, so the whole thing is tested
 * against fixtures without QuickBooks.
 *
 * The report's shape, as far as this file relies on it:
 *   - `Columns.Column[]`: the first is the account name; then one Money column
 *     per class, whose `MetaData` holds `{ Name: "ColKey", Value: <class id> }`,
 *     then "Not Specified" and "Total".
 *   - `Rows.Row[]`: nested. A plain account is a `Data` row whose first cell
 *     carries the account `id`. An account with sub-accounts is a `Section`
 *     whose `Header` carries the id and whose `Summary` totals it with its
 *     sub-accounts.
 */

export interface ReportCell {
  value?: string;
  id?: string;
}

export interface ReportRow {
  type?: string;
  ColData?: ReportCell[];
  Header?: { ColData?: ReportCell[] };
  Rows?: { Row?: ReportRow[] };
  Summary?: { ColData?: ReportCell[] };
}

export interface ProfitAndLossReport {
  Columns?: { Column?: Array<{ ColTitle?: string; ColType?: string; MetaData?: Array<{ Name?: string; Value?: string }> }> };
  Rows?: { Row?: ReportRow[] };
}

export interface SpendColumn {
  /** QuickBooks's id for the class, when the report gives one. */
  key: string | null;
  title: string;
  /** Repair & maintenance spend in this column, in cents. */
  cents: number;
}

/** "1,234.56", "-20.00", "" -> cents. */
function toCents(value: string | undefined): number {
  if (!value) return 0;
  const n = Number(value.replace(/,/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * The spend on the chosen accounts, per report column. A chosen account that
 * is a parent counts once, with its sub-accounts, through its section total; a
 * chosen sub-account under a chosen parent is therefore not counted twice.
 */
export function repairSpendByColumn(report: ProfitAndLossReport, accountIds: ReadonlySet<string>): SpendColumn[] {
  const columns = report.Columns?.Column ?? [];
  const totals = new Array<number>(columns.length).fill(0);

  const add = (cells: ReportCell[] | undefined) => {
    if (!cells) return;
    for (let i = 1; i < columns.length; i++) totals[i] += toCents(cells[i]?.value);
  };

  const walk = (rows: ReportRow[] | undefined) => {
    for (const row of rows ?? []) {
      const sectionAccount = row.Header?.ColData?.[0]?.id;
      if (sectionAccount && accountIds.has(sectionAccount)) {
        add(row.Summary?.ColData);
        continue;
      }
      const dataAccount = row.ColData?.[0]?.id;
      if (row.type === "Data" && dataAccount && accountIds.has(dataAccount)) {
        add(row.ColData);
        continue;
      }
      walk(row.Rows?.Row);
    }
  };
  walk(report.Rows?.Row);

  return columns.slice(1).map((column, i) => ({
    key: column.MetaData?.find((m) => m.Name === "ColKey")?.Value ?? null,
    title: column.ColTitle ?? "",
    cents: totals[i + 1],
  }));
}

/**
 * The cents for one house's class: matched on QuickBooks's id, or on the name
 * when the report carries no id. A class with no activity in the period is
 * absent from the report, which is spend of zero, not missing data.
 */
export function centsForClass(columns: SpendColumn[], classId: string, className: string): number {
  const byId = columns.find((c) => c.key === classId);
  if (byId) return byId.cents;
  const byName = columns.find((c) => c.key === null && c.title.trim().toLowerCase() === className.trim().toLowerCase());
  return byName?.cents ?? 0;
}
