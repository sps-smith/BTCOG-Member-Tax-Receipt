export interface ContributionSettings {
  siteUrl: string;
  revenueList: string;
  membersList: string;
  contributionsList: string;
  jobsList: string;
  rangesList: string;
  assignmentsList: string;
  transactionDateField: string;
  transactionAmountField: string;
  transactionMemberField: string;
  memberNameField: string;
  currency: string;
  sourceMappingVersion?: number;
}

export const defaultSettings: ContributionSettings = {
  siteUrl: 'https://btcogca.sharepoint.com/sites/finance',
  revenueList: 'Revenue Transactions',
  membersList: 'Members',
  contributionsList: 'Member Contributions',
  jobsList: 'Contribution Generation Jobs',
  rangesList: 'Receipt Number Ranges',
  assignmentsList: 'Receipt Number Assignments',
  transactionDateField: 'field_3',
  transactionAmountField: 'field_4',
  transactionMemberField: 'MemberName',
  memberNameField: 'Title',
  currency: 'CAD',
  sourceMappingVersion: 1
};

export function resolveSettings(saved: Partial<ContributionSettings>): ContributionSettings {
  const settings = { ...defaultSettings, ...saved };
  // Upgrade the placeholders saved by earlier builds of this Finance web part.
  // Preserve deliberate custom mappings and settings for other source lists.
  if (!saved.sourceMappingVersion && settings.revenueList.toLowerCase() === 'revenue transactions') {
    if (saved.transactionDateField === 'TransactionDate') settings.transactionDateField = 'field_3';
    if (saved.transactionAmountField === 'Amount') settings.transactionAmountField = 'field_4';
    if (saved.transactionMemberField === 'Member') settings.transactionMemberField = 'MemberName';
  }
  settings.sourceMappingVersion = 1;
  return settings;
}

export interface Transaction { memberId: number | undefined; amount: number; date: string; }
export interface Member { id: number; name: string; }
export interface AnnualContribution { memberId: number; memberName: string; cents: number; year: number; receiptNumber?: number; }
// id is the Member Contributions item's built-in SharePoint ID, not the Members lookup ID.
export interface SavedItem { id: number; etag: string; }
export interface SavedContribution extends AnnualContribution, SavedItem {}
export interface Calculation { contributions: AnnualContribution[]; ignoredTransactions: number; }
export interface GenerationPlan extends Calculation { existing: SavedItem[]; year: number; rangeStart: number; }
export interface ReceiptRange { start: number; assignedYear?: number; }
export interface RegenerationPlan { year: number; updates: { existing: SavedContribution; cents: number }[]; }
export interface RemovalPlan { year: number; existing: SavedItem[]; }
