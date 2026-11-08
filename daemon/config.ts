// The personal settings of one install. `bin/setup` asks for them and writes `.env`; `npm start` and the
// login service load that file. Every value has a neutral default, so the tests and `npm run preview` run without it.
const env = process.env;
const list = (v: string | undefined) => (v ?? '').split(',').map(s => s.trim()).filter(Boolean);

/** The person Jarvis works for, as their email sign-off writes it ("Ada Lovelace"). */
export const OWNER_NAME = env.JARVIS_OWNER_NAME?.trim() || 'Owner Name';
/** The owner's company and one line on what it does, for the email triage prompt. */
export const COMPANY = env.JARVIS_COMPANY?.trim() || 'Example Co';
export const COMPANY_ABOUT = env.JARVIS_COMPANY_ABOUT?.trim() || 'a software company that serves car dealers';
/** The Gmail account `gws` reads. */
export const GMAIL_ACCOUNT = env.JARVIS_GMAIL_ACCOUNT?.trim() || 'owner@example.test';
/** Every address of the owner, so reply all never sends to them. The Gmail profile address is added at run time. */
export const OWNER_EMAILS = list(env.JARVIS_OWNER_EMAILS).length ? list(env.JARVIS_OWNER_EMAILS) : [GMAIL_ACCOUNT];
/** The ticket reference prefix of the support desk the reply worker answers (`TICKET-1045`). */
export const TICKET_PREFIX = (env.JARVIS_TICKET_PREFIX?.trim() || 'TICKET').toUpperCase();
/** The MCP servers of the product the workers act on. Empty means not configured. */
export const PROD_MCP_URL = env.JARVIS_PROD_MCP_URL?.trim() || 'https://app.example.test/api/mcp';
export const STAGING_MCP_URL = env.JARVIS_STAGING_MCP_URL?.trim() || 'https://staging.app.example.test/api/mcp';
/** The product the workers act on. Its MCP servers are `<key>-prod` and `<key>-staging`, its project card is
 * `vault/projects/<key>.md`, and jarvisd reads its production MCP key from `data/<key>-prod-mcp.key`. */
const key = (env.JARVIS_PRODUCT_KEY?.trim() || '').toLowerCase();
export const PRODUCT_KEY = /^[a-z][a-z0-9-]{0,39}$/.test(key) ? key : 'acmeapp';
export const PRODUCT_LABEL = env.JARVIS_PRODUCT_LABEL?.trim() || 'AcmeApp';
/** The product repo (owner/name) whose merged PRs the support reply watch follows. */
export const SUPPORT_REPO = env.JARVIS_SUPPORT_REPO?.trim() || 'example-org/acmeapp_nextjs';
/** What the support desk appends to a staff member's name in a ticket thread, so their messages never count as the customer's. */
export const SUPPORT_STAFF_SUFFIX = env.JARVIS_SUPPORT_STAFF_SUFFIX?.trim() || '(support Exampleco)';
/** How the app, jarvisd's messages to the brain and the worker briefs name the owner ("Ada"). The default is "the owner". */
export const OWNER = env.JARVIS_OWNER_CALLED?.trim() || 'the owner';
export const OWNER_CAP = OWNER.charAt(0).toUpperCase() + OWNER.slice(1);
/** The dealer list the migration list seeds from once, on the first start. A local file keeps a real list out of the repo. */
export const DEALERS_FILE = env.JARVIS_DEALERS_FILE?.trim() || '';
/** Words of the email triage prompt: "<owner name>, <role> <company>", the team's first names, and what the clients are called. */
export const OWNER_ROLE = env.JARVIS_OWNER_ROLE?.trim() || 'who runs';
export const TEAM = list(env.JARVIS_TEAM);
export const CLIENT_WORD = env.JARVIS_CLIENT_WORD?.trim() || 'client';
export const CLIENTS_WORD = env.JARVIS_CLIENTS_WORD?.trim() || 'clients';
/** Refs whose merged branches count as delivered, besides master, such as an archived history kept only on this Mac. */
export const DONE_REFS = list(env.JARVIS_DONE_REFS).filter(r => /^[\w./-]+$/.test(r) && !r.startsWith('-'));
