import { AnnualContribution, ContributionSettings, ReceiptRange } from '../models';
import { makeReceiptNumber, receiptParts, receiptRangeStarts, validateRange } from '../domain/receiptNumbers';
import { Item, RestTransport } from './ContributionService';

export class ReceiptRegistry {
  public constructor(
    private readonly transport: RestTransport,
    private readonly settings: ContributionSettings,
    private readonly list: (title: string) => string,
    private readonly all: (url: string) => Promise<Item[]>
  ) {}
  private items(title: string): string { return `${this.list(title)}/items`; }
  private async records(): Promise<Item[]> {
    return this.all(`${this.items(this.settings.contributionsList)}?$select=Id,MemberNameId,ContributionYear,ReceiptNumber&$filter=ReceiptNumber ne null&$top=5000`);
  }
  private ownership(rows: Item[], owners: Map<number, number>): void {
    for (const row of rows) {
      const year = Number(row.AssignedYear);
      const start = Number(row.Title);
      validateRange(start);
      if (!Number.isInteger(year) || year < 1000 || year > 9999) throw new Error('A receipt range has an invalid assigned year.');
      const previous = owners.get(start);
      if (previous !== undefined && previous !== year) throw new Error(`Receipt range ${start} has conflicting year assignments.`);
      owners.set(start, year);
    }
  }
  public async ranges(): Promise<ReceiptRange[]> {
    const [ranges, existing, assignments] = await Promise.all([
      this.all(`${this.items(this.settings.rangesList)}?$top=5000`), this.records(),
      this.all(`${this.items(this.settings.assignmentsList)}?$top=5000`)
    ]);
    const owners = new Map<number, number>();
    this.ownership(ranges, owners);
    for (const row of [...existing, ...assignments]) {
      if (row.ReceiptNumber === null || row.ReceiptNumber === undefined) continue;
      const parts = receiptParts(Number(row.ReceiptNumber));
      if (parts.year !== Number(row.ContributionYear)) throw new Error(`Contribution item ${row.Id} has a receipt number for the wrong year.`);
      const assigned = owners.get(parts.rangeStart);
      if (assigned !== undefined && assigned !== parts.year) throw new Error(`Range ${parts.rangeStart} is already used across different years. Resolve these historical assignments before generating receipts.`);
      owners.set(parts.rangeStart, parts.year);
    }
    const yearRanges = new Map<number, number>();
    for (const [start, year] of owners) {
      const previous = yearRanges.get(year);
      if (previous !== undefined && previous !== start) {
        throw new Error(`Year ${year} has multiple receipt ranges (${previous} and ${start}). Ask an administrator to resolve the historical range assignments before continuing. Existing receipt numbers must be preserved.`);
      }
      yearRanges.set(year, start);
    }
    return receiptRangeStarts.map(start => ({ start, assignedYear: owners.get(start) }));
  }
  public async checkRange(start: number, year: number): Promise<void> {
    validateRange(start);
    const ranges = await this.ranges();
    const assigned = ranges.find(value => value.assignedYear === year);
    if (assigned && assigned.start !== start) throw new Error(`Year ${year} is assigned to receipt range ${assigned.start}. A year can use only one range; select ${assigned.start}.`);
    const range = ranges.find(value => value.start === start);
    if (range && range.assignedYear !== undefined && range.assignedYear !== year) throw new Error(`Receipt range ${start} belongs to ${range.assignedYear} and cannot be reused for ${year}.`);
  }
  private async reserve(start: number, year: number): Promise<void> {
    const url = `${this.items(this.settings.rangesList)}?$filter=Title eq '${start}'&$top=2`;
    const existing = await this.all(url);
    if (existing.length > 1) throw new Error('Duplicate receipt range registrations exist.');
    if (existing.length) {
      if (Number(existing[0].AssignedYear) !== year) throw new Error(`Receipt range ${start} belongs to another year.`);
      return;
    }
    try { await this.transport.post(this.items(this.settings.rangesList), { Title: String(start), AssignedYear: year }); }
    catch (error) {
      // A unique Title arbitrates simultaneous requests from different years.
      const winner = await this.all(url);
      if (winner.length !== 1 || Number(winner[0].AssignedYear) !== year) throw error;
    }
  }
  private async assignment(memberId: number, year: number, number: number): Promise<void> {
    const key = `${year}:${memberId}`;
    const url = `${this.items(this.settings.assignmentsList)}?$filter=Title eq '${key}'&$top=2`;
    const matches = (rows: Item[]): boolean => rows.length === 1 && Number(rows[0].ReceiptNumber) === number &&
      Number(rows[0].MemberId) === memberId && Number(rows[0].ContributionYear) === year;
    const existing = await this.all(url);
    if (existing.length) {
      if (!matches(existing)) throw new Error(`Conflicting receipt assignment for member ${memberId} in ${year}.`);
      return;
    }
    const parts = receiptParts(number);
    try {
      await this.transport.post(this.items(this.settings.assignmentsList), {
        Title: key, MemberId: memberId, ContributionYear: year, ReceiptNumber: number, RangeStart: parts.rangeStart
      });
    } catch (error) { if (!matches(await this.all(url))) throw error; }
  }
  public async importExisting(): Promise<void> {
    // Preserve any numbers created before this feature and detect cross-year range reuse first.
    await this.ranges();
    const records = await this.records();
    for (const record of records) {
      if (record.ReceiptNumber === null || record.ReceiptNumber === undefined) continue;
      const number = Number(record.ReceiptNumber);
      const parts = receiptParts(number);
      const memberId = Number(record.MemberNameId);
      if (!Number.isSafeInteger(memberId) || memberId < 1) throw new Error(`Contribution item ${record.Id} has no valid member lookup.`);
      await this.reserve(parts.rangeStart, parts.year);
      await this.assignment(memberId, parts.year, number);
    }
  }
  public async allocate(year: number, start: number, contributions: AnnualContribution[]): Promise<AnnualContribution[]> {
    await this.checkRange(start, year);
    await this.importExisting();
    const rows = await this.all(`${this.items(this.settings.assignmentsList)}?$filter=ContributionYear eq ${year}&$top=5000`);
    const assignments = new Map<number, number>();
    let next = start;
    for (const row of rows) {
      const number = Number(row.ReceiptNumber);
      const parts = receiptParts(number);
      const memberId = Number(row.MemberId);
      if (parts.year !== year || !Number.isSafeInteger(memberId) || memberId < 1 || Number(row.RangeStart) !== parts.rangeStart || assignments.has(memberId)) {
        throw new Error('Invalid or duplicate receipt assignments exist. Ask the site administrator to inspect the receipt ledger.');
      }
      assignments.set(memberId, number);
      if (parts.rangeStart === start) next = Math.max(next, parts.sequence + 1);
    }
    const required = contributions.filter(record => !assignments.has(record.memberId)).length;
    if (next + required > start + 100000) throw new Error(`Receipt range ${start} is exhausted. A year can use only one range. Ask an administrator to review capacity; no new receipts were created.`);
    if (required) await this.reserve(start, year);
    for (const record of contributions.slice().sort((a, b) => a.memberId - b.memberId)) {
      if (assignments.has(record.memberId)) continue;
      const number = makeReceiptNumber(year, next++);
      await this.assignment(record.memberId, year, number);
      assignments.set(record.memberId, number);
    }
    return contributions.map(record => ({ ...record, receiptNumber: assignments.get(record.memberId) }));
  }
}
