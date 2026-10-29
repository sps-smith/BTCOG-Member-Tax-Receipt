# BTCOG Member Contributions

React SharePoint Framework web part for the finance site at https://btcogca.sharepoint.com/sites/finance.

The web part totals Revenue Transactions by their Members lookup for the selected calendar year, creates numbered records for members with positive totals, and produces one printable receipt page per selected member. Select one or multiple existing records to recalculate their totals in place, preserving their SharePoint item IDs and receipt numbers. The receipt window supports browser printing and **Save as PDF**.

## Build

Use **Node.js 22.14 or newer within Node 22**. The project uses SPFx 1.23.2, React 17.0.1, and the Microsoft Heft toolchain.

For **Cmder using a CMD tab**, use the project launcher. It selects the project-local Node 22 runtime when present, otherwise a Node 22 installation on PATH. It invokes npm by its full path; no manual PATH changes or global Heft installation are needed.

```bat
cd /d C:\PhilDev\BTCOG-Member-Tax-Receipt
dev.cmd doctor
dev.cmd trust-cert
dev.cmd start
```

Run `trust-cert` once and accept the certificate prompt. Keep the terminal open while the server runs; stop it with Ctrl+C. The workbench opens at https://btcogca.sharepoint.com/sites/finance/_layouts/15/workbench.aspx. Add **Member Contributions** with the **+** button. To start without opening a browser, use `dev.cmd start --nobrowser`.

Other launcher commands:

```bat
dev.cmd install
dev.cmd test
dev.cmd build
```

`install` restores the locked dependencies with `npm ci`; use it on a new checkout or if dependencies are missing. `doctor` displays the exact Node/npm paths and checks the Node version. If neither a complete local runtime nor a Node 22 installation exists, the launcher explains what to install. The ignored `.local-runtime` folder is not included in a fresh Git clone.

With Node 22 and npm already on PATH, the standard commands also work:

```powershell
npm ci
npm test
npm run build
```

The production package is `sharepoint/solution/btcog-member-contributions.sppkg`.

If using the project-local runtime downloaded during development, prepend it to PATH in the current terminal:

```powershell
$env:PATH = "$PWD\.local-runtime\node-v22.22.0-win-x64;$env:PATH"
& .\.local-runtime\node-v22.22.0-win-x64\npm.cmd test
& .\.local-runtime\node-v22.22.0-win-x64\npm.cmd run build
```

The local runtime is ignored by Git. A normal Node 22 installation is sufficient on another machine.

## Prepare SharePoint

The **Member Contributions list already exists**, including the user's **ReceiptNumber** column (Number, unique, zero decimal places). The web part and setup script do not create that list or add columns to it. Run the updated provisioning script once before using receipt numbering: it validates the existing contribution columns and creates or configures the generation-status list and two permanent receipt tracking lists. It does not change Member Contributions, Revenue Transactions, or Members. PnP interactive sign-in requires your organization's Entra application client ID and an account/app with permission to manage lists at the Finance site.

```powershell
Install-Module PnP.PowerShell -Scope CurrentUser
./scripts/Provision-Lists.ps1 -ClientId '<your-Entra-application-client-id>'
```

The provisioning script requires PowerShell 7.4 or newer. When started from Windows PowerShell 5.1, it locates PowerShell 7 in the standard installation directory or on PATH and relaunches itself there before importing PnP. If no supported installation is found, it prints the installation command. Installing PowerShell 7 does not upgrade an already-open Windows PowerShell 5.1 session. To launch PowerShell 7 explicitly from Windows PowerShell, use `& "$env:ProgramFiles\PowerShell\7\pwsh.exe"`.

The contribution and supporting lists use these internal names:

| List | Columns |
| --- | --- |
| Member Contributions | ID (built-in item key), MemberName (single lookup to Members.Title), TotalContribution (Currency or Number), ContributionYear (Number), ReceiptNumber (unique Number) |
| Contribution Generation Jobs | Title (unique Text containing year), RunState (Text), RunKind (Text: Annual or Regeneration), RunMessage (plain multiline Text) |
| Receipt Number Ranges | Title (unique Text containing start range), AssignedYear (Number) |
| Receipt Number Assignments | Title (unique Text containing year:memberId), MemberId (Number), ContributionYear (indexed Number), RangeStart (Number), ReceiptNumber (unique Number) |

