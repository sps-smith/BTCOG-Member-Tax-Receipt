import { AnnualContribution, Calculation, Member, Transaction } from '../models';
import { formatReceiptNumber, receiptParts } from './receiptNumbers';
import { receiptSignatureDataUrl, receiptSignerName, receiptSignerTitle } from './signature';

export function availableYears(now: Date = new Date()): number[] {
  const year = now.getFullYear();
  return Array.from({ length: 5 }, (_, index) => year - index);
}

export function calculateContributions(
  transactions: Transaction[], members: Member[], year: number, includeNonPositive: boolean = false
): Calculation {
  const totals = new Map<number, number>();
  let ignoredTransactions = 0;
  for (const transaction of transactions) {
    // SharePoint returns site-local dates via CamlQuery.DatesInUtc=false. Preserve their calendar date.
    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?$)/.exec(transaction.date);
    if (!match) throw new Error('A revenue transaction has an invalid date.');
    const dateYear = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    const calendarDate = new Date(Date.UTC(dateYear, month - 1, day));
    if (calendarDate.getUTCFullYear() !== dateYear || calendarDate.getUTCMonth() !== month - 1 || calendarDate.getUTCDate() !== day) {
      throw new Error('A revenue transaction has an invalid date.');
    }
    if (dateYear !== year) continue;
    if (!transaction.memberId) { ignoredTransactions++; continue; }
    if (!Number.isSafeInteger(transaction.memberId) || transaction.memberId < 1) {
      throw new Error('A revenue transaction has an invalid member reference.');
    }
    const amount = transaction.amount;
    const cents = Math.round(amount * 100);
    if (!Number.isFinite(amount) || !Number.isSafeInteger(cents) || Math.abs(amount * 100 - cents) > 0.00001) {
      throw new Error('A revenue transaction has an invalid amount or more than two decimal places.');
    }
    const total = (totals.get(transaction.memberId) || 0) + cents;
    if (!Number.isSafeInteger(total)) throw new Error('A member contribution exceeds the supported amount.');
    totals.set(transaction.memberId, total);
  }
  const names = new Map(members.map(member => [member.id, member.name]));
  const contributions: AnnualContribution[] = [];
  totals.forEach((cents, memberId) => {
    if (cents <= 0 && !includeNonPositive) return;
    const memberName = names.get(memberId);
    if (!memberName || !memberName.trim()) {
      throw new Error(`Member ${memberId} has contributions but no matching member name. No records were replaced.`);
    }
    if (memberName.trim().length > 255) throw new Error(`Member ${memberId} has a name longer than 255 characters. No records were replaced.`);
    contributions.push({ memberId, memberName: memberName.trim(), cents, year });
  });
  contributions.sort((a, b) => a.memberName.localeCompare(b.memberName) || a.memberId - b.memberId);
  return { contributions, ignoredTransactions };
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    const entities: { [key: string]: string } = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

export function receiptHtml(records: AnnualContribution[], currency: string): string {
  if (records.some(record => record.receiptNumber === undefined || receiptParts(record.receiptNumber).year !== record.year || record.cents <= 0)) {
    throw new Error('Only positive contribution records with a valid receipt number can be printed.');
  }
  const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Member contribution receipts</title>
  <style>body{font:16px Arial,sans-serif;color:#172b3a;margin:0;background:#eee}
  .toolbar{padding:16px;text-align:center}button{font:inherit;padding:10px 20px;cursor:pointer}
  .receipt{box-sizing:border-box;background:white;max-width:8.5in;min-height:10in;margin:20px auto;padding:0.75in}
  h1{font-size:23px;margin-bottom:8px}h2{font-size:20px;font-weight:normal;margin-top:0}
  .name{font-size:22px;margin-top:64px}.amount{font-size:20px;margin:32px 0}
  p{line-height:1.6}@page{size:letter;margin:0.65in}
  @media print{body{background:white}.toolbar{display:none}.receipt{margin:0;padding:0;min-height:0;max-width:none;break-after:page;page-break-after:always}.receipt:last-child{break-after:auto;page-break-after:auto}}
  .signature{margin-top:48px;max-width:320px;break-inside:avoid;page-break-inside:avoid}
  .signature img{display:block;width:280px;max-width:100%;height:auto;margin-bottom:12px}
  .signature p{margin:0;line-height:1.5}.signature .signer{font-weight:bold}
  </style></head><body><div class="toolbar"><button id="print" disabled>Loading signature…</button></div>
  ${records.map(record => `<article class="receipt"><h1>Triumphant Church of God – 11925 9869 RR 0001</h1>
  <h2>Contribution Receipt for ${record.year}</h2><p>Receipt Number: <strong>${formatReceiptNumber(record.receiptNumber as number)}</strong></p><p class="name">${escapeHtml(record.memberName)}</p>
  <p class="amount">Total contribution: <strong>${escapeHtml(money.format(record.cents / 100))}</strong></p>
  <p>Thank you for your generous contributions during ${record.year}. Your support helps sustain the ministry of Triumphant Church of God.</p>
  <div class="signature"><img src="${receiptSignatureDataUrl}" width="680" height="180" alt="Signature of ${escapeHtml(receiptSignerName)}" />
  <p>${escapeHtml(receiptSignerTitle)}</p><p class="signer">${escapeHtml(receiptSignerName)}</p></div>
  </article>`).join('')}</body></html>`;
}
