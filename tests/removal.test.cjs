const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, saved, year } = require('./helpers.cjs');
const noop = () => {};
const writes = f => f.events.filter(e => e[0] === 'post' && e[1].includes('Member%20Contributions'));

test('existing records block annual preview and execution without deleting or allocating', async () => {
  const f = harness([saved(41)]);
  await assert.rejects(f.service.prepare(year, 100000), /Receipts already exist/);
  await assert.rejects(f.service.generate(f.plan, noop), /Receipts already exist/);
  assert.equal(writes(f).length, 0);
  assert.equal(f.assignments().length, 0);
  assert.equal(await f.service.getYearRecordCount(year), 1);
});

test('records created after preview block execution under the year lock', async () => {
  const f = harness();
  const plan = await f.service.prepare(year, 100000);
  f.items().push(saved(41));
  await assert.rejects(f.service.generate(plan, noop), /Receipts already exist/);
  assert.equal(writes(f).length, 0);
});

test('removal requires exact year confirmation and rejects a changed preview', async () => {
  const f = harness([saved(41)]);
  const plan = await f.service.prepareRemoval(year);
  await assert.rejects(f.service.removeYear(plan, String(year - 1), noop), /Type the selected year/);
  assert.equal(f.mutateCount(), 0);
  f.changeItem();
  await assert.rejects(f.service.removeYear(plan, String(year), noop), /changed after the removal preview/);
  assert.equal(writes(f).length, 0);
});

test('removal deletes only the selected year and recreating reuses imported receipt numbers', async () => {
  const original = saved(41, 2, 10, year * 1000000 + 200042);
  const other = { ...saved(42), ContributionYear: year - 1, ReceiptNumber: (year - 1) * 1000000 + 100000 };
  const f = harness([original, other]);
  assert.equal(await f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop), 1);
  assert.deepEqual(f.items(), [other]);
  assert.equal(f.assignments().length, 2);
  const ledger = structuredClone(f.assignments());
  const ranges = structuredClone(f.ranges());
  await f.service.generate(await f.service.prepare(year, 200000), noop);
  const recreated = f.items().find(r => r.ContributionYear === year);
  assert.equal(recreated.ReceiptNumber, original.ReceiptNumber);
  assert.notEqual(recreated.Id, original.Id);
  assert.deepEqual(f.assignments(), ledger);
  assert.deepEqual(f.ranges(), ranges);
  assert.equal(f.tables['Members'].length, 5);
  assert.equal(f.tables['Revenue Transactions'].length, 1);
});

test('partial removal stays blocked until retry removes the remaining records', async () => {
  const f = harness([saved(41, 1), saved(42, 2)]);
  f.failDelete(2);
  await assert.rejects(f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop), /Removed 1 records/);
  assert.equal(await f.service.getYearRecordCount(year), 1);
  await assert.rejects(f.service.prepare(year, 100000), /Receipts already exist/);
  await assert.rejects(f.service.loadContributions(year, true), /unavailable/);
  await f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop);
  assert.equal(await f.service.getYearRecordCount(year), 0);
  assert.equal(f.assignments().length, 2);
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  assert.equal(f.items()[0].ReceiptNumber, year * 1000000 + 100001);
});

test('running operations block removal and selected updates conflict with removal', async () => {
  const f = harness([saved(41, 1)]);
  const removal = await f.service.prepareRemoval(year);
  const update = await f.service.prepareRegeneration(year, await f.service.loadContributions(year));
  f.setJob({ Id: 1, Title: String(year), RunState: 'Running', RunKind: 'Annual', 'odata.etag': '"1"' });
  await assert.rejects(f.service.prepareRemoval(year), /Another operation/);
  await assert.rejects(f.service.removeYear(removal, String(year), noop), /Another user/);
  f.setJob({ Id: 1, Title: String(year), RunState: 'Complete', 'odata.etag': '"2"' });
  const results = await Promise.allSettled([
    f.service.removeYear(removal, String(year), noop), f.service.regenerate(update, noop)
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
});

test('failed annual records remain removable even when receipt loading is blocked', async () => {
  const f = harness([{ ...saved(41), ReceiptNumber: null, MemberNameId: null, MemberName: null }]);
  f.setJob({ Id: 1, Title: String(year), RunState: 'Failed', RunKind: 'Annual', 'odata.etag': '"1"' });
  await assert.rejects(f.service.loadContributions(year), /unavailable/);
  assert.equal(await f.service.getYearRecordCount(year), 1);
  await f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop);
  assert.equal(f.items().length, 0);
});
