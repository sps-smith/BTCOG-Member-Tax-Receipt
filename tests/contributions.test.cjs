const { test } = require('node:test');
const assert = require('node:assert/strict');
const { availableYears, calculateContributions, receiptHtml } = require('./.compiled/domain/contributions');
const { ContributionService } = require('./.compiled/services/ContributionService');
const { defaultSettings, resolveSettings } = require('./.compiled/models');
const year = new Date().getFullYear();
const date = `${year}-06-01`;

test('existing Finance web parts migrate old placeholders to the confirmed revenue columns', () => {
  const settings = resolveSettings({ transactionDateField: 'TransactionDate', transactionAmountField: 'Amount', transactionMemberField: 'Member' });
  assert.equal(settings.transactionDateField, 'field_3');
  assert.equal(settings.transactionAmountField, 'field_4');
  assert.equal(settings.transactionMemberField, 'MemberName');
  assert.equal(settings.sourceMappingVersion, 1);
});
test('migration preserves deliberate custom mappings and other source lists', () => {
  assert.equal(resolveSettings({ transactionDateField: 'CustomDate' }).transactionDateField, 'CustomDate');
  assert.equal(resolveSettings({ sourceMappingVersion: 1, transactionDateField: 'TransactionDate' }).transactionDateField, 'TransactionDate');
  assert.equal(resolveSettings({ revenueList: 'Other Revenue', transactionDateField: 'TransactionDate' }).transactionDateField, 'TransactionDate');
});

test('year dropdown rolls over and contains exactly five descending years', () => {
  assert.deepEqual(availableYears(new Date(2027, 0, 1)), [2027, 2026, 2025, 2024, 2023]);
});
test('totals use cents, net refunds, distinct IDs, and exclude noncontributors', () => {
  const result = calculateContributions([
    { memberId: 1, amount: 0.1, date }, { memberId: 1, amount: 0.2, date },
    { memberId: 2, amount: 30, date }, { memberId: 2, amount: -10, date },
    { memberId: 3, amount: -2, date }, { memberId: 4, amount: 0, date },
    { memberId: undefined, amount: 100, date }, { memberId: 1, amount: 500, date: `${year - 1}-06-01T00:00:00Z` }
  ], [1, 2, 3, 4, 5].map(id => ({ id, name: 'Same Name' })), year);
  assert.deepEqual(result.contributions.map(item => [item.memberId, item.cents]), [[1, 30], [2, 2000]]);
  assert.equal(result.ignoredTransactions, 1);
});
test('date-only calendar years are preserved at January 1 and December 31', () => {
  const result = calculateContributions([
    { memberId: 1, amount: 100, date: `${year}-01-01` },
    { memberId: 1, amount: 20, date: `${year}-12-31T00:00:00` },
    { memberId: 1, amount: 5, date: `${year}-01-01T00:00:00Z` },
    { memberId: 1, amount: 200, date: `${year - 1}-12-31` },
    { memberId: 1, amount: 300, date: `${year + 1}-01-01` }
  ], [{ id: 1, name: 'Alex' }], year);
  assert.equal(result.contributions[0].cents, 12500);
});
test('date-only validation accepts leap days and rejects impossible dates', () => {
  const members = [{ id: 1, name: 'Alex' }];
  assert.equal(calculateContributions([{ memberId: 1, amount: 10, date: '2024-02-29' }], members, 2024).contributions[0].cents, 1000);
  for (const invalid of ['2025-02-29', '2026-02-30', '2026-13-01', '2026-00-01', '2026-01-00', '01/01/2026', '', 'invalid']) {
    assert.throws(() => calculateContributions([{ memberId: 1, amount: 10, date: invalid }], members, 2026), /invalid date/);
  }
});
test('invalid amounts and missing contributing members fail before replacement', () => {
  assert.throws(() => calculateContributions([{ memberId: 1, amount: NaN, date }], [], year), /invalid amount/);
  assert.throws(() => calculateContributions([{ memberId: 1, amount: 1.005, date }], [], year), /two decimal/);
  assert.throws(() => calculateContributions([{ memberId: 1, amount: 10, date }], [], year), /no matching member/);
});
test('receipts escape member data and produce exactly one article per member', () => {
  const html = receiptHtml([
    { memberId: 1, memberName: '<script>alert("x")</script>', cents: 1234, year, receiptNumber: year * 1000000 + 100000 },
    { memberId: 2, memberName: 'Alex & Sam', cents: 100, year, receiptNumber: year * 1000000 + 100001 }
  ], 'CAD');
  assert.equal((html.match(/<article /g) || []).length, 2);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('Alex &amp; Sam'));
  assert.ok(html.includes('11925 9869 RR 0001'));
  assert.ok(html.includes('page-break-after:always'));
});

const { harness: fixture, saved } = require('./helpers.cjs');



