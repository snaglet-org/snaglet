/**
 * One tab-separated cell, quoted when it holds a tab, line break or quote, the
 * way spreadsheets read TSV. Shared by every copy that writes rows as text
 * (table rows, markdown tables).
 */
export function tsvCell(text: string): string {
  return /[\t\n\r"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