**ContributionYear must allow duplicate values** in both Member Contributions and Receipt Number Assignments: many members share the same year. Only ReceiptNumber and the documented ledger keys enforce uniqueness. If SharePoint reports duplicate values in ContributionYear, set that column's **Enforce unique values** to **No**, or run the setup script with `-RepairYearUniqueness`. That explicit repair option removes only the incorrect ContributionYear uniqueness constraints and retains their indexes; it does not delete records or change receipt numbers. The default setup run validates this condition without altering the existing contribution list. After repair, retry the failed annual generation using the same year/range, or retry the same selected regeneration. Preserve both receipt tracking lists so reserved numbers are reused correctly.

The built-in **SharePoint item ID** is the key for each contribution record, selection, and update. The member relationship is stored in **MemberName**; REST writes its lookup ID through `MemberNameId` and reads the member name by expanding `MemberName/Title`. The Members lookup ID is distinct from the contribution item's own ID. No custom `MemberId` or `MemberYearKey` columns are needed on Member Contributions. The separate assignment ledger uses MemberId to preserve the member/year number history. **Regenerate Selected Receipts** updates existing contribution items and preserves their IDs. Annual generation is blocked while any contribution records exist for the selected year. A separate, confirmed removal action must be completed before generating again; member/year receipt assignments are retained.

Destination internal names are fixed; source column names are configurable. MemberName must be a single-value lookup to the configured Members list's Title field. Generation validates both lookup targets before deleting anything. If the existing list uses different internal names or incompatible column types, resolve the mapping before generation. The script reports schema conflicts without changing the contribution list.

The generation-status list prevents two web part sessions from replacing the same year simultaneously using its own unique year key and optimistic item version checks. Each successful generation creates one record per contributing member. Direct list edits can introduce duplicates; the web part's lock governs generation through the web part.

Restrict writes to the contribution and supporting lists to authorized finance personnel. Annual generation needs view/add/edit on Member Contributions; year removal needs view/delete on that list. Both operations also need view/add/edit on the job list, view/add on both receipt tracking lists, and read access to Revenue Transactions and Members. Selected regeneration only requires view/edit on Member Contributions, plus the same job/ledger permissions to track the run and import any existing receipt assignments. No ledger edit/delete permission is required for generation; withhold it from routine operators to protect permanent history. Receipt-only users need read access to Member Contributions, Members, and all three supporting lists for the selection screen. The web part checks these write permissions before acquiring a job and does not elevate access.

**Retain Receipt Number Ranges and Receipt Number Assignments permanently.** Never clear their contents when deleting annual contribution records. Restrict direct editing/deletion of these ledgers operationally; uniqueness and allocation depend on their retained history.

Index the source transaction date column before working with large source lists. Paging reads all query pages, but does not bypass SharePoint list-view thresholds. SharePoint item-level permissions must allow the operator to see **all relevant source transactions and members**; the application cannot detect records SharePoint silently hides from that user.

## Deploy and configure

1. Upload the `.sppkg` to the tenant or site app catalog and deploy it.
2. Add **Member Contributions** to a finance-site page.
3. Edit its property pane and set the exact source **internal column names**. Display names may differ. In SharePoint List Settings, open the column and read the `Field=` query parameter in the URL.

| Setting | Default | Expected value |
| --- | --- | --- |
| Finance site URL | https://btcogca.sharepoint.com/sites/finance | Site containing the source, destination, and supporting lists |
| Receipt ranges list | Receipt Number Ranges | Permanent range ownership list |
| Receipt assignments list | Receipt Number Assignments | Permanent member/year number ledger |
| Revenue transactions list | Revenue Transactions | Source list title |
| Members list | Members | Member list title |
| Transaction date | field_3 | Internal name of a Date and Time column configured as **Date Only** |
| Transaction amount | field_4 | Currency or Number internal name |
| Transaction member lookup | MemberName | Single-value lookup internal name, **without** `Id` suffix; must reference Members |
| Member full name | Title | Text or computed text internal name |
| Currency | CAD | ISO currency code |

The source mappings match the confirmed Revenue Transactions schema below. Existing Finance web parts using the old placeholder mappings `TransactionDate`, `Amount`, and `Member` upgrade automatically to `field_3`, `field_4`, and `MemberName`; custom mappings remain configurable. Generation validates field types and lookup target before any deletion. A multi-value member lookup is unsupported.

