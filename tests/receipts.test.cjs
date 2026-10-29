const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, saved, year, date } = require('./helpers.cjs');
const { formatReceiptNumber, makeReceiptNumber } = require('./.compiled/domain/receiptNumbers');
const { receiptHtml } = require('./.compiled/domain/contributions');
const noop = () => {};
const receiptWrites = f => f.events.filter(event => event[0] === 'post' && event[1].includes("getbytitle('Member%20Contributions')"));

test('every printed receipt embeds the original signature and the requested title and name', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const signature = fs.readFileSync(path.resolve(__dirname, '../src/webparts/memberContributions/assets/georgia.jpg'));
  const html = receiptHtml([
    { memberId: 1, memberName: 'Alex', year: 2025, cents: 1000, receiptNumber: 2025100000 },
    { memberId: 2, memberName: 'Sam', year: 2025, cents: 2000, receiptNumber: 2025100001 }
  ], 'CAD');
  const images = [...html.matchAll(/<img src="data:image\/jpeg;base64,([^"]+)"[^>]+>/g)];
  assert.equal(images.length, 2);
  for (const image of images) {
    assert.deepEqual(Buffer.from(image[1], 'base64'), signature);
    assert.ok(image[0].includes('alt="Signature of Georgia Pryce"'));
  }
  assert.equal((html.match(/<p>Secretary\/Treasurer<\/p><p class="signer">Georgia Pryce<\/p>/g) || []).length, 2);
  assert.ok(html.includes('page-break-inside:avoid'));
  assert.ok(html.includes('<button id="print" disabled>'));
});

