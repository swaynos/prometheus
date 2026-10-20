export function exportRows(rows, { format = 'json' } = {}) {
  if (!['json', 'csv'].includes(format)) throw new Error('Unknown format.');
  if (!Array.isArray(rows) || !rows.every(row => row !== null && typeof row === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(row)) &&
    Object.values(row).every(value => value === null || ['string', 'boolean'].includes(typeof value) || typeof value === 'number' && Number.isFinite(value)))) {
    throw new Error('Input must be an array of objects with scalar values.');
  }
  if (format === 'json') return `${JSON.stringify(rows)}\n`;
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  const field = value => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [columns, ...rows.map(row => columns.map(key => Object.hasOwn(row, key) ? row[key] : undefined))].map(row => `${row.map(field).join(',')}\r\n`).join('');
}
