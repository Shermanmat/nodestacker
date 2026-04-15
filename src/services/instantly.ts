/**
 * Instantly.ai API client for cold email outreach campaigns
 * Used to expand investor network by emailing pre-seed/seed investors
 */

const BASE_URL = 'https://api.instantly.ai/api/v2';
const API_KEY = process.env.INSTANTLY_API_KEY || null;

// Types

interface InstantlyResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

interface InstantlyCampaign {
  id: string;
  name: string;
  status: string;
}

interface InstantlyLead {
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  [key: string]: string | undefined; // custom variables
}

interface InstantlyAnalytics {
  campaign_id: string;
  sent_count: number;
  open_count: number;
  reply_count: number;
  bounced_count: number;
}

interface InstantlyLeadRecord {
  id: string;
  email: string;
  first_name?: string;
  last_name?: string;
  company_name?: string;
  status?: string;
  lead_data?: Record<string, unknown>;
  interest_status?: string;
}

// Core fetch helper

async function instantlyFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<InstantlyResult<T>> {
  if (!API_KEY) {
    console.log(`[INSTANTLY] No API key configured - would call ${options.method || 'GET'} ${path}`);
    return { success: true, data: undefined };
  }

  try {
    const url = `${BASE_URL}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      console.error(`[INSTANTLY] API error ${response.status}: ${text}`);
      return { success: false, error: `${response.status}: ${text}` };
    }

    const data = await response.json() as T;
    return { success: true, data };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[INSTANTLY] Request failed:`, errorMsg);
    return { success: false, error: errorMsg };
  }
}

// Campaign management

export async function createCampaign(
  name: string,
  accountEmail: string,
): Promise<InstantlyResult<{ id: string }>> {
  return instantlyFetch('/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name,
      account_ids: [accountEmail],
    }),
  });
}

