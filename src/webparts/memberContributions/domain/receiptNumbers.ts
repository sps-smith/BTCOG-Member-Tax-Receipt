export const receiptRangeStarts: number[] = Array.from({ length: 9 }, (_, index) => (index + 1) * 100000);

export function validateRange(start: number): void {
  if (receiptRangeStarts.indexOf(start) < 0) throw new Error('Select a receipt start range from 100000 through 900000.');
}

export function receiptParts(number: number): { year: number; sequence: number; rangeStart: number } {
  if (!Number.isSafeInteger(number)) throw new Error('Invalid receipt number.');
  const year = Math.floor(number / 1000000);
  const sequence = number % 1000000;
  const rangeStart = Math.floor(sequence / 100000) * 100000;
  if (year < 1000 || year > 9999) throw new Error('Invalid receipt year.');
  validateRange(rangeStart);
  return { year, sequence, rangeStart };
}

export function makeReceiptNumber(year: number, sequence: number): number {
  const number = year * 1000000 + sequence;
  const parts = receiptParts(number);
  if (parts.year !== year || parts.sequence !== sequence) throw new Error('Receipt range is exhausted.');
  return number;
}

export function formatReceiptNumber(number: number): string {
  const parts = receiptParts(number);
  return `${parts.year}-${String(parts.sequence).padStart(6, '0')}`;
}