| Revenue Transactions display name | Internal name | Use in this report |
| --- | --- | --- |
| Title | Title | Source transaction label |
| Transaction Date | field_3 | Date Only annual filtering |
| Amount | field_4 | Member contribution totals |
| Transaction Currency | field_5 | Source currency metadata; no currency conversion is performed |
| Revenue Type | RevenueType | Source category metadata; no category restriction is specified |
| Member Name | MemberName | Lookup to Members; read its Members item ID via MemberNameId |
| Year | Year | Calculated YEAR metadata; annual inclusion is checked against field_3 |
| Month | Month | Calculated MONTH metadata; the report covers the full selected year |

The revenue transaction date is a **Date Only** field. In Revenue Transactions list settings, open the mapped date column and set its format to **Date Only**. SharePoint still identifies this as a `DateTime` field, with `DisplayFormat=0`; the web part validates that format before generation. It does not alter the source column or existing transactions automatically.

If an older build reports `column TransactionDate must be DateTime`, it means the configured internal name was missing or the column had another type; it does not mean Date Only is unsupported. Open **Revenue Transactions > List Settings > the date column**, copy the value after `Field=` in the URL (URL-decode it if needed), and enter that exact internal name in **Web part settings > Source column internal names > Transaction date column (Date Only)**. For example, a display name of `Transaction Date` may have internal name `Transaction_x0020_Date`. New builds distinguish a missing mapping from a wrong type and list the available custom date columns.

Annual source queries compare calendar dates on SharePoint, from January 1 inclusive to the next January 1 exclusive, using CAML `IncludeTimeValue=FALSE`. `DatesInUtc=false` returns site-local date values so a local January 1 cannot become December 31 through UTC serialization. The calculation preserves the returned calendar date without browser time-zone conversion. There is no reporting-time-zone setting; any such value on an older saved web part is ignored. Source queries page by increasing SharePoint item ID.

Currency affects receipt formatting; the source amounts must all use the same currency. Configure the destination SharePoint Currency column for that currency too.

## Operate

1. Choose the current year or one of the preceding four years.
2. Click **Generate Annual Records**, select a start range, then **Generate**. For a year with no history, the range has no default; users must choose 100000, 200000, through 900000. Once assigned, a year is permanently limited to that one range. The original range is automatically selected and the dropdown is locked when records are recreated. A range owned by another year is disabled and all ownership rules are checked again under the year lock during generation.
3. Review the calculated member count and any excluded transactions. No member lookup means a transaction is excluded and counted in the preview. Positive transactions and negative refunds are netted together. All linked revenue rows count; there is no category, approval-state, or tax-eligibility filter in the supplied requirements.
4. Confirm creation. If any records already exist for the selected year, annual generation is disabled and a message directs users to update selected receipts or remove the year’s records. The service rechecks under the year lock before creating anything, so a stale preview cannot replace records.
5. Select members or use **Select All**, then **Print Selected Receipts**. The receipt window displays the church name and registration number, year, receipt number, member name, annual total, and thank-you statement. Click **Print / Save as PDF**.

**Remove Year’s Receipts** shows the selected year and record count. Type the year exactly and confirm to delete only that year’s Member Contributions records. Cancellation leaves records unchanged. The operation first imports existing receipt numbers into the permanent ledgers, preserving member/year assignments and range ownership. Members and Revenue Transactions are untouched. After removal, generate again using the year’s original, locked range: returning members keep their receipt numbers, new members get new numbers, and contribution item IDs change. Conflicting or invalid numbered history must be corrected before removal can proceed.

For an updated total, select one or multiple existing numbered members and click **Regenerate Selected Receipts**. Review the existing and recalculated totals, then confirm **Update existing receipts**. This operation sends only TotalContribution changes using the existing item IDs and conditional item versions. It never creates or deletes Member Contributions items and never allocates a new receipt number. No range selection is required. Records whose new totals are zero or negative remain selectable for later updates but cannot be printed. Unnumbered legacy records require removing the year’s records and generating again; selected regeneration cannot assign them a new number.

