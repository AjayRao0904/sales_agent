# Scout — local business sales agent

A working, single-operator sales workspace: discover businesses around a location, research public websites, create personalized website-service emails, send through SMTP, and track conversations in a CRM.

## Run locally

Requires Node.js 22.13 or newer. Node's built-in SQLite module is used; Node 22 may display an experimental-module warning.

```bash
npm install
npm run setup
npm run build
npm start
```

Open **http://127.0.0.1:3001**. On the first visit, create your workspace password. The app binds to this computer by default.

For frontend development:

```bash
npm run dev
```

Open http://127.0.0.1:5173. The API remains on port 3001. Stop the production server before starting development; both use the same backend port.

## First campaign

1. Open **Settings**. The provided sender accounts have been configured locally. Change their display names if needed. Verify SMTP after changing credentials.
2. Create a campaign. Enter a Maps link containing coordinates, a resolvable Maps short link, or `latitude,longitude`; click **Resolve** to confirm the centre.
3. Choose business categories, radius, sender, currency, price range, and the exact website-service scope.
4. Open **Discover** and select **Discover businesses**. Background jobs save and deduplicate listings, research websites, and generate drafts when enough information is available.
5. Open a prospect to review sources, contact details, website ideas, CRM stage, notes, and tasks. You can also add prospects manually.
6. Review messages in **Outreach**. Save edits and queue a draft. Activate the campaign when the offer is ready. Alternatively, turn on automatic queueing for an active campaign.
7. Sync **Inbox**, or enable automatic inbox sync in Settings, to import replies linked to your prospects. Save reply drafts, then queue them from Outreach.

Creating a campaign or adding credentials does **not** send mail. Campaign activation, an eligible queued message, a verified sender, and an open sending window are all required for initial outreach. No emails were sent during setup or verification.

## Sending behavior

- Default maximum: **5 emails per day, shared across all accounts and campaigns**, adjustable to 10.
- Default window: Monday–Friday, 09:00–18:00 Asia/Kolkata.
- Default gap: 30 minutes between messages from the same account.
- All outgoing messages, including manual replies, count toward the shared cap.
- Already-contacted businesses or email addresses are blocked from repeated initial outreach.
- Pausing a campaign stops queued initial outreach. Cancel queued manual replies individually if needed.
- Suppression blocks an email address across campaigns and marks the business do-not-contact.
- A process interruption or ambiguous SMTP failure becomes **uncertain** and is not automatically resent.
- Definite rejections can be reviewed and requeued manually. SMTP acceptance does not prove inbox delivery.
- Automatic follow-ups are intentionally absent from this version. Manual follow-up tasks and reply drafts are supported.
- The server must keep running for background jobs and sending. Only one server/worker instance should use a given database.

## Discovery and research

Without additional credentials, discovery uses the public OpenStreetMap Overpass service. Data is community-maintained and coverage varies; each search is capped at 300 results and 10 km radius. Attribution and source links are displayed. Searches run one category at a time using bounding boxes, then filter results back to the selected circular radius. Results are saved as each category returns. Transient failures are retried once, and incomplete categories are reported as partial coverage rather than discarding the successful categories. The provider's error detail is retained in job results.

Optionally save a Google Places API key in Settings. The adapter uses Nearby Search (New), with at most 20 results for each selected category. This is a **partial sample**, not an exhaustive search. A suitable enabled Google Cloud project and billing configuration are required. Google Places has its own data-use requirements; confirm the intended production storage and attribution setup before a commercial rollout.

When a listing lacks a website, research first searches the public web for candidate business websites. Automatic matching requires the business name plus branch coordinates within 250 m or a matching street address; uncertain matches are not copied. Public search availability is best-effort and can be rate-limited. Opening a case prioritizes its pending lookup; the Contact tab displays receiver details and progress, with manual editing available as an override. Branch pages with structured location data use their own declared contact fields rather than contact details from related-location cards. Research reads up to five public pages per website, consults robots.txt, extracts published business contact details, records sources and observation times, and marks unknowns. Private IP addresses, local services, credential-bearing URLs, and unsafe redirect targets are rejected. Pages have timeout and size limits. JavaScript-only websites, obfuscated contacts, and blocked websites may require manual review.

Drafting currently uses **evidence-based templates**, with category-specific website suggestions and supported website observations such as catering or appointments. It does not require or call an LLM API. An LLM provider can be added later for richer research synthesis; no model key is configured. Features remain suggestions subject to the campaign's exact service scope.

## Research-only mode

Set `DATA_ONLY=1` (in `.env`, or as a Vercel environment variable) to run Scout without any email features. It still discovers businesses, checks their websites, and scrapes public contacts and website content. It never drafts, queues, sends, or syncs email: the Outreach and Inbox pages and sender settings are hidden, and those API routes return 403. Use **Prospects → Export CSV** to download each business with its website, website status, email, phone, listing, summary, website mentions, and source URLs. The export respects the selected campaign.

## Inbox limitations

The Gmail IMAP connection uses the configured app password. Manual sync and optional five-minute sync inspect the latest 100 messages received within 30 days. Only messages matching an existing prospect conversation are stored. Message headers are preferred; email-address matching is used only when it identifies a single case. This is not a full mailbox client or a complete historical inbox import.

