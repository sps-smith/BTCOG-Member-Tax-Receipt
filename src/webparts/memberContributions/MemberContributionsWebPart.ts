import * as React from 'react';
import * as ReactDom from 'react-dom';
import { Version } from '@microsoft/sp-core-library';
import { IPropertyPaneConfiguration, PropertyPaneTextField } from '@microsoft/sp-property-pane';
import { BaseClientSideWebPart } from '@microsoft/sp-webpart-base';
import ContributionsApp from './components/ContributionsApp';
import { ContributionSettings, resolveSettings } from './models';
import { ContributionService } from './services/ContributionService';
import { SpfxTransport } from './services/SpfxTransport';

export default class MemberContributionsWebPart extends BaseClientSideWebPart<ContributionSettings> {
  private service: ContributionService | undefined;
  private settingsKey: string = '';
  protected onInit(): Promise<void> {
    Object.assign(this.properties, resolveSettings(this.properties));
    return super.onInit();
  }
  public render(): void {
    const settings = resolveSettings(this.properties);
    let element: React.ReactElement;
    try {
      const key = JSON.stringify(settings);
      if (!this.service || key !== this.settingsKey) {
        this.service = new ContributionService(new SpfxTransport(this.context.spHttpClient), settings);
        this.settingsKey = key;
      }
      element = React.createElement(ContributionsApp, { service: this.service, settings });
    } catch (error) {
      element = React.createElement('p', { role: 'alert' }, `Check the web part settings: ${error instanceof Error ? error.message : String(error)}`);
    }
    ReactDom.render(element, this.domElement);
  }
  protected onDispose(): void { ReactDom.unmountComponentAtNode(this.domElement); }
  protected get dataVersion(): Version { return Version.parse('1.0'); }
  protected getPropertyPaneConfiguration(): IPropertyPaneConfiguration {
    return { pages: [{ header: { description: 'Map your SharePoint lists and column internal names.' }, groups: [
      { groupName: 'SharePoint lists', groupFields: [
        PropertyPaneTextField('siteUrl', { label: 'Finance site URL' }),
        PropertyPaneTextField('revenueList', { label: 'Revenue transactions list' }),
        PropertyPaneTextField('membersList', { label: 'Members list' }),
        PropertyPaneTextField('contributionsList', { label: 'Member contributions list' }),
        PropertyPaneTextField('jobsList', { label: 'Generation status list' }),
        PropertyPaneTextField('rangesList', { label: 'Receipt number ranges list' }),
        PropertyPaneTextField('assignmentsList', { label: 'Receipt number assignments list' })
      ] },
      { groupName: 'Source column internal names', groupFields: [
        PropertyPaneTextField('transactionDateField', {
          label: 'Transaction date column (Date Only)',
          description: 'Use the internal name shown after Field= in the column settings URL. The column display name can be different.'
        }),
        PropertyPaneTextField('transactionAmountField', { label: 'Transaction amount column' }),
        PropertyPaneTextField('transactionMemberField', { label: 'Transaction member lookup column (without Id suffix)' }),
        PropertyPaneTextField('memberNameField', { label: 'Member full name column' })
      ] },
      { groupName: 'Receipts', groupFields: [
        PropertyPaneTextField('currency', { label: 'Currency code (for example CAD)' })
      ] }
    ] }] };
  }
}
