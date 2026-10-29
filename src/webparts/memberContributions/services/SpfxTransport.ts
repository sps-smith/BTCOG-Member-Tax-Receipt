import { SPHttpClient, SPHttpClientResponse } from '@microsoft/sp-http';
import { RestTransport } from './ContributionService';

export class SpfxTransport implements RestTransport {
  public constructor(private readonly client: SPHttpClient) {}
  public get<T>(url: string): Promise<T> { return this.request<T>(url); }
  public post<T>(url: string, body: unknown, headers: { [key: string]: string } = {}): Promise<T> {
    return this.request<T>(url, body, headers, true);
  }
  private async request<T>(url: string, body?: unknown, extraHeaders: { [key: string]: string } = {}, post: boolean = false): Promise<T> {
    for (let attempt = 0; attempt < 4; attempt++) {
      const headers = { Accept: 'application/json;odata=minimalmetadata', 'Content-Type': 'application/json;odata=nometadata', 'OData-Version': '', ...extraHeaders };
      const response: SPHttpClientResponse = post
        ? await this.client.post(url, SPHttpClient.configurations.v1, { headers, body: body === undefined ? undefined : JSON.stringify(body) })
        : await this.client.get(url, SPHttpClient.configurations.v1, { headers });
      if ((response.status === 429 || response.status === 503) && attempt < 3) {
        const retry = response.headers.get('Retry-After');
        const seconds = retry ? Number(retry) : NaN;
        const dateWait = retry ? Date.parse(retry) - Date.now() : NaN;
        const wait = Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(dateWait) ? dateWait : 1000 * Math.pow(2, attempt);
        await new Promise(resolve => window.setTimeout(resolve, Math.max(1000, Math.min(wait, 60000))));
        continue;
      }
      if (!response.ok) {
        let message = response.statusText;
        try {
          const detail = await response.json();
          const error = detail.error || detail['odata.error'];
          message = error && error.message ? (error.message.value || error.message) : message;
        } catch { /* Retain the HTTP status when SharePoint returns a non-JSON error. */ }
        throw new Error(`SharePoint ${response.status}: ${String(message)}`);
      }
      if (response.status === 204) return undefined as unknown as T;
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    throw new Error('SharePoint is busy. Try again later.');
  }
}
