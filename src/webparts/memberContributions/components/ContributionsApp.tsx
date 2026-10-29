import * as React from 'react';
import { ContributionService } from '../services/ContributionService';
import { ContributionSettings, GenerationPlan, ReceiptRange, RegenerationPlan, RemovalPlan, SavedContribution } from '../models';
import { availableYears, receiptHtml } from '../domain/contributions';
import { formatReceiptNumber, receiptRangeStarts } from '../domain/receiptNumbers';
import styles from './ContributionsApp.module.scss';

interface Props { service: ContributionService; settings: ContributionSettings; }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

export default function ContributionsApp({ service, settings }: Props): React.ReactElement {
  const [year, setYear] = React.useState(availableYears()[0]);
  const [records, setRecords] = React.useState<SavedContribution[]>([]);
  const [selected, setSelected] = React.useState<number[]>([]);
  const [rangeStart, setRangeStart] = React.useState<number>();
  const [ranges, setRanges] = React.useState<ReceiptRange[]>([]);
  const [rangesReady, setRangesReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState('');
  const [error, setError] = React.useState('');
  const [showGeneration, setShowGeneration] = React.useState(false);
  const [plan, setPlan] = React.useState<GenerationPlan>();
  const [regeneration, setRegeneration] = React.useState<RegenerationPlan>();
  const [removal, setRemoval] = React.useState<RemovalPlan>();
  const [typedYear, setTypedYear] = React.useState('');
  const [recordCount, setRecordCount] = React.useState<number>();
  const dialog = React.useRef<HTMLDivElement>(null);
  const generationButton = React.useRef<HTMLButtonElement>(null);
  const regenerationButton = React.useRef<HTMLButtonElement>(null);
  const removalButton = React.useRef<HTMLButtonElement>(null);
  const confirming = !!plan || !!regeneration || !!removal;
  const assignedRange = ranges.find(range => range.assignedYear === year)?.start;
  const selectedRecords = records.filter(record => selected.indexOf(record.id) >= 0);
  const canPrint = selectedRecords.length > 0 && selectedRecords.every(record => record.cents > 0 && record.receiptNumber !== undefined);
  const canRegenerate = selectedRecords.length > 0 && selectedRecords.every(record => record.receiptNumber !== undefined);
  const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: settings.currency });

  React.useEffect(() => {
    let active = true;
    setRecords([]); setSelected([]); setRangeStart(undefined); setPlan(undefined); setRegeneration(undefined); setRemoval(undefined); setRecordCount(undefined);
    setRangesReady(false); setRanges([]); setError(''); setNotice('Loading contribution records and receipt ranges…'); setBusy(true);
    service.getYearRecordCount(year).then(count => {
      if (active) setRecordCount(count);
      return Promise.all([service.loadContributions(year), service.getReceiptRanges()]);
    }).then(([items, options]) => {
      if (active) {
        setRecords(items); setRanges(options); setRangesReady(true);
        setNotice(items.length ? `${items.length} member records for ${year}.` : `No saved contributions for ${year}. Generate annual records first.`);
      }
    }).catch(reason => { if (active) { setError(message(reason)); setNotice(''); } }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [service, year]);
  React.useEffect(() => { if (confirming) dialog.current?.focus(); }, [confirming]);
  React.useEffect(() => { if (rangesReady) setRangeStart(assignedRange); }, [rangesReady, assignedRange, ranges]);

  async function reload(): Promise<void> {
    setBusy(true); setError(''); setSelected([]); setRangesReady(false); setRecordCount(undefined);
    try {
      setRecordCount(await service.getYearRecordCount(year));
      const [items, options] = await Promise.all([service.loadContributions(year), service.getReceiptRanges()]);
      setRecords(items); setRanges(options); setRangesReady(true); setRangeStart(undefined);
      setNotice(`${items.length} member records for ${year}.`);
    } catch (reason) { setRecords([]); setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function previewRemoval(): Promise<void> {
    setBusy(true); setError(''); setTypedYear('');
    try { setRemoval(await service.prepareRemoval(year)); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(false); }
  }
  async function confirmRemoval(): Promise<void> {
    if (!removal || busy || typedYear !== String(removal.year)) return;
    setBusy(true); setError('');
    try {
      const count = await service.removeYear(removal, typedYear, setNotice);
      setNotice(`Removed ${count} receipt records for ${year}. Receipt number assignments were preserved. You can generate this year again.`);
      setRecords([]); setSelected([]); setRangeStart(undefined);
      setRanges(await service.getReceiptRanges()); setRangesReady(true);
    } catch (reason) { setError(message(reason)); setNotice(''); setRecords([]); setSelected([]); }
    finally {
      try { setRecordCount(await service.getYearRecordCount(year)); }
      catch (reason) { setRecordCount(undefined); setError(message(reason)); }
      setRemoval(undefined); setBusy(false); removalButton.current?.focus();
    }
  }
  async function previewAnnual(): Promise<void> {
    if (rangeStart === undefined) { setError('Select a receipt start range before generating records.'); return; }
    setBusy(true); setError(''); setNotice('Validating source data and calculating annual totals…');
    try { setPlan(await service.prepare(year, rangeStart)); setNotice('Review the generation summary.'); }
    catch (reason) { setError(message(reason)); setNotice(''); }
    finally { setBusy(false); }
  }
  async function previewRegeneration(): Promise<void> {
    setBusy(true); setError(''); setNotice('Recalculating selected members from Revenue Transactions…');
    try { setRegeneration(await service.prepareRegeneration(year, selectedRecords)); setNotice('Review the existing and updated totals.'); }
    catch (reason) { setError(message(reason)); setNotice(''); }
    finally { setBusy(false); }
  }
  function cancel(): void {
    const selectedUpdate = !!regeneration;
    const removing = !!removal;
    setPlan(undefined); setRegeneration(undefined); setRemoval(undefined); setNotice('Cancelled. Contribution records were left unchanged.');
    (removing ? removalButton : selectedUpdate ? regenerationButton : generationButton).current?.focus();
  }
  async function confirm(): Promise<void> {
    if (busy || (!plan && !regeneration)) return;
    const selectedUpdate = !!regeneration;
    setBusy(true); setError('');
    try {
      const count = regeneration ? await service.regenerate(regeneration, setNotice) : await service.generate(plan as GenerationPlan, setNotice);
      const [items, options] = await Promise.all([service.loadContributions(year), service.getReceiptRanges()]);
      setRecords(items); setRanges(options); setRangesReady(true); setSelected([]);
      setNotice(selectedUpdate ? `Updated ${count} existing receipt records. Item IDs and receipt numbers were preserved.`
        : `Generated ${count} numbered contribution records for ${year}. Existing number assignments were preserved.`);
      if (!selectedUpdate) setShowGeneration(false);
    } catch (reason) {
      setError(message(reason)); setNotice('');
      // Failed selected updates remain available for a new preview; printing is blocked by the server-side job state.
      try { setRecords(await service.loadContributions(year)); setSelected([]); } catch { setRecords([]); setSelected([]); }
    } finally {
      try { setRecordCount(await service.getYearRecordCount(year)); } catch { setRecordCount(undefined); }
      setPlan(undefined); setRegeneration(undefined); setBusy(false);
      (selectedUpdate ? regenerationButton : generationButton).current?.focus();
    }
  }
  async function print(): Promise<void> {
    const receiptWindow = window.open('', '_blank');
    if (!receiptWindow) { setError('Allow popups for this SharePoint site to open receipts.'); return; }
    receiptWindow.opener = null;
    receiptWindow.document.body.textContent = 'Preparing contribution receipts…';
    setBusy(true); setError('');
    try {
      const latest = await service.loadContributions(year, true);
      const chosen = latest.filter(item => selected.indexOf(item.id) >= 0);
      if (!chosen.length || chosen.length !== selected.length || chosen.some(item => !records.some(old => old.id === item.id && old.etag === item.etag))) {
        throw new Error('Contribution records changed. Reload the year and select members again.');
      }
      const html = receiptHtml(chosen, settings.currency);
      receiptWindow.document.open(); receiptWindow.document.write(html); receiptWindow.document.close();
      await Promise.all(Array.from(receiptWindow.document.images).map(image => image.decode()));
      const printButton = receiptWindow.document.getElementById('print') as HTMLButtonElement | null;
      if (printButton) {
        printButton.disabled = false;
        printButton.textContent = 'Print / Save as PDF';
        printButton.addEventListener('click', () => receiptWindow.print());
      }
      receiptWindow.focus(); setNotice(`Opened ${chosen.length} receipts. Use Print / Save as PDF in the receipt window.`);
    } catch (reason) { receiptWindow.close(); setError(message(reason)); }
    finally { setBusy(false); }
  }
  function trapFocus(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && !busy) { event.preventDefault(); cancel(); }
    if (event.key !== 'Tab') return;
    const buttons = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
    if (!buttons || !buttons.length) { event.preventDefault(); return; }
    const first = buttons[0]; const last = buttons[buttons.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first.focus(); }
  }

  return <section className={styles.app} aria-label="Member contributions" aria-busy={busy}>
    <div className={styles.header}><div><h2>Member contributions</h2><p>Generate numbered annual records, update existing receipts, and print.</p></div>
      <button disabled={busy || confirming || recordCount !== 0} onClick={() => setShowGeneration(!showGeneration)}>Generate Annual Records</button></div>
    <div className={styles.controls}><label>Contribution year <select value={year} disabled={busy || confirming} onChange={event => setYear(Number(event.target.value))}>
      {availableYears().map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <button disabled={busy || confirming} onClick={() => { reload().catch(reason => setError(message(reason))); }}>Reload members and ranges</button></div>
    {recordCount !== undefined && recordCount > 0 && <div className={styles.warning} role="status">
      <p>Receipts already exist for {year} ({recordCount} records). Regenerate selected receipts to update totals, or remove this year’s records before generating again.</p>
      <button ref={removalButton} disabled={busy || confirming} onClick={() => { previewRemoval().catch(reason => setError(message(reason))); }}>Remove Year’s Receipts</button>
    </div>}
    {showGeneration && <div className={styles.generation}><h3>Generate annual records for {year}</h3>
      <p>Only members with positive annual totals receive records. Each year uses one receipt range; existing assignments are retained.</p>
      {assignedRange !== undefined && <p>Receipt range {assignedRange} is permanently assigned to {year}. All receipts for this year must use this range, including recreated records and new members.</p>}
      <label>Receipt start range <select required value={rangeStart === undefined ? '' : rangeStart} disabled={busy || confirming || !rangesReady || assignedRange !== undefined} onChange={event => setRangeStart(event.target.value ? Number(event.target.value) : undefined)}>
        <option value="">Select a start range</option>{receiptRangeStarts.map(start => {
          const owner = ranges.find(range => range.start === start)?.assignedYear;
          return <option key={start} value={start} disabled={owner !== undefined && owner !== year}>{start}{owner !== undefined ? ` — assigned to ${owner}` : ' — available'}</option>;
        })}</select></label>
      <div className={styles.controls}><button ref={generationButton} disabled={busy || confirming || recordCount !== 0 || !rangesReady || rangeStart === undefined} onClick={() => { previewAnnual().catch(reason => setError(message(reason))); }}>Generate</button></div></div>}
    {notice && <p className={styles.notice} role="status" aria-live="polite">{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.controls}>
      <button disabled={busy || confirming || !records.length} onClick={() => setSelected(records.map(item => item.id))}>Select All</button>
      <button disabled={busy || confirming || !selected.length} onClick={() => setSelected([])}>Clear Selection</button><span>{selected.length} selected</span>
      <button ref={regenerationButton} disabled={busy || confirming || !canRegenerate} onClick={() => { previewRegeneration().catch(reason => setError(message(reason))); }}>Regenerate Selected Receipts</button>
      <button className={styles.primary} disabled={busy || confirming || !canPrint} onClick={() => { print().catch(reason => setError(message(reason))); }}>Print Selected Receipts</button>
    </div>
    {!!records.length && <p>Zero or negative totals remain available for updates but cannot be printed. To number legacy records, remove the year’s records and generate again.</p>}
    {!!records.length && <div className={styles.tableWrapper}><table><caption>Member records for {year}</caption><thead><tr><th scope="col">Select</th><th scope="col">Member</th><th scope="col">Receipt number</th><th scope="col">Total contribution</th></tr></thead>
      <tbody>{records.map(item => <tr key={item.id}><td><input type="checkbox" aria-label={`Select ${item.memberName}, item ${item.id}`} disabled={busy || confirming}
        checked={selected.indexOf(item.id) >= 0} onChange={event => { const checked = event.target.checked; setSelected(previous => checked ? [...previous, item.id] : previous.filter(id => id !== item.id)); }} /></td>
        <td>{item.memberName}</td><td>{item.receiptNumber === undefined ? 'Not assigned' : formatReceiptNumber(item.receiptNumber)}</td><td>{money.format(item.cents / 100)}</td></tr>)}</tbody></table></div>}
    {confirming && <div className={styles.overlay}><div className={styles.dialog} role="dialog" aria-modal="true" aria-label={removal ? `Confirm removal for ${year}` : regeneration ? 'Confirm selected receipt updates' : `Confirm annual generation for ${year}`} tabIndex={-1} ref={dialog} onKeyDown={trapFocus}>
      {removal && <><h3>Remove receipts for {removal.year}</h3>
        <p className={styles.warning}>This deletes all {removal.existing.length} Member Contributions records for {removal.year}. The application cannot undo this removal.</p>
        <p>Members, Revenue Transactions, receipt number assignments, and range ownership are preserved. Members keep their assigned receipt numbers when this year is generated again; contribution item IDs will change.</p>
        <label>Type {removal.year} to confirm <input value={typedYear} disabled={busy} onChange={event => setTypedYear(event.target.value)} /></label></>}
      {plan && <><h3>Confirm annual generation for {plan.year}</h3><p>{plan.contributions.length} contributing members. Start range: {plan.rangeStart}–{plan.rangeStart + 99999}.</p>
        <p>New assignments use this range. Previously assigned receipt numbers remain with their members.</p>
        {plan.ignoredTransactions > 0 && <p>{plan.ignoredTransactions} transactions without a member reference will be excluded.</p>}
        {!plan.contributions.length && <p className={styles.warning}>No members have a positive total. Continuing will leave this year without contribution records.</p>}</>}
      {regeneration && <><h3>Update existing receipts for {regeneration.year}</h3><p>Only totals will change. Item IDs, receipt numbers, member lookups, and contribution years will be preserved.</p>
        <div className={styles.tableWrapper}><table><thead><tr><th>Member / receipt</th><th>Existing total</th><th>Updated total</th></tr></thead><tbody>
          {regeneration.updates.map(update => <tr key={update.existing.id}><td>{update.existing.memberName}<br />{formatReceiptNumber(update.existing.receiptNumber as number)}</td>
            <td>{money.format(update.existing.cents / 100)}</td><td>{money.format(update.cents / 100)}</td></tr>)}
        </tbody></table></div><p>Zero or negative updated totals will not be printable. No new contribution records or numbers will be created.</p></>}
      <div className={styles.controls}><button disabled={busy} onClick={cancel}>Cancel</button><button className={styles.primary} disabled={busy || (!!removal && (typedYear !== String(removal.year) || !removal.existing.length))} onClick={() => { (removal ? confirmRemoval() : confirm()).catch(reason => setError(message(reason))); }}>{removal ? 'Remove year’s receipts' : regeneration ? 'Update existing receipts' : 'Create numbered records'}</button></div>
      {busy && <p role="status">{notice}</p>}
    </div></div>}
  </section>;
}