export async function activateCampaign(
  campaignId: string,
): Promise<InstantlyResult> {
  return instantlyFetch(`/campaigns/${campaignId}/activate`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function pauseCampaign(
  campaignId: string,
): Promise<InstantlyResult> {
  return instantlyFetch(`/campaigns/${campaignId}/pause`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export async function listCampaigns(): Promise<InstantlyResult<InstantlyCampaign[]>> {
  return instantlyFetch('/campaigns');
}

export async function getCampaignAnalytics(
  campaignId: string,
): Promise<InstantlyResult<InstantlyAnalytics>> {
  return instantlyFetch(`/campaigns/analytics/overview?campaign_id=${campaignId}`);
}

// Lead management

export async function addLeadsBulk(
  campaignId: string,
  leads: InstantlyLead[],
): Promise<InstantlyResult> {
  // Instantly recommends batches of 500
  const BATCH_SIZE = 500;
  const batches = [];
  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    batches.push(leads.slice(i, i + BATCH_SIZE));
  }

  let totalAdded = 0;
  for (const batch of batches) {
    const result = await instantlyFetch('/leads', {
      method: 'POST',
      body: JSON.stringify({
        campaign_id: campaignId,
        leads: batch,
      }),
    });

    if (!result.success) {
      return { success: false, error: `Failed at batch starting at index ${totalAdded}: ${result.error}` };
    }
    totalAdded += batch.length;

    // Small delay between batches to stay under rate limits
    if (batches.length > 1) {
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`[INSTANTLY] Added ${totalAdded} leads to campaign ${campaignId}`);
  return { success: true, data: { added: totalAdded } };
}

export async function listLeads(
  campaignId: string,
  options: { limit?: number; starting_after?: string; interest_status?: string } = {},
): Promise<InstantlyResult<{ items: InstantlyLeadRecord[]; next_starting_after?: string }>> {
  const params = new URLSearchParams({ campaign_id: campaignId });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.starting_after) params.set('starting_after', options.starting_after);
  if (options.interest_status) params.set('interest_status', options.interest_status);

  return instantlyFetch(`/leads?${params.toString()}`);
}

/**
 * Fetch all leads from a campaign that have replied, paginating through results.
 */
export async function getAllRepliedLeads(
  campaignId: string,
): Promise<InstantlyResult<InstantlyLeadRecord[]>> {
  const allLeads: InstantlyLeadRecord[] = [];
  let cursor: string | undefined;

  while (true) {
    const result = await listLeads(campaignId, {
      limit: 100,
      starting_after: cursor,
    });

    if (!result.success || !result.data) {
      return { success: false, error: result.error || 'Failed to fetch leads' };
    }

    // Filter for leads that have replied
    const replied = result.data.items.filter(
      (l) => l.interest_status === 'replied' || l.interest_status === 'interested',
    );
    allLeads.push(...replied);

    if (!result.data.next_starting_after) break;
    cursor = result.data.next_starting_after;
  }

  return { success: true, data: allLeads };
}

// SuperSearch Enrichment

interface SuperSearchFilters {
  name?: string[];
  company_name?: { include?: string[]; exclude?: string[] };
  title?: { include?: string[]; exclude?: string[] };
  industry?: { include?: string[]; exclude?: string[] };
  subIndustry?: { include?: string[]; exclude?: string[] };
  locations?: { include?: { country?: string; state?: string; city?: string }[] };
  level?: string[];
  employeeCount?: string[];
  skip_owned_leads?: boolean;
  show_one_lead_per_company?: boolean;
}

interface SuperSearchPreviewLead {
  firstName: string;
  lastName: string;
  fullName: string;
  jobTitle: string;
  location: string;
  linkedIn: string;
  companyName: string;
  companyLogo?: string;
  companyId?: string;
}

interface SuperSearchCountResult {
  number_of_leads: number;
}

interface SuperSearchPreviewResult {
  number_of_leads: number;
  leads: SuperSearchPreviewLead[];
}

interface SuperSearchEnrichResult {
  id: string;
  resource_id: string;
  search_filters: SuperSearchFilters;
  limit: number;
  list_name?: string;
}

interface SuperSearchStatusResult {
  resource_id: string;
  in_progress: boolean;
  has_no_leads: boolean;
  exists: boolean;
}

export async function superSearchCount(
  filters: SuperSearchFilters,
): Promise<InstantlyResult<SuperSearchCountResult>> {
  return instantlyFetch('/supersearch-enrichment/count-leads-from-supersearch', {
    method: 'POST',
    body: JSON.stringify({ search_filters: filters }),
  });
}

export async function superSearchPreview(
  filters: SuperSearchFilters,
): Promise<InstantlyResult<SuperSearchPreviewResult>> {
  return instantlyFetch('/supersearch-enrichment/preview-leads-from-supersearch', {
    method: 'POST',
    body: JSON.stringify({ search_filters: filters }),
  });
}

export async function superSearchEnrich(
  filters: SuperSearchFilters,
  options: {
    limit: number;
    listName?: string;
    resourceId?: string;
    resourceType?: 1 | 2; // 1=campaign, 2=list
    searchName?: string;
  },
): Promise<InstantlyResult<SuperSearchEnrichResult>> {
  return instantlyFetch('/supersearch-enrichment/enrich-leads-from-supersearch', {
    method: 'POST',
    body: JSON.stringify({
      search_filters: filters,
      limit: options.limit,
      list_name: options.listName,
      resource_id: options.resourceId,
      resource_type: options.resourceType,
      search_name: options.searchName,
      work_email_enrichment: true,
      skip_rows_without_email: true,
    }),
  });
}

export async function superSearchStatus(
  resourceId: string,
): Promise<InstantlyResult<SuperSearchStatusResult>> {
  return instantlyFetch(`/supersearch-enrichment/${resourceId}`);
}

// Lead list management

export async function listLeadLists(): Promise<InstantlyResult<{ items: { id: string; name: string; lead_count: number }[] }>> {
  return instantlyFetch('/lead-lists');
}

export async function getLeadListLeads(
  listId: string,
  options: { limit?: number; starting_after?: string } = {},
): Promise<InstantlyResult<{ items: InstantlyLeadRecord[]; next_starting_after?: string }>> {
  const params = new URLSearchParams({ list_id: listId });
  if (options.limit) params.set('limit', String(options.limit));
  if (options.starting_after) params.set('starting_after', options.starting_after);
  return instantlyFetch(`/lead-lists/leads?${params.toString()}`);
}

/**
 * Fetch all leads from a lead list, paginating through results.
 */
export async function getAllLeadListLeads(
  listId: string,
): Promise<InstantlyResult<InstantlyLeadRecord[]>> {
  const allLeads: InstantlyLeadRecord[] = [];
  let cursor: string | undefined;

  while (true) {
    const result = await getLeadListLeads(listId, {
      limit: 100,
      starting_after: cursor,
    });

    if (!result.success || !result.data) {
      return { success: false, error: result.error || 'Failed to fetch leads' };
    }

    allLeads.push(...result.data.items);

    if (!result.data.next_starting_after) break;
    cursor = result.data.next_starting_after;
  }

  return { success: true, data: allLeads };
}

export function isConfigured(): boolean {
  return API_KEY !== null;
}
