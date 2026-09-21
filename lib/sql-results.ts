// RFC 4180 formatting for SQL result grids.
export function toCsv(columns: string[], rows: (string | null)[][]) {
  // SQL NULL becomes an empty field. CSV cannot distinguish it from an empty
  // string, so the JSON view remains the lossless way to copy results.
  const cell = (value: string | null) => value === null ? "" : /["\r\n,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
  return [columns, ...rows].map(row => row.map(cell).join(",")).join("\r\n");
}