Text replies are rendered as plain text. Explicit opt-out phrases are detected in the new reply text; review ambiguous responses and use **Mark do not contact** when appropriate. SMTP-time recipient rejections are handled, but asynchronous bounce classification is not implemented. No open or click tracking is included.

## Storage and access

- `data/scout.sqlite`: durable campaigns, prospects, research, messages, settings, jobs, and sessions.
- SMTP credentials and optional discovery keys are encrypted with AES-256-GCM before being saved in SQLite.
- `.env`: local runtime settings and the encryption key. Do not commit or share it.
- Credentials are never returned through the API. Session cookies are HttpOnly and SameSite Strict.
- The first local visitor creates the workspace password, stored using scrypt.
- `.env`, `data/`, dependency folders, build output, and test artifacts are ignored by Git.
- Preserve the encryption key when moving or restoring the database. Losing it makes saved credentials unreadable.

For backups, stop the app and copy the `data/` directory plus `.env` to a private backup location. Do not copy an active SQLite file by itself without using SQLite's backup facilities.

## Deployment

This version is a Node server, not a static site or Cloudflare Worker. SMTP and IMAP require outbound TCP connections. A persistent Node host or VPS with an attached volume is appropriate.

A Dockerfile and compose configuration are included. The default compose port is published only on the host's loopback interface. Configure the workspace password locally before exposing it remotely, use an HTTPS reverse proxy, set `COOKIE_SECURE=1` for HTTPS, retain the encryption key and database volume, and run only one application instance. The app must receive the original Host header for its same-origin check. Public deployment has not been performed.

## Verification

```bash
npm test
npm run check
npm run build
npx playwright install chromium
npm run test:browser
```

Tests use temporary databases and fake contacts. They do not send real emails. Browser checks cover first-run authentication, campaign creation, adding a prospect, CRM edits and notes, persistent reloads, navigation, and mobile overflow. Screenshots go to ignored `test-results/`.

SMTP and IMAP authentication for both supplied accounts were verified during setup, without sending email or fetching inbox content.

## Project map

| Path | Purpose |
| --- | --- |
| `SALES_AGENT_PLAN.md` | Original requirements, planned phases, and current implementation decisions. |
| `src/main.jsx` | React workspace, CRM, forms, outreach queue, inbox, and settings. |
| `src/styles.css` | Responsive visual design and component styles. |
| `server/index.js` | Authenticated API, validation, campaign and CRM operations. |
| `server/db.js` | SQLite schema, encryption, sessions, and job persistence. |
| `server/network.js` | Bounded public-web fetching and location-link resolution. |
| `server/research.js` | Discovery integrations, contact extraction, research, and drafting. |
| `server/mail.js` | SMTP verification/sending, shared daily cap, suppression, and IMAP. |
| `server/worker.js` | Persistent discovery/research jobs and scheduled send loop. |
| `tests/core.test.js` | Backend behavior and security regression checks. |
| `scripts/browser-check.mjs` | Isolated browser workflow verification. |

## Integration references

- [Nodemailer SMTP transport](https://nodemailer.com/smtp)
- [ImapFlow client API](https://imapflow.com/docs/api/imapflow-client/)
- [Google Places Nearby Search](https://developers.google.com/maps/documentation/places/web-service/nearby-search)
- [OpenStreetMap copyright and attribution](https://www.openstreetmap.org/copyright)

## Vercel + Neon deployment

Production uses Neon PostgreSQL through `DATABASE_URL`. Local development uses SQLite when this variable is absent. The original database and the dated pre-migration backup remain in `data/`, excluded from deployments. Sender secrets remain encrypted with the original `ENCRYPTION_KEY`; the workspace password hash was migrated, and login sessions were not copied.

The linked Vercel project is `scout-sales-agent` in `ajay-raos-projects`. Deploy changes with `NO_UPDATE_NOTIFIER=1 vercel --prod --yes --scope ajay-raos-projects`. Production requires `DATABASE_URL`, `ENCRYPTION_KEY`, `COOKIE_SECURE=1`, and `CRON_SECRET`. Never put these values in frontend variables or commit `.env` files. Schema updates must be applied before deploying; `initializeSchema()` is deliberately not called on each serverless cold start.

The API is a Vercel Node function in Singapore with a 300-second maximum. Database transactions serialize quota reservations across instances. A database lease prevents overlapping worker runs; stale work is recoverable. Discovery saves one category per invocation, and website requests have bounded timeouts. The authenticated dashboard schedules a worker run when it refreshes; jobs continue after the response using Vercel `waitUntil`.

**Automation limitation on the current Hobby plan:** Vercel cron invokes `/api/cron` once daily (04:00 UTC). While the dashboard is open, worker invocations also process the queue. This does not guarantee 5–10 spaced emails per day while the dashboard is closed. An external scheduler calling `GET /api/cron` every five minutes with `Authorization: Bearer <CRON_SECRET>`, or a plan supporting frequent cron, is needed for fully unattended sending. No paid upgrade or external scheduler has been configured. Normal sending hours, daily cap, suppression, and campaign activation checks still apply.

Validation commands: `npm test`, `npm run test:browser`, `node scripts/test-postgres.mjs` (creates and removes an isolated Neon schema), and `npm run build`. `scripts/migrate-neon.mjs` refuses a nonempty destination and is only for the initial migration; do not rerun it after production has data. `scripts/configure-vercel.mjs` transfers encryption/runtime secrets using CLI stdin.
