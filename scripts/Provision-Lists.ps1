<#
Validates the existing Member Contributions list without changing it.
Creates or configures the generation-status and permanent receipt-number tracking lists. Source lists are not modified.
Requires PnP.PowerShell and an Entra application client ID for interactive sign-in.
#>
[CmdletBinding()]
param(
    [string]$SiteUrl = 'https://btcogca.sharepoint.com/sites/finance',
    [Parameter(Mandatory = $true)][string]$ClientId,
    [string]$ContributionsList = 'Member Contributions',
    [string]$MembersList = 'Members',
    [string]$JobsList = 'Contribution Generation Jobs',
    [string]$RangesList = 'Receipt Number Ranges',
    [string]$AssignmentsList = 'Receipt Number Assignments',
    [switch]$RepairYearUniqueness
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion -lt [version]'7.4.0') {
    $pwshCandidates = @(
        (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe')
        (Get-Command pwsh.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
    foreach ($pwshPath in $pwshCandidates) {
        $pwshVersion = & $pwshPath -NoProfile -Command '$PSVersionTable.PSVersion.ToString()'
        if ($LASTEXITCODE -ne 0 -or [version]$pwshVersion -lt [version]'7.4.0') { continue }
        Write-Host "Switching from PowerShell $($PSVersionTable.PSVersion) to PowerShell $pwshVersion."
        $repairArgs = @()
        if ($RepairYearUniqueness) { $repairArgs = @('-RepairYearUniqueness') }
        & $pwshPath -NoProfile -ExecutionPolicy RemoteSigned -File $PSCommandPath `
            -ClientId $ClientId -SiteUrl $SiteUrl -ContributionsList $ContributionsList `
            -MembersList $MembersList -JobsList $JobsList -RangesList $RangesList -AssignmentsList $AssignmentsList @repairArgs
        if ($LASTEXITCODE -ne 0) { throw "Provisioning in PowerShell 7 failed (exit code $LASTEXITCODE). See the message above." }
        return
    }
    throw @'
This script needs PowerShell 7.4 or newer. The current shell is Windows PowerShell 5.1.
Install PowerShell 7 with: winget install --id Microsoft.PowerShell --exact --source winget
Then run this script again. Installing PowerShell 7 does not change the version of an already-open terminal.
'@
}
if (-not (Get-Module -ListAvailable -Name PnP.PowerShell)) {
    throw 'PnP.PowerShell is missing in PowerShell 7. Open pwsh, run Install-Module PnP.PowerShell -Scope CurrentUser, then retry this script.'
}
Import-Module PnP.PowerShell -ErrorAction Stop
Connect-PnPOnline -Url $SiteUrl -Interactive -ClientId $ClientId

function Ensure-List([string]$Title) {
    $list = Get-PnPList -Identity $Title -ErrorAction SilentlyContinue
    if (-not $list) {
        $list = New-PnPList -Title $Title -Template GenericList -OnQuickLaunch:$false
    }
    return $list
}
function Ensure-Field([string]$List, [string]$Name, [string]$Type, [string]$Xml) {
    $field = Get-PnPField -List $List -Identity $Name -ErrorAction SilentlyContinue
    if (-not $field) {
        Add-PnPFieldFromXml -List $List -FieldXml $Xml | Out-Null
    } elseif ($field.TypeAsString -ne $Type) {
        throw "Existing column $List.$Name is $($field.TypeAsString), expected $Type. Resolve the schema before provisioning."
    }
}

function Ensure-YearAllowsDuplicates([string]$List) {
    $yearField = Get-PnPField -List $List -Identity 'ContributionYear' -Includes EnforceUniqueValues -ErrorAction Stop
    if (-not $yearField.EnforceUniqueValues) { return }
    if (-not $RepairYearUniqueness) {
        throw "$List.ContributionYear incorrectly enforces unique years. Set its Enforce unique values option to No, or rerun this script with -RepairYearUniqueness. ReceiptNumber must remain unique."
    }
    Set-PnPField -List $List -Identity 'ContributionYear' -Values @{ EnforceUniqueValues = $false; Indexed = $true } | Out-Null
    Write-Host "Corrected $List.ContributionYear: duplicate years allowed; index retained. No records or receipt numbers were changed."
}

$existingContributions = Get-PnPList -Identity $ContributionsList -ErrorAction Stop
foreach ($definition in @(
    @{ Name = 'MemberName'; Types = @('Lookup') },
    @{ Name = 'TotalContribution'; Types = @('Currency', 'Number') },
    @{ Name = 'ContributionYear'; Types = @('Number') },
    @{ Name = 'ReceiptNumber'; Types = @('Number') }
)) {
    $field = Get-PnPField -List $existingContributions -Identity $definition.Name -ErrorAction Stop
    if ($field.TypeAsString -notin $definition.Types) {
        throw "Existing column $ContributionsList.$($definition.Name) must be $($definition.Types -join ' or '). No contribution list columns were changed."
    }
}
$receiptField = Get-PnPField -List $existingContributions -Identity 'ReceiptNumber' -Includes EnforceUniqueValues
if (-not $receiptField.EnforceUniqueValues) {
    throw 'Member Contributions.ReceiptNumber must enforce unique values. Enable the unique flag on the existing Number column before continuing.'
}
Ensure-YearAllowsDuplicates $ContributionsList

$members = Get-PnPList -Identity $MembersList -ErrorAction Stop
$memberLookup = Get-PnPField -List $existingContributions -Identity 'MemberName' -Includes LookupList,LookupField -ErrorAction Stop
if ($memberLookup.LookupField -ne 'Title' -or $memberLookup.LookupList.Trim('{}') -ne $members.Id.ToString()) {
    throw 'MemberName must be a single lookup to the Title field of the configured Members list. No contribution list columns were changed.'
}

Ensure-List $JobsList | Out-Null
Ensure-Field $JobsList 'RunState' 'Text' '<Field Type="Text" Name="RunState" StaticName="RunState" DisplayName="Run State" Required="TRUE" MaxLength="255" />'
Ensure-Field $JobsList 'RunMessage' 'Note' '<Field Type="Note" Name="RunMessage" StaticName="RunMessage" DisplayName="Run Message" NumLines="6" RichText="FALSE" />'
Ensure-Field $JobsList 'RunKind' 'Text' '<Field Type="Text" Name="RunKind" StaticName="RunKind" DisplayName="Run Kind" MaxLength="255" />'
Set-PnPField -List $JobsList -Identity 'Title' -Values @{ Indexed = $true; EnforceUniqueValues = $true; Required = $true } | Out-Null
Set-PnPView -List $JobsList -Identity 'All Items' -Fields 'Title','RunState','RunMessage','Modified' | Out-Null
Ensure-List $RangesList | Out-Null
Ensure-Field $RangesList 'AssignedYear' 'Number' '<Field Type="Number" Name="AssignedYear" StaticName="AssignedYear" DisplayName="Assigned Year" Required="TRUE" Decimals="0" />'
Set-PnPField -List $RangesList -Identity 'Title' -Values @{ Indexed = $true; EnforceUniqueValues = $true; Required = $true } | Out-Null

Ensure-List $AssignmentsList | Out-Null
Ensure-Field $AssignmentsList 'MemberId' 'Number' '<Field Type="Number" Name="MemberId" StaticName="MemberId" DisplayName="Member ID" Required="TRUE" Decimals="0" />'
Ensure-Field $AssignmentsList 'ContributionYear' 'Number' '<Field Type="Number" Name="ContributionYear" StaticName="ContributionYear" DisplayName="Contribution Year" Required="TRUE" Decimals="0" Indexed="TRUE" />'
Ensure-Field $AssignmentsList 'RangeStart' 'Number' '<Field Type="Number" Name="RangeStart" StaticName="RangeStart" DisplayName="Range Start" Required="TRUE" Decimals="0" />'
Ensure-Field $AssignmentsList 'ReceiptNumber' 'Number' '<Field Type="Number" Name="ReceiptNumber" StaticName="ReceiptNumber" DisplayName="Receipt Number" Required="TRUE" Decimals="0" Indexed="TRUE" EnforceUniqueValues="TRUE" />'
Ensure-YearAllowsDuplicates $AssignmentsList
Set-PnPField -List $AssignmentsList -Identity 'Title' -Values @{ Indexed = $true; EnforceUniqueValues = $true; Required = $true } | Out-Null
Set-PnPField -List $AssignmentsList -Identity 'ReceiptNumber' -Values @{ Indexed = $true; EnforceUniqueValues = $true } | Out-Null
Set-PnPField -List $AssignmentsList -Identity 'ContributionYear' -Values @{ Indexed = $true } | Out-Null
Write-Host 'Supporting lists are ready. Restrict writes to authorized finance users. Preserve the range and assignment lists permanently, including after annual record deletion.'
