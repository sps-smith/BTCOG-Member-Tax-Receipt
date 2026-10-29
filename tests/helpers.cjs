const { ContributionService } = require('./.compiled/services/ContributionService');
const { defaultSettings } = require('./.compiled/models');
const year = new Date().getFullYear();
const guid = '00000000-0000-0000-0000-000000000001';
const date = `${year}-06-01`;
const field = (InternalName, TypeAsString, EnforceUniqueValues = false) => ({ InternalName, Title: InternalName === 'field_3' ? 'Transaction Date' : InternalName, TypeAsString, EnforceUniqueValues });

function saved(id, memberId = id, amount = 10, receiptNumber = year * 1000000 + 100000 + memberId - 1) {
  return { Id: id, MemberNameId: memberId, MemberName: { Id: memberId, Title: `Member ${memberId}` }, TotalContribution: amount, ContributionYear: year, ReceiptNumber: receiptNumber, 'odata.etag': '"1"' };
}

function harness(initial = [], options = {}) {
  const settings = { ...defaultSettings, ...options.settings };
  const tables = {
    [settings.contributionsList]: structuredClone(initial),
    [settings.jobsList]: [], [settings.rangesList]: [], [settings.assignmentsList]: [],
    [settings.revenueList]: structuredClone(options.transactions || [{ Id: 1, field_3: date, field_4: 25, MemberNameId: 2 }]),
    [settings.membersList]: [{ Id: 1, Title: 'Member 1' }, { Id: 2, Title: 'Member 2' }, { Id: 3, Title: 'Member 3' }, { Id: 7, Title: 'Member 7' }, { Id: 8, Title: 'Member 8' }]
  };
  const schema = {
    [settings.revenueList]: [{ ...field(options.dateInternalName || 'field_3', options.dateType || 'DateTime'), Title: 'Transaction Date' }, field('field_4', 'Currency'), field('MemberName', 'Lookup')],
    [settings.membersList]: [field('Title', 'Text')],
    [settings.contributionsList]: [field('MemberName', 'Lookup'), field('TotalContribution', 'Currency'), field('ContributionYear', 'Number'), field('ReceiptNumber', 'Number', true)],
    [settings.jobsList]: [field('Title', 'Text', true), field('RunState', 'Text'), field('RunMessage', 'Note'), field('RunKind', 'Text')],
    [settings.rangesList]: [field('Title', 'Text', true), field('AssignedYear', 'Number')],
    [settings.assignmentsList]: [field('Title', 'Text', true), field('MemberId', 'Number'), field('ContributionYear', 'Number'), field('ReceiptNumber', 'Number', true), field('RangeStart', 'Number')]
  };
  const events = [];
  const revenueReads = [];
  let failCreation = false;
  let failUpdateAt = 0;
  let updateAttempt = 0;
  let nextId = 100;
  let failDeleteAt = 0;
  let deleteAttempt = 0;
  const parse = url => {
    const parsed = new URL(url);
    const title = decodeURIComponent(parsed.pathname.match(/getbytitle\('([^']+)'\)/)[1]).replace(/''/g, "'");
    return { parsed, title };
  };
  const version = item => Number((item['odata.etag'] || '"1"').replace(/"/g, ''));
  const transport = {
    async get(url) {
      events.push(['get', url]);
      const { parsed, title } = parse(url);
      if (url.includes('EffectiveBasePermissions')) return { EffectiveBasePermissions: { Low: String(options.permissionLow === undefined ? 15 : options.permissionLow) } };
      if (url.includes('/fields?')) return { value: schema[title] };
      if (url.includes('?$select=DisplayFormat')) return { DisplayFormat: options.displayFormat === undefined ? 0 : options.displayFormat };
      if (url.includes('getbyinternalnameortitle')) return { LookupList: `{${guid}}`, LookupField: 'Title' };
      if (title === settings.membersList && !parsed.pathname.includes('/items')) return { Id: guid };
      let rows = tables[title];
      if (!rows) throw new Error(`Unexpected list: ${title}`);
      const filter = parsed.searchParams.get('$filter') || '';
      const titleFilter = /Title eq '([^']+)'/.exec(filter);
      if (titleFilter) rows = rows.filter(row => row.Title === titleFilter[1]);
      const yearFilter = /ContributionYear eq (\d+)/.exec(filter);
      if (yearFilter) rows = rows.filter(row => Number(row.ContributionYear) === Number(yearFilter[1]));
      if (filter.includes('ReceiptNumber ne null')) rows = rows.filter(row => row.ReceiptNumber !== undefined && row.ReceiptNumber !== null);
      return { value: structuredClone(rows) };
    },
    async post(url, body, headers = {}) {
      events.push(['post', url, structuredClone(body), { ...headers }]);
      const { parsed, title } = parse(url);
      if (url.endsWith('/getitems')) {
        revenueReads.push(body.query);
        const cursor = /<Value Type='Counter'>(\d+)<\/Value>/.exec(body.query.ViewXml);
        const after = cursor ? Number(cursor[1]) : 0;
        return { value: structuredClone(tables[title].filter(row => row.Id > after).slice(0, 500)) };
      }
      const idMatch = /\/items\((\d+)\)$/.exec(parsed.pathname);
      const rows = tables[title];
      if (idMatch) {
        const index = rows.findIndex(row => row.Id === Number(idMatch[1]));
        if (index < 0) throw new Error('404 missing item');
        if (headers['IF-MATCH'] !== '*' && headers['IF-MATCH'] !== rows[index]['odata.etag']) throw new Error('412 item changed');
        if (headers['X-HTTP-Method'] === 'DELETE') {
          if (++deleteAttempt === failDeleteAt) { failDeleteAt = 0; throw new Error('network interrupted during removal'); }
          rows.splice(index, 1); return undefined;
        }
        if (title === settings.contributionsList && ++updateAttempt === failUpdateAt) { failUpdateAt = 0; throw new Error('network interrupted during update'); }
        rows[index] = { ...rows[index], ...body, 'odata.etag': `"${version(rows[index]) + 1}"` };
        return undefined;
      }
      if (title === settings.contributionsList && failCreation) { failCreation = false; throw new Error('network interrupted'); }
      if ([settings.jobsList, settings.rangesList, settings.assignmentsList].includes(title) && rows.some(row => row.Title === body.Title)) throw new Error('409 unique key conflict');
      if ([settings.contributionsList, settings.assignmentsList].includes(title) && body.ReceiptNumber != null && rows.some(row => row.ReceiptNumber === body.ReceiptNumber)) throw new Error('409 duplicate receipt number');
      const row = { ...body, Id: nextId++, 'odata.etag': '"1"' };
      if (title === settings.contributionsList) row.MemberName = { Id: body.MemberNameId, Title: `Member ${body.MemberNameId}` };
      rows.push(row); return structuredClone(row);
    }
  };
  const service = new ContributionService(transport, settings);
  const plan = {
    year, rangeStart: 100000, ignoredTransactions: 0,
    existing: initial.map(item => ({ id: item.Id, etag: item['odata.etag'] })),
    contributions: [{ memberId: 2, memberName: 'Member 2', cents: 2500, year }]
  };
  return { service, transport, plan, events, revenueReads, tables, schema,
    items: () => tables[settings.contributionsList], job: () => tables[settings.jobsList][0],
    ranges: () => tables[settings.rangesList], assignments: () => tables[settings.assignmentsList],
    changeItem: () => { tables[settings.contributionsList][0]['odata.etag'] = '"2"'; },
    setJob: value => { tables[settings.jobsList].splice(0, Infinity, structuredClone(value)); },
    failCreation: () => { failCreation = true; }, failUpdate: attempt => { updateAttempt = 0; failUpdateAt = attempt; },
    failDelete: attempt => { deleteAttempt = 0; failDeleteAt = attempt; },
    mutateCount: () => events.filter(event => event[0] === 'post' && !event[1].endsWith('/getitems')).length
  };
}
module.exports = { harness, saved, year, date };
