import { Calculation, ContributionSettings, GenerationPlan, ReceiptRange, RegenerationPlan, RemovalPlan, SavedContribution, SavedItem, Transaction, Member } from '../models';
import { calculateContributions } from '../domain/contributions';
import { receiptParts, validateRange } from '../domain/receiptNumbers';
import { ReceiptRegistry } from './ReceiptRegistry';

export interface RestTransport {
  get<T>(url: string): Promise<T>;
  post<T>(url: string, body: unknown, headers?: { [key: string]: string }): Promise<T>;
}
export interface Item { Id: number; 'odata.etag'?: string; '@odata.etag'?: string; [key: string]: unknown; }
interface Page { value: Item[]; 'odata.nextLink'?: string; '@odata.nextLink'?: string; }
interface Job extends Item { RunState: string; RunKind?: string; }
interface Field { InternalName: string; Title?: string; TypeAsString: string; EnforceUniqueValues: boolean; LookupList?: string; LookupField?: string; }
export type Progress = (message: string) => void;

function etag(item: Item): string {
  const value = item['@odata.etag'] || item['odata.etag'];
  if (!value) throw new Error('SharePoint did not return an item version. Refresh and try again.');
  return value;
}
function fieldName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`Invalid column internal name: ${value}`);
  return value;
}
function quote(value: string): string { return encodeURIComponent(value.replace(/'/g, "''")).replace(/'/g, '%27'); }

export class ContributionService {
  private readonly root: string;
  private readonly registry: ReceiptRegistry;
  public constructor(private readonly transport: RestTransport, private readonly settings: ContributionSettings) {
    const url = new URL(settings.siteUrl);
    if (url.protocol !== 'https:') throw new Error('The SharePoint site URL must use HTTPS.');
    this.root = settings.siteUrl.replace(/\/$/, '');
    [settings.transactionDateField, settings.transactionAmountField, settings.transactionMemberField,
      settings.memberNameField].forEach(fieldName);
    new Intl.NumberFormat('en-CA', { style: 'currency', currency: settings.currency }).format(0);
    this.registry = new ReceiptRegistry(transport, settings, title => this.list(title), url => this.all(url));
  }

  private list(title: string): string { return `${this.root}/_api/web/lists/getbytitle('${quote(title)}')`; }
  private items(title: string): string { return `${this.list(title)}/items`; }
  private async all(url: string): Promise<Item[]> {
    const result: Item[] = [];
    const visited = new Set<string>();
    let next: string | undefined = url;
    while (next) {
      if (visited.has(next)) throw new Error('SharePoint returned a repeated pagination link.');
      const parsed = new URL(next, this.root);
      if (parsed.origin !== new URL(this.root).origin || !parsed.pathname.toLowerCase().startsWith(`${new URL(this.root).pathname.toLowerCase()}/_api/`)) {
        throw new Error('SharePoint returned an unexpected pagination URL.');
      }
      visited.add(next);
      const page: Page = await this.transport.get<Page>(parsed.href);
      if (!Array.isArray(page.value)) throw new Error('Unexpected SharePoint list response.');
      result.push(...page.value);
      next = page['@odata.nextLink'] || page['odata.nextLink'];
    }
    return result;
  }

  public async validateSchema(): Promise<void> {
    const s = this.settings;
    const requirements: [string, { [key: string]: string[] }][] = [
      [s.revenueList, { [s.transactionDateField]: ['DateTime'], [s.transactionAmountField]: ['Currency', 'Number'], [s.transactionMemberField]: ['Lookup'] }],
      [s.membersList, { [s.memberNameField]: ['Text', 'Computed'] }],
      [s.contributionsList, { MemberName: ['Lookup'], TotalContribution: ['Currency', 'Number'], ContributionYear: ['Number'], ReceiptNumber: ['Number'] }],
      [s.jobsList, { Title: ['Text'], RunState: ['Text'], RunMessage: ['Note', 'Text'], RunKind: ['Text'] }],
      [s.rangesList, { Title: ['Text'], AssignedYear: ['Number'] }],
      [s.assignmentsList, { Title: ['Text'], MemberId: ['Number'], ContributionYear: ['Number'], ReceiptNumber: ['Number'], RangeStart: ['Number'] }]
    ];
    const fieldsByList = await Promise.all(requirements.map(async ([list, required]) => {
      const response = await this.transport.get<{ value: Field[] }>(`${this.list(list)}/fields?$select=Title,InternalName,TypeAsString,EnforceUniqueValues`);
      for (const name of Object.keys(required)) {
        const field = response.value.find(candidate => candidate.InternalName === name);
        const transactionDate = list === s.revenueList && name === s.transactionDateField;
        if (!field) {
          if (transactionDate) {
            const candidates = response.value.filter(candidate => candidate.TypeAsString === 'DateTime' &&
              candidate.InternalName !== 'Created' && candidate.InternalName !== 'Modified')
              .map(candidate => `${candidate.Title || candidate.InternalName} [${candidate.InternalName}]`);
            throw new Error(`Cannot find a column with internal name "${name}" in ${list}. Set "Transaction date column (Date Only)" in the web part settings to the actual internal name.${candidates.length ? ` Available date columns (display name [internal name]): ${candidates.join(', ')}.` : ' No custom date columns were found in this list.'}`);
          }
          throw new Error(`Cannot find column "${name}" in ${list}. Check the column internal name in the web part settings or list setup.`);
        }
        if (required[name].indexOf(field.TypeAsString) < 0) {
          throw new Error(transactionDate
            ? `${list}.${name} is a ${field.TypeAsString} column. Set "Transaction date column (Date Only)" to a SharePoint Date Only column, rather than a text or calculated column.`
            : `Configure ${list}: column ${name} is ${field.TypeAsString}; expected ${required[name].join(' or ')}. See the setup guide.`);
        }
      }
      return response.value;
    }));
    for (const index of [2, 5]) {
      if (fieldsByList[index].some(field => field.InternalName === 'ContributionYear' && field.EnforceUniqueValues)) {
        throw new Error(`${requirements[index][0]}.ContributionYear must allow duplicate years. Set "Enforce unique values" to No for ContributionYear; keep ReceiptNumber unique. Then retry the failed run without deleting receipt tracking history.`);
      }
    }
    // SharePoint represents Date Only columns as DateTime fields with DisplayFormat=0.
    const dateField = await this.transport.get<{ DisplayFormat: number }>(`${this.list(s.revenueList)}/fields/getbyinternalnameortitle('${s.transactionDateField}')?$select=DisplayFormat`);
    if (dateField.DisplayFormat !== 0) {
      throw new Error(`Configure ${s.revenueList}.${s.transactionDateField} as Date Only in SharePoint List Settings before generating contributions.`);
    }
    const members = await this.transport.get<{ Id: string }>(`${this.list(s.membersList)}?$select=Id`);
    for (const [list, name] of [[s.revenueList, s.transactionMemberField], [s.contributionsList, 'MemberName']]) {
      const lookup = await this.transport.get<Field>(`${this.list(list)}/fields/getbyinternalnameortitle('${name}')?$select=LookupList,LookupField`);
      if (!lookup.LookupList || lookup.LookupList.replace(/[{}]/g, '').toLowerCase() !== members.Id.replace(/[{}]/g, '').toLowerCase()) {
        throw new Error(`${list}.${name} must point to the configured Members list.`);
      }
      if (list === s.contributionsList && lookup.LookupField !== 'Title') {
        throw new Error('Member Contributions.MemberName must look up the Title field in Members.');
      }
    }
    if (!fieldsByList[3].some(field => field.InternalName === 'Title' && field.EnforceUniqueValues)) {
      throw new Error('Generation-job Title must enforce unique values. Run the provisioning script.');
    }
    if (!fieldsByList[2].some(field => field.InternalName === 'ReceiptNumber' && field.EnforceUniqueValues) ||
        !fieldsByList[4].some(field => field.InternalName === 'Title' && field.EnforceUniqueValues) ||
        !fieldsByList[5].some(field => field.InternalName === 'Title' && field.EnforceUniqueValues) ||
        !fieldsByList[5].some(field => field.InternalName === 'ReceiptNumber' && field.EnforceUniqueValues)) {
      throw new Error('ReceiptNumber and receipt ledger keys must enforce unique values. Run the updated provisioning script.');
    }
  }

  private checkYear(year: number): void {
    const current = new Date().getFullYear();
    if (!Number.isInteger(year) || year < current - 4 || year > current) throw new Error('Select one of the five available years.');
  }
  private async saved(year: number): Promise<SavedContribution[]> {
    const items = await this.all(`${this.items(this.settings.contributionsList)}?$select=Id,MemberNameId,MemberName/Id,MemberName/Title,TotalContribution,ContributionYear,ReceiptNumber&$expand=MemberName&$filter=ContributionYear eq ${year}&$top=5000`);
    return items.map(item => {
      const member = item.MemberName as { Id?: number; Title?: string } | undefined;
      const memberId = Number(item.MemberNameId);
      const cents = Math.round(Number(item.TotalContribution) * 100);
      if (!Number.isSafeInteger(item.Id) || item.Id < 1 || !Number.isSafeInteger(cents) ||
          !Number.isSafeInteger(memberId) || memberId < 1 || !member || typeof member.Title !== 'string' || !member.Title.trim()) {
        throw new Error('A saved contribution has invalid data. Regenerate this year.');
      }
      const receiptNumber = item.ReceiptNumber === null || item.ReceiptNumber === undefined ? undefined : Number(item.ReceiptNumber);
      if (receiptNumber !== undefined && receiptParts(receiptNumber).year !== year) throw new Error(`Contribution item ${item.Id} has a receipt number for the wrong year.`);
      return { id: item.Id, etag: etag(item), memberId, memberName: member.Title.trim(), cents, year, receiptNumber };
    }).sort((a, b) => a.memberName.localeCompare(b.memberName) || a.memberId - b.memberId);
  }
  private async savedItems(year: number): Promise<SavedItem[]> {
    // Removal only needs record identities, including records with invalid old data.
    const items = await this.all(`${this.items(this.settings.contributionsList)}?$select=Id&$filter=ContributionYear eq ${year}&$top=5000`);
    return items.map(item => {
      if (!Number.isSafeInteger(item.Id) || item.Id < 1) throw new Error('SharePoint returned an invalid contribution item ID.');
      return { id: item.Id, etag: etag(item) };
    });
  }
  private async job(year: number): Promise<Job | undefined> {
    const items = await this.all(`${this.items(this.settings.jobsList)}?$filter=Title eq '${year}'&$top=2`);
    if (items.length > 1) throw new Error('Duplicate generation jobs exist. Correct the job list before continuing.');
    return items[0] as Job | undefined;
  }

  public async loadContributions(year: number, forPrinting: boolean = false): Promise<SavedContribution[]> {
    this.checkYear(year);
    const before = await this.job(year);
    if (before && before.RunState !== 'Complete' && (forPrinting || before.RunState !== 'Failed' || before.RunKind !== 'Regeneration')) {
      throw new Error(`Receipts are unavailable: the operation for ${year} is ${before.RunState}. If no operation is running, remove any incomplete records for this year before generating again.`);
    }
    const records = await this.saved(year);
    const after = await this.job(year);
    if ((before ? etag(before) : '') !== (after ? etag(after) : '')) throw new Error('Generation changed while loading receipts. Reload the year.');
    return records;
  }

  public getReceiptRanges(): Promise<ReceiptRange[]> { return this.registry.ranges(); }

  public async getYearRecordCount(year: number): Promise<number> {
    this.checkYear(year);
    return (await this.savedItems(year)).length;
  }

  private existingYearMessage(year: number): string {
    return `Receipts already exist for ${year}. Regenerate selected receipts to update totals, or remove this year's records before generating again.`;
  }

  public async prepareRemoval(year: number): Promise<RemovalPlan> {
    this.checkYear(year);
    const running = await this.job(year);
    if (running?.RunState === 'Running') throw new Error('Another operation is running for this year. Wait for it to finish.');
    return { year, existing: await this.savedItems(year) };
  }

  public async removeYear(plan: RemovalPlan, confirmation: string, progress: Progress): Promise<number> {
    this.checkYear(plan.year);
    if (confirmation !== String(plan.year)) throw new Error('Type the selected year to confirm removal.');
    if (!plan.existing.length) throw new Error('No receipt records were selected for removal.');
    await this.validateSchema();
    await this.checkWritePermissions(false, true);
    const job = await this.acquire(plan.year, 'Removal');
    let changed = false;
    let removed = 0;
    try {
      const current = await this.savedItems(plan.year);
      if (current.length !== plan.existing.length || current.some(item => !plan.existing.some(old => old.id === item.id && old.etag === item.etag))) {
        throw new Error('Saved records changed after the removal preview. Reload and confirm removal again.');
      }
      progress('Preserving receipt number assignments before removal…');
      await this.registry.importExisting();
      for (const item of current) {
        progress(`Removing receipts for ${plan.year}: ${removed + 1} of ${current.length}`);
        changed = true;
        await this.transport.post(`${this.items(this.settings.contributionsList)}(${item.id})`, undefined,
          { 'IF-MATCH': item.etag, 'X-HTTP-Method': 'DELETE' });
        removed++;
      }
      if ((await this.savedItems(plan.year)).length) throw new Error('Additional receipt records appeared during removal.');
      await this.finish(job.id, 'Complete', `Removed ${removed} records. Receipt number history preserved.`, 'Removal');
      return removed;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await this.finish(job.id, changed ? 'Failed' : job.previousState, reason, changed ? 'Removal' : job.previousKind || 'Annual'); }
      catch { throw new Error(`${reason} Removal status could not be saved. Ask an administrator to inspect the Running job.`); }
      throw new Error(`${reason}${changed ? ` Removed ${removed} records before stopping. Reload and retry removal; generation is blocked while any records remain.` : ''}`);
    }
  }

  public async prepare(year: number, rangeStart: number): Promise<GenerationPlan> {
    this.checkYear(year);
    validateRange(rangeStart);
    if ((await this.savedItems(year)).length) throw new Error(this.existingYearMessage(year));
    await this.validateSchema();
    await this.registry.checkRange(rangeStart, year);
    const running = await this.job(year);
    if (running && running.RunState === 'Running') throw new Error('Another generation is running for this year. Wait for it to finish.');
    const [calculation, existing] = await Promise.all([this.calculate(year), this.savedItems(year)]);
    return { year, rangeStart, existing, ...calculation };
  }

  private async calculate(year: number, memberIds?: number[]): Promise<Calculation> {
    const s = this.settings;
    const memberField = `${s.transactionMemberField}Id`;
    const [rawTransactions, rawMembers] = await Promise.all([
      this.revenueForYear(year),
      this.all(`${this.items(s.membersList)}?$select=Id,${s.memberNameField}&$top=5000`)
    ]);
    const transactions: Transaction[] = rawTransactions.map(item => ({
      memberId: item[memberField] === null || item[memberField] === undefined ? undefined : Number(item[memberField]),
      amount: item[s.transactionAmountField] === null || item[s.transactionAmountField] === undefined ? NaN : Number(item[s.transactionAmountField]),
      date: String(item[s.transactionDateField])
    }));
    const members: Member[] = rawMembers.map(item => ({ id: item.Id, name: item[s.memberNameField] === null || item[s.memberNameField] === undefined ? '' : String(item[s.memberNameField]) }));
    return calculateContributions(memberIds ? transactions.filter(record => record.memberId !== undefined && memberIds.indexOf(record.memberId) >= 0) : transactions,
      members, year, !!memberIds);
  }

  private async revenueForYear(year: number): Promise<Item[]> {
    const s = this.settings;
    const result: Item[] = [];
    const pageSize = 500;
    let lastId = 0;
    // Compare calendar dates on SharePoint, then return site-local values. This also handles sites
    // whose local January 1 is serialized as December 31 in UTC.
    while (true) {
      const dates = `<And><Geq><FieldRef Name='${s.transactionDateField}'/><Value Type='DateTime' IncludeTimeValue='FALSE'>${year}-01-01</Value></Geq><Lt><FieldRef Name='${s.transactionDateField}'/><Value Type='DateTime' IncludeTimeValue='FALSE'>${year + 1}-01-01</Value></Lt></And>`;
      const where = lastId ? `<And><Gt><FieldRef Name='ID'/><Value Type='Counter'>${lastId}</Value></Gt>${dates}</And>` : dates;
      const fields = ['ID', s.transactionDateField, s.transactionAmountField, s.transactionMemberField]
        .map(name => `<FieldRef Name='${name}'/>`).join('');
      const page = await this.transport.post<Page>(`${this.list(s.revenueList)}/getitems`, {
        query: {
          DatesInUtc: false,
          ViewXml: `<View Scope='RecursiveAll'><Query><Where>${where}</Where><OrderBy><FieldRef Name='ID' Ascending='TRUE'/></OrderBy></Query><ViewFields>${fields}</ViewFields><RowLimit>${pageSize}</RowLimit></View>`
        }
      });
      if (!Array.isArray(page.value)) throw new Error('Unexpected SharePoint revenue response.');
      for (const item of page.value) {
        if (!Number.isSafeInteger(item.Id) || item.Id <= lastId) throw new Error('SharePoint returned revenue transactions out of paging order.');
        lastId = item.Id;
        result.push(item);
      }
      if (page.value.length < pageSize) return result;
    }
  }

  private async acquire(year: number, kind: string = 'Annual'): Promise<{ id: number; previousState: string; previousKind?: string }> {
    const current = await this.job(year);
    if (current && current.RunState === 'Running') throw new Error('Another user is generating this year.');
    try {
      if (current) {
        await this.transport.post(`${this.items(this.settings.jobsList)}(${current.Id})`, { RunState: 'Running', RunKind: kind, RunMessage: '' },
          { 'IF-MATCH': etag(current), 'X-HTTP-Method': 'MERGE' });
        return { id: current.Id, previousState: current.RunState, previousKind: current.RunKind };
      }
      const created = await this.transport.post<Item>(this.items(this.settings.jobsList), { Title: String(year), RunState: 'Running', RunKind: kind, RunMessage: '' });
      return { id: created.Id, previousState: 'Complete' };
    } catch (error) {
      throw new Error(`Could not acquire generation control. Another user may have started, or permissions/setup need attention. ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  public async generate(plan: GenerationPlan, progress: Progress): Promise<number> {
    this.checkYear(plan.year);
    validateRange(plan.rangeStart);
    await this.validateSchema();
    await this.checkWritePermissions(true);
    const job = await this.acquire(plan.year);
    let changed = false;
    let created = 0;
    try {
      const current = await this.savedItems(plan.year);
      if (current.length) throw new Error(this.existingYearMessage(plan.year));
      progress('Reserving receipt numbers and preserving existing assignments…');
      const numbered = await this.registry.allocate(plan.year, plan.rangeStart, plan.contributions);
      for (const record of numbered) {
        progress(`Creating contribution records: ${created + 1} of ${plan.contributions.length}`);
        changed = true;
        await this.transport.post(this.items(this.settings.contributionsList), {
          Title: `${record.year} - ${record.memberName}`.slice(0, 255), MemberNameId: record.memberId,
          TotalContribution: record.cents / 100, ContributionYear: record.year, ReceiptNumber: record.receiptNumber
        });
        created++;
      }
      await this.finish(job.id, 'Complete', `Created ${created} records.`);
      return created;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await this.finish(job.id, changed ? 'Failed' : job.previousState, reason, changed ? 'Annual' : job.previousKind || 'Annual'); }
      catch { throw new Error(`${reason} Generation status could not be saved. Ask a site administrator to inspect the Running job before retrying.`); }
      throw new Error(`${reason}${changed ? ` The year may be incomplete (${created} new records created). Remove any records for this year before generating again; receipts remain blocked.` : ''}`);
    }
  }

  public async prepareRegeneration(year: number, selected: SavedContribution[]): Promise<RegenerationPlan> {
    this.checkYear(year);
    if (!selected.length || new Set(selected.map(record => record.id)).size !== selected.length) throw new Error('Select one or more distinct receipt records.');
    await this.validateSchema();
    const job = await this.job(year);
    if (job && job.RunState !== 'Complete' && (job.RunState !== 'Failed' || job.RunKind !== 'Regeneration')) throw new Error(`Generation for ${year} is ${job.RunState}. Complete annual generation before updating selected receipts.`);
    const current = await this.saved(year);
    const chosen = selected.map(old => {
      const record = current.find(item => item.id === old.id);
      if (!record || record.etag !== old.etag || record.year !== old.year || record.memberId !== old.memberId || record.receiptNumber !== old.receiptNumber) {
        throw new Error('A selected record changed or is missing. Reload the year and select it again.');
      }
      if (record.receiptNumber === undefined) throw new Error('A selected record has no receipt number. Remove this year’s records, then generate annual records again.');
      return record;
    });
    if (new Set(chosen.map(record => record.memberId)).size !== chosen.length) throw new Error('Duplicate annual records exist for a selected member. Resolve them before updating.');
    const calculation = await this.calculate(year, chosen.map(record => record.memberId));
    return { year, updates: chosen.map(existing => ({ existing, cents: calculation.contributions.find(record => record.memberId === existing.memberId)?.cents || 0 })) };
  }

  public async regenerate(plan: RegenerationPlan, progress: Progress): Promise<number> {
    this.checkYear(plan.year);
    if (!plan.updates.length) throw new Error('Select one or more receipt records.');
    await this.validateSchema();
    await this.checkWritePermissions(false);
    const job = await this.acquire(plan.year, 'Regeneration');
    let changed = false;
    let updated = 0;
    try {
      if (job.previousState !== 'Complete' && job.previousKind !== 'Regeneration') throw new Error('Repair the incomplete annual generation before updating selected receipts.');
      const current = await this.saved(plan.year);
      const memberIds = new Set<number>();
      for (const update of plan.updates) {
        const record = current.find(item => item.id === update.existing.id);
        if (memberIds.has(update.existing.memberId) || !Number.isSafeInteger(update.cents) || update.existing.year !== plan.year || !record || record.etag !== update.existing.etag || record.memberId !== update.existing.memberId ||
            record.receiptNumber === undefined || record.receiptNumber !== update.existing.receiptNumber) {
          throw new Error('A selected receipt changed or is missing. Preview the update again. No new contribution records were created.');
        }
        memberIds.add(update.existing.memberId);
      }
      await this.registry.importExisting();
      for (const update of plan.updates) {
        progress(`Updating existing receipts: ${updated + 1} of ${plan.updates.length}`);
        changed = true;
        await this.transport.post(`${this.items(this.settings.contributionsList)}(${update.existing.id})`,
          { TotalContribution: update.cents / 100 }, { 'IF-MATCH': update.existing.etag, 'X-HTTP-Method': 'MERGE' });
        updated++;
      }
      await this.finish(job.id, 'Complete', `Updated ${updated} existing receipts. IDs and receipt numbers preserved.`);
      return updated;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try { await this.finish(job.id, changed ? 'Failed' : job.previousState, reason, changed ? 'Regeneration' : job.previousKind || 'Annual'); }
      catch { throw new Error(`${reason} Status could not be saved. Ask an administrator to inspect the Running job.`); }
      throw new Error(`${reason}${changed ? ` Updated ${updated} records before stopping. Receipts are blocked until recovery; no replacement records were created.` : ''}`);
    }
  }

  private async checkWritePermissions(annual: boolean, removal: boolean = false): Promise<void> {
    const requirements: [string, number, string][] = [
      [this.settings.contributionsList, removal ? 9 : annual ? 7 : 5, removal ? 'view and delete' : annual ? 'view, add and edit' : 'view and edit'],
      [this.settings.jobsList, 7, 'view, add and edit'],
      [this.settings.rangesList, 3, 'view and add'],
      [this.settings.assignmentsList, 3, 'view and add']
    ];
    for (const [title, mask, description] of requirements) {
      const permissions = await this.transport.get<{ EffectiveBasePermissions: { Low: string } }>(`${this.list(title)}?$select=EffectiveBasePermissions`);
      if ((Number(permissions.EffectiveBasePermissions.Low) & mask) !== mask) throw new Error(`You need ${description} permission on ${title}.`);
    }
  }

  private async finish(id: number, state: string, message: string, kind?: string): Promise<void> {
    await this.transport.post(`${this.items(this.settings.jobsList)}(${id})`, { RunState: state, RunMessage: message, ...(kind ? { RunKind: kind } : {}) },
      { 'IF-MATCH': '*', 'X-HTTP-Method': 'MERGE' });
  }
}