test('receipt format stores ten integer digits and prints year plus six digits', () => {
  assert.equal(makeReceiptNumber(2025, 100000), 2025100000);
  assert.equal(formatReceiptNumber(2025100000), '2025-100000');
  assert.equal(formatReceiptNumber(2025200001), '2025-200001');
  assert.throws(() => makeReceiptNumber(2025, 1000000), /range|year/);
  const html = receiptHtml([{ memberId: 1, memberName: 'Alex', year: 2025, cents: 1500, receiptNumber: 2025100000 }], 'CAD');
  assert.ok(html.includes('Receipt Number: <strong>2025-100000</strong>'));
});
test('annual preview requires an explicit supported range', async () => {
  const f = harness();
  await assert.rejects(f.service.prepare(year), /Select a receipt start range/);
  await assert.rejects(f.service.prepare(year, 10000), /Select a receipt start range/);
  assert.equal(f.events.length, 0);
});
for (const list of ['Member Contributions', 'Receipt Number Assignments']) {
  test(`unique ContributionYear on ${list} is caught before a preview or any generation writes`, async () => {
    const f = harness();
    f.schema[list].find(field => field.InternalName === 'ContributionYear').EnforceUniqueValues = true;
    await assert.rejects(f.service.prepare(year, 100000), /ContributionYear must allow duplicate years/);
    // The execution entry point must also protect a preview made before the column was changed.
    await assert.rejects(f.service.generate(f.plan, noop), /keep ReceiptNumber unique/);
    assert.equal(f.mutateCount(), 0);
    assert.equal(f.assignments().length, 0);
    assert.equal(f.ranges().length, 0);
  });
}
test('initial generation allocates sequential numbers in stable member-ID order', async () => {
  const f = harness([], { transactions: [
    { Id: 1, field_3: date, field_4: 10, MemberNameId: 2 },
    { Id: 2, field_3: date, field_4: 20, MemberNameId: 1 }
  ] });
  const plan = await f.service.prepare(year, 200000);
  await f.service.generate(plan, noop);
  assert.deepEqual(f.items().map(row => [row.MemberNameId, row.ReceiptNumber]).sort((a, b) => a[0] - b[0]), [[1, year * 1000000 + 200000], [2, year * 1000000 + 200001]]);
  assert.equal(f.ranges()[0].AssignedYear, year);
  assert.equal(f.assignments().length, 2);
});
test('a range stays unavailable to another year after contribution records are deleted', async () => {
  const f = harness();
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  f.items().splice(0);
  const options = await f.service.getReceiptRanges();
  assert.equal(options.find(range => range.start === 100000).assignedYear, year);
  await assert.rejects(f.service.prepare(year - 1, 100000), /belongs to/);
  assert.equal(f.assignments().length, 1);
});
test('existing numbered records reserve ranges across all years before new generation', async () => {
  const old = { ...saved(1), ContributionYear: year - 1, ReceiptNumber: (year - 1) * 1000000 + 100000 };
  const f = harness([old]);
  await assert.rejects(f.service.prepare(year, 100000), /belongs to/);
  assert.equal(receiptWrites(f).length, 0);
});
test('concurrent years cannot reserve the same globally unique range', async () => {
  const f = harness();
  const a = { ...f.plan, year, rangeStart: 300000 };
  const b = { ...f.plan, year: year - 1, rangeStart: 300000, contributions: f.plan.contributions.map(row => ({ ...row, year: year - 1 })) };
  const results = await Promise.allSettled([f.service.generate(a, noop), f.service.generate(b, noop)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.ranges().length, 1);
  assert.equal(new Set(f.items().map(row => row.ContributionYear)).size, 1);
});
test('annual replacement and new members preserve old assignments without reusing deleted ones', async () => {
  const f = harness();
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  const assigned = f.items()[0].ReceiptNumber;
  const itemId = f.items()[0].Id;
  f.tables['Revenue Transactions'].push({ Id: 2, field_3: date, field_4: 40, MemberNameId: 1 });
  await f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop);
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  assert.equal(f.items().find(row => row.MemberNameId === 2).ReceiptNumber, assigned);
  assert.notEqual(f.items().find(row => row.MemberNameId === 2).Id, itemId);
  assert.equal(f.items().find(row => row.MemberNameId === 1).ReceiptNumber, assigned + 1);
  f.items().splice(0);
  f.tables['Revenue Transactions'].splice(0, Infinity, { Id: 3, field_3: date, field_4: 60, MemberNameId: 3 });
  await f.service.generate(await f.service.prepare(year, 100000), noop);
  assert.equal(f.items()[0].ReceiptNumber, assigned + 2);
});
test('range exhaustion is detected before contribution creation', async () => {
  const f = harness();
  f.ranges().push({ Id: 1, Title: '100000', AssignedYear: year });
  f.assignments().push({ Id: 1, Title: `${year}:3`, MemberId: 3, ContributionYear: year, RangeStart: 100000, ReceiptNumber: year * 1000000 + 199999 });
  await assert.rejects(f.service.generate(f.plan, noop), /exhausted/);
  assert.equal(f.items().length, 0);
  assert.equal(receiptWrites(f).length, 0);
});
test('partial creation retries reuse ledger assignments without issuing new numbers', async () => {
  const f = harness(); f.failCreation();
  await assert.rejects(f.service.generate(f.plan, noop), /incomplete/);
  const reserved = f.assignments()[0].ReceiptNumber;
  await f.service.generate(f.plan, noop);
  assert.equal(f.items()[0].ReceiptNumber, reserved);
  assert.equal(f.assignments().length, 1);
});
test('selected regeneration recalculates totals and only merges existing items', async () => {
  const f = harness([saved(41, 1, 10), saved(42, 2, 20), saved(43, 3, 30)], { transactions: [
    { Id: 1, field_3: date, field_4: 70, MemberNameId: 1 },
    { Id: 2, field_3: date, field_4: 100, MemberNameId: 2 },
    { Id: 3, field_3: date, field_4: -10, MemberNameId: 2 },
    { Id: 4, field_3: date, field_4: 900, MemberNameId: 3 }
  ] });
  const before = structuredClone(f.items());
  const loaded = await f.service.loadContributions(year);
  const plan = await f.service.prepareRegeneration(year, loaded.slice(0, 2));
  assert.deepEqual(plan.updates.map(update => update.cents), [7000, 9000]);
  assert.equal(receiptWrites(f).length, 0);
  assert.equal(await f.service.regenerate(plan, noop), 2);
  assert.deepEqual(f.items().map(row => row.Id), before.map(row => row.Id));
  assert.deepEqual(f.items().map(row => row.ReceiptNumber), before.map(row => row.ReceiptNumber));
  assert.deepEqual(f.items().map(row => row.TotalContribution), [70, 90, 30]);
  assert.deepEqual(f.items()[2], before[2]);
  for (const write of receiptWrites(f)) {
    assert.equal(write[3]['X-HTTP-Method'], 'MERGE');
    assert.deepEqual(Object.keys(write[2]), ['TotalContribution']);
  }
});
test('zero and negative updated totals keep IDs/numbers and cannot be printed', async () => {
  const f = harness([saved(41, 1), saved(42, 2)], { transactions: [{ Id: 1, field_3: date, field_4: -5, MemberNameId: 2 }] });
  await f.service.regenerate(await f.service.prepareRegeneration(year, await f.service.loadContributions(year)), noop);
  const records = await f.service.loadContributions(year);
  assert.deepEqual(records.map(row => row.cents), [0, -500]);
  assert.deepEqual(records.map(row => row.id), [41, 42]);
  assert.throws(() => receiptHtml(records, 'CAD'), /Only positive/);
  f.tables['Revenue Transactions'].push({ Id: 2, field_3: date, field_4: 60, MemberNameId: 1 });
  await f.service.regenerate(await f.service.prepareRegeneration(year, [records[0]]), noop);
  assert.equal(f.items()[0].TotalContribution, 60);
  assert.equal(f.items()[0].Id, 41);
});
test('changed and missing selected records cause a conflict without replacement', async () => {
  const f = harness([saved(41, 1)]);
  const plan = await f.service.prepareRegeneration(year, await f.service.loadContributions(year));
  f.changeItem();
  await assert.rejects(f.service.regenerate(plan, noop), /changed or is missing/);
  assert.equal(receiptWrites(f).length, 0);
  f.items().splice(0);
  await assert.rejects(f.service.regenerate(plan, noop), /changed or is missing/);
  assert.equal(receiptWrites(f).length, 0);
});
test('selected regeneration requires existing numbers and never allocates them', async () => {
  const f = harness([{ ...saved(41, 1), ReceiptNumber: null }]);
  await assert.rejects(f.service.prepareRegeneration(year, await f.service.loadContributions(year)), /no receipt number/);
  assert.equal(f.assignments().length, 0);
  assert.equal(receiptWrites(f).length, 0);
});
test('failed selected regeneration can retry in place, while printing stays blocked', async () => {
  const f = harness([saved(41, 1), saved(42, 2)], { transactions: [
    { Id: 1, field_3: date, field_4: 70, MemberNameId: 1 },
    { Id: 2, field_3: date, field_4: 80, MemberNameId: 2 }
  ] });
  const plan = await f.service.prepareRegeneration(year, await f.service.loadContributions(year));
  f.failUpdate(2);
  await assert.rejects(f.service.regenerate(plan, noop), /Updated 1 records/);
  assert.equal(f.job().RunState, 'Failed');
  await assert.rejects(f.service.loadContributions(year, true), /unavailable/);
  const retry = await f.service.prepareRegeneration(year, await f.service.loadContributions(year));
  await f.service.regenerate(retry, noop);
  assert.equal(f.job().RunState, 'Complete');
  assert.deepEqual(f.items().map(row => [row.Id, row.TotalContribution]), [[41, 70], [42, 80]]);
  assert.equal((await f.service.loadContributions(year, true)).length, 2);
  assert.ok(receiptWrites(f).every(write => write[3]['X-HTTP-Method'] === 'MERGE'));
});
test('an incomplete annual generation cannot be relabeled to unblock selected updates', async () => {
  const f = harness([saved(41, 1)]);
  const plan = await f.service.prepareRegeneration(year, await f.service.loadContributions(year));
  f.setJob({ Id: 1, Title: String(year), RunState: 'Failed', RunKind: 'Annual', 'odata.etag': '"1"' });
  await assert.rejects(f.service.regenerate(plan, noop), /incomplete annual/);
  assert.equal(f.job().RunKind, 'Annual');
  await assert.rejects(f.service.loadContributions(year), /unavailable/);
});
test('an issued receipt with an orphaned member blocks deletion rather than discarding its assignment', async () => {
  const f = harness([{ ...saved(41), MemberNameId: null, MemberName: null }]);
  await assert.rejects(f.service.removeYear(await f.service.prepareRemoval(year), String(year), noop), /valid member lookup/);
  assert.equal(f.items().length, 1);
  assert.equal(receiptWrites(f).length, 0);
});