A selected year of 2025 with sequence 100000 stores integer **2025100000** in ReceiptNumber and displays **2025-100000**. Sequence formatting is always six digits. The first new assignment uses the chosen start; later assignments increment by one in member-ID order. Each block holds 100000 numbers (100000–199999, 200000–299999, etc.). There are nine available blocks. A block used for one year is never available to a different year, even after contribution items are deleted. Numbers reserved by a failed run or removed members are retained; retries reuse the member's existing assignment, and gaps are never reassigned. Exhaustion is checked before contribution creation. An exhausted year cannot switch to a second range; generation stops for administrator review.

Existing numbered contribution records are checked across all visible years and imported into the permanent tracking lists before creation, removal, or updates. Conflicting historical range ownership, multiple ranges assigned to one year, or conflicting member/year assignments stop the operation for administrator review. Ownership is checked against range registrations, retained member/year assignments, and existing receipts, including after receipt removal. Previously issued numbers are never automatically renumbered. Operators must be able to see **all existing receipt records across years** for a complete initial import. History already deleted before the ledgers existed cannot be inferred; register any such historical ranges and assignments before issuing new numbers.

Receipts read the saved Member Contributions records, not live revenue transactions. Before opening receipts, the web part reloads and checks the records to avoid printing a selection that has changed since loading. Allow popups for the finance site.

Each receipt includes the supplied signature image, followed by **Secretary/Treasurer** and **Georgia Pryce**. The JPEG is embedded in the printable HTML; no separate image URL, SharePoint image permissions, or external download is needed. Printing remains disabled until the signature images have decoded. The signature block stays together when printing. To replace the authorized image in a future release, update `src/webparts/memberContributions/assets/georgia.jpg`, run `node scripts/embed-signature.cjs`, and rebuild. This embeds the original JPEG without changing its appearance.

Generation calculates and validates all source data before creation. Transactions are summed as integer cents. Invalid amounts, fractional cents, or missing names for contributing members stop the preview. Sources are a snapshot taken at preview time; if source transactions change during confirmation, cancel and preview again.

## Recovery and concurrency

SharePoint list writes are not a database transaction. A network interruption can leave an annual run partly created. The web part stops, marks the job Failed with RunKind=Annual, and blocks printing until annual generation completes. If records remain, use Remove Year’s Receipts before generating again; ledger assignments are retained and reused. If no records were created, generation can be retried directly.

Removal uses the same per-year lock as annual generation and selected regeneration, plus conditional item versions. If removal stops partway through, the job is marked Failed with RunKind=Removal. Record counts and the removal action remain available even while receipt loading is blocked. Reload and confirm removal again for the remaining records; generation stays blocked while any records remain. A changed removal preview stops without deleting records.

For a failed selected update, RunKind=Regeneration is retained. Reload, select the same members, preview their totals again, and retry **Regenerate Selected Receipts**. Existing items remain available for selection while printing remains blocked. Recovery updates those same IDs and numbers; it does not require a destructive annual replacement. Already completed writes are visible in the next preview.

If a browser closes or loses its connection before recording completion, a job may remain **Running**. Do not automatically expire it: the original browser could still be writing. An administrator should first verify the original session has stopped, inspect that year's destination records, then edit the job's RunState to **Failed** and rerun generation. Other years can continue independently. Users must not edit the job list while a generation is active.

The removal confirmation states that the web part cannot undo deletion. SharePoint recycle-bin and retention policies govern any administrator recovery. Direct edits to the destination lists bypass the application workflow; restrict them operationally and review any edits before issuing receipts.

## Local development and validation

`dev.cmd start` (Cmder/CMD) or `npm start` (with npm on PATH) opens the hosted workbench for the finance site. Trust the development certificate when prompted by SPFx and sign in to SharePoint. Test against a nonproduction site with representative source lists before generating production records.

`npm test` covers annual boundaries, positive-only creation, integer-cent arithmetic, duplicate names, source mappings, HTML escaping, numbering/formatting, cross-year and concurrent range claims, range exhaustion, retained assignments, selected update-only writes, zero totals, conflicts, partial failures and recovery, and paging. `npm run build` runs the SPFx compiler/linter, production bundle, and package creation.

Live tenant acceptance must confirm source mappings, complete source/receipt visibility, supporting-list setup, permissions, list indexing, cancellation, simultaneous range claims, selected regeneration preserving IDs/numbers, and print/PDF layout with long names. The package does not email receipts or add donor addresses.
