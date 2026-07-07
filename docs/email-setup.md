# Email Setup

## Resend Domain

1. Choose an agent email subdomain, for example `agents.identity.space`.
2. Set `EMAIL_AGENT_DOMAIN` to that subdomain and set `PROVIDER_MODE_EMAIL=live`.
3. Add `RESEND_API_KEY` and restart the API.
4. Open `GET /api/v1/ops/email-domain` with a dashboard session cookie. Barkan creates the Resend domain if needed and returns DNS records.
5. Add every returned SPF/DKIM/MX record at the DNS host. Keep Cloudflare proxy disabled for mail records.
6. Recheck `GET /api/v1/ops/email-domain` until `verified` is `true`.
7. In Resend, create a webhook for `PUBLIC_API_URL/webhooks/resend`, enable email lifecycle events, and set `RESEND_WEBHOOK_SECRET` to the Svix signing secret.

Mock mode does not call Resend. Live mode requires the domain to verify; there is no sandbox recipient redirect.
