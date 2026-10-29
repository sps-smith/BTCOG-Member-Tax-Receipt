const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, saved, year, date } = require('./helpers.cjs');
const noop = () => {};

test('a year cannot change ranges after removal, including execution of a stale preview', async () => {
  const f = harness();
  const stale = await f.service.prepare(year, 200000);
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  const original = f.items()[0].ReceiptNumber;
  await f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop);
  await assert.rejects(f.service.prepare(year, 200000), /only one range/);
  await assert.rejects(f.service.generate(stale, noop), /only one range/);
  assert.equal(f.items().length, 0);
  assert.equal(f.ranges().length, 1);
  f.tables['Revenue Transactions'].push({ Id: 2, field_3: date, field_4: 10, MemberNameId: 1 });
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  assert.equal(f.items().find(r => r.MemberNameId === 2).ReceiptNumber, original);
  assert.equal(f.items().find(r => r.MemberNameId === 1).ReceiptNumber, original + 1);
});

test('retained assignments enforce original range even without range registration or receipts', async () => {
  const f = harness();
  f.assignments().push({ Id: 1, Title: `${year}:2`, MemberId: 2, ContributionYear: year, RangeStart: 300000, ReceiptNumber: year * 1000000 + 300004 });
  assert.equal((await f.service.getReceiptRanges()).find(r => r.start === 300000).assignedYear, year);
  await assert.rejects(f.service.prepare(year, 100000), /select 300000/);
  await f.service.generate(await f.service.prepare(year, 300000), noop);
  assert.equal(f.items()[0].ReceiptNumber, year * 1000000 + 300004);
});

test('historical multiple ranges are reported without renumbering or writes', async () => {
  const f = harness([saved(41, 1), saved(42, 2, 10, year * 1000000 + 200000)]);
  await assert.rejects(f.service.getReceiptRanges(), /multiple receipt ranges/);
  await assert.rejects(f.service.prepare(year - 1, 300000), /multiple receipt ranges/);
  assert.equal(f.mutateCount(), 0);
  assert.equal(f.items().length, 2);
});

test('two simultaneous requests for different ranges cannot assign both to one year', async () => {
  const f = harness();
  const a = await f.service.prepare(year, 100000);
  const b = await f.service.prepare(year, 200000);
  const results = await Promise.allSettled([f.service.generate(a, noop), f.service.generate(b, noop)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.ranges().length, 1);
});