test('running generation prevents a concurrent replacement', async () => {
  const f = fixture([saved(1)]);
  f.setJob({ Id: 1, Title: String(year), RunState: 'Running', 'odata.etag': '"1"' });
  await assert.rejects(f.service.generate(f.plan, () => {}), /Another user/);
  assert.equal(f.items().length, 1);
});
test('optimistic job versions allow only one of two simultaneous generators', async () => {
  const f = fixture();
  f.setJob({ Id: 1, Title: String(year), RunState: 'Complete', 'odata.etag': '"1"' });
  const results = await Promise.allSettled([
    f.service.generate(f.plan, () => {}), f.service.generate(f.plan, () => {})
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.items().length, 1);
});


function prepareFixture(options = {}) {
  return fixture([], { transactions: [
    { Id: 1, field_3: date, field_4: 10, MemberNameId: 1 },
    { Id: 2, field_3: date, field_4: 5, MemberNameId: 1 },
    { Id: 3, field_3: date, field_4: 30, MemberNameId: null }
  ], ...options });
}
test('prepare validates Date Only and lookups and returns only contributing members', async () => {
  const { service, revenueReads, mutateCount } = prepareFixture();
  const plan = await service.prepare(year, 100000);
  assert.deepEqual(plan.contributions.map(item => [item.memberName, item.cents]), [['Member 1', 1500]]);
  assert.equal(plan.ignoredTransactions, 1);
  assert.equal(mutateCount(), 0);
  assert.equal(revenueReads[0].DatesInUtc, false);
  assert.ok(revenueReads[0].ViewXml.includes(`IncludeTimeValue='FALSE'>${year}-01-01`));
  assert.ok(revenueReads[0].ViewXml.includes(`IncludeTimeValue='FALSE'>${year + 1}-01-01`));
  assert.ok(revenueReads[0].ViewXml.includes("<FieldRef Name='field_3'/><FieldRef Name='field_4'/><FieldRef Name='MemberName'/>"));
});
test('generation refuses Date and Time source columns before reading revenue or writing records', async () => {
  const { service, revenueReads, mutateCount } = prepareFixture({ displayFormat: 1 });
  await assert.rejects(service.prepare(year, 100000), /as Date Only/);
  assert.equal(revenueReads.length, 0);
  assert.equal(mutateCount(), 0);
});
test('missing date mapping identifies the actual internal name instead of requesting DateTime', async () => {
  const { service, revenueReads } = prepareFixture({ dateInternalName: 'Transaction_x0020_Date' });
  await assert.rejects(service.prepare(year, 100000), error => {
    assert.match(error.message, /Cannot find a column with internal name "field_3"/);
    assert.match(error.message, /Transaction Date \[Transaction_x0020_Date\]/);
    assert.doesNotMatch(error.message, /must be DateTime/);
    return true;
  });
  assert.equal(revenueReads.length, 0);
});
test('a mapped text date column explains the type mismatch', async () => {
  const { service, revenueReads } = prepareFixture({ dateType: 'Text' });
  await assert.rejects(service.prepare(year, 100000), /is a Text column.*Date Only column/);
  assert.equal(revenueReads.length, 0);
});
test('date-only revenue querying reads all pages without duplicate transactions', async () => {
  const transactions = Array.from({ length: 1001 }, (_, index) => ({ Id: index + 1, field_3: date, MemberNameId: 1, field_4: 1 }));
  const { service, revenueReads } = prepareFixture({ transactions });
  const plan = await service.prepare(year, 100000);
  assert.equal(plan.contributions[0].cents, 100100);
  assert.equal(revenueReads.length, 3);
  assert.ok(revenueReads[1].ViewXml.includes("<Value Type='Counter'>500</Value>"));
  assert.ok(revenueReads[2].ViewXml.includes("<Value Type='Counter'>1000</Value>"));
});
test('receipt selection follows next links and retains zero totals for later updates', async () => {
  const base = 'https://btcogca.sharepoint.com/sites/Finance/_api/web/lists/';
  const requests = [];
  const service = new ContributionService({
    async get(url) {
      requests.push(url);
      if (url.includes('Contribution%20Generation%20Jobs')) return { value: [] };
      if (url.includes('page2')) return { value: [saved(2, 2, 0), saved(3)] };
      return { value: [saved(1)], 'odata.nextLink': `${base}getbytitle('Member%20Contributions')/items?page2` };
    }, async post() { throw new Error('Read-only workflow'); }
  }, defaultSettings);
  assert.deepEqual((await service.loadContributions(year)).map(item => item.memberId), [1, 2, 3]);
  assert.ok(requests.some(url => url.includes('page2')));
});
test('saved record keys are contribution item IDs, distinct from Members lookup IDs', async () => {
  const f = fixture([saved(41, 7), saved(42, 8)]);
  const records = await f.service.loadContributions(year);
  assert.deepEqual(records.map(record => [record.id, record.memberId, record.memberName]), [
    [41, 7, 'Member 7'], [42, 8, 'Member 8']
  ]);
  const read = f.events.find(event => event[1].includes('Member%20Contributions'));
  assert.ok(read[1].includes('$expand=MemberName'));
  assert.ok(read[1].includes('MemberName/Title'));
});

test('pagination rejects links outside the configured SharePoint API', async () => {
  const service = new ContributionService({
    async get(url) { return url.includes('Generation%20Jobs') ? { value: [] } : { value: [], 'odata.nextLink': 'https://example.com/steal' }; },
    async post() { throw new Error('Read-only workflow'); }
  }, defaultSettings);
  await assert.rejects(service.loadContributions(year), /unexpected pagination URL/);
});
