# PostHog Pixel

A tiny tracking pixel for sending anonymous article-view events to [PostHog](https://posthog.com/) when you can embed an image but cannot run JavaScript.

It is designed for publishing platforms where you control article content enough to add an external `<img>`, but cannot install `posthog-js`.

The Worker:

1. receives an image request,
2. assigns the browser an anonymous ID using a partitioned cookie,
3. sends an anonymous event to PostHog in the background,
4. returns a 1x1 transparent GIF immediately.

This makes it possible to answer questions such as:

> How many anonymous readers viewed two or more different articles in my series?

## How it works

```text
Article platform
    |
    | <img src="https://pixel.example.com/p.gif?article=article-01">
    v
Cloudflare Worker
    |
    |-- read/create anonymous reader ID
    |-- Set-Cookie: ...; SameSite=None; Secure; Partitioned
    |
    | POST /i/v0/e/
    v
PostHog
```

The cookie is partitioned by the browser's top-level site. This is useful when all articles are hosted on the same publishing site: supported browsers can reuse the anonymous ID between those articles without making it a general-purpose cross-site identifier.

The PostHog event is sent with:

```json
{
  "event": "article_viewed",
  "distinct_id": "<anonymous UUID>",
  "properties": {
    "article_id": "article-01",
    "series": "my-series",
    "source": "posthog-pixel",
    "$process_person_profile": false
  }
}
```

`$process_person_profile: false` keeps these as anonymous PostHog events while retaining a stable `distinct_id` for event analysis.

## Requirements

- A Cloudflare account
- Node.js
- A PostHog project
- Permission from the publishing platform to embed external images
- The platform must load the image from the visitor's browser rather than permanently proxying/caching it

## Deploy to Cloudflare Workers

Clone the repository and install dependencies:

```bash
git clone https://github.com/flyinglimao/posthog-pixel.git
cd posthog-pixel
npm install
```

Authenticate Wrangler:

```bash
npx wrangler login
```

Add your PostHog **project token**:

```bash
npx wrangler secret put POSTHOG_API_KEY
```

This is the `phc_...` project token used for event ingestion. It is not a PostHog personal API key.

Deploy:

```bash
npm run deploy
```

Wrangler will return a `workers.dev` URL. You can use that immediately, although a dedicated custom domain such as `pixel.example.com` is preferable.

## Configuration

Runtime defaults are defined in `wrangler.jsonc`:

```jsonc
{
  "vars": {
    "POSTHOG_HOST": "https://us.i.posthog.com",
    "EVENT_NAME": "article_viewed",
    "COOKIE_NAME": "ph_pixel_id",
    "COOKIE_MAX_AGE": "31536000",
    "ALLOWED_REFERRER_HOSTS": ""
  }
}
```

### `POSTHOG_API_KEY`

Required.

Set it as a Wrangler secret:

```bash
npx wrangler secret put POSTHOG_API_KEY
```

Use your PostHog **project token**, not a personal API key.

### `POSTHOG_HOST`

Default:

```text
https://us.i.posthog.com
```

For PostHog EU Cloud:

```text
https://eu.i.posthog.com
```

If you already use a PostHog reverse proxy and it forwards PostHog ingestion paths such as `/i/v0/e/`, you can use it instead:

```jsonc
"POSTHOG_HOST": "https://ph.example.com"
```

A reverse proxy is not required for this Worker. The PostHog request is server-to-server, so browser ad blockers do not see the request from the Worker to PostHog.

### `EVENT_NAME`

Default:

```text
article_viewed
```

All pixel hits use this PostHog event name.

### `COOKIE_NAME`

Default:

```text
ph_pixel_id
```

The cookie contains only a random anonymous UUID.

### `COOKIE_MAX_AGE`

Default:

```text
31536000
```

One year, in seconds. Browsers may impose their own shorter storage lifetime.

### `ALLOWED_REFERRER_HOSTS`

Optional comma-separated allowlist:

```jsonc
"ALLOWED_REFERRER_HOSTS": "zenn.dev,example.com"
```

Subdomains are also accepted. For example, allowing `example.com` also accepts `www.example.com`.

When the allowlist is configured, requests without an allowed `Referer` header still receive the transparent GIF, but no event is sent to PostHog.

This is a lightweight anti-abuse measure, not authentication: clients can forge a `Referer` header.

## Add the pixel to an article

Add this somewhere in the article HTML:

```html
<img
  src="https://pixel.example.com/p.gif?article=article-01"
  width="1"
  height="1"
  alt=""
  style="display:none"
/>
```

Use a stable, unique `article` value for each article.

For a series:

```html
<img
  src="https://pixel.example.com/p.gif?article=day-01&series=product-engineering"
  width="1"
  height="1"
  alt=""
  style="display:none"
/>
```

The `article` parameter is required. `series` is optional.

Both values are limited to 200 characters.

The aliases `/p.gif` and `/pixel.gif` behave identically.

## Custom domain

A dedicated domain is recommended:

```text
pixel.example.com
```

In Cloudflare:

1. Open **Workers & Pages**.
2. Select the deployed Worker.
3. Open **Settings / Domains & Routes**.
4. Add a custom domain.
5. Point your article pixel URLs at that domain.

A dedicated hostname also avoids sharing this Worker's cookie namespace with unrelated applications.

## Verify the deployment

Check health:

```bash
curl https://pixel.example.com/healthz
```

A correctly configured deployment returns:

```json
{
  "ok": true,
  "service": "posthog-pixel",
  "posthog_host": "https://us.i.posthog.com",
  "event_name": "article_viewed"
}
```

Test the pixel:

```bash
curl -i \
  -H 'Referer: https://example.com/articles/test' \
  'https://pixel.example.com/p.gif?article=test'
```

On the first request, the response should contain a header similar to:

```http
Set-Cookie: ph_pixel_id=...; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=None; Partitioned
```

Then open PostHog's live events view and look for `article_viewed`.

## Find readers who viewed 2+ different articles

The important distinction is **different articles**, not two pixel hits. A reader refreshing one article twice should not count as a 2+ article reader.

A HogQL query can aggregate unique article IDs per anonymous `distinct_id`:

```sql
SELECT
    count() AS readers,
    countIf(article_count >= 2) AS readers_2_plus,
    round(readers_2_plus / readers * 100, 1) AS readers_2_plus_percent
FROM (
    SELECT
        distinct_id,
        uniqExact(properties.article_id) AS article_count
    FROM events
    WHERE event = 'article_viewed'
    GROUP BY distinct_id
)
```

For one series:

```sql
SELECT
    count() AS readers,
    countIf(article_count >= 2) AS readers_2_plus,
    round(readers_2_plus / readers * 100, 1) AS readers_2_plus_percent
FROM (
    SELECT
        distinct_id,
        uniqExact(properties.article_id) AS article_count
    FROM events
    WHERE event = 'article_viewed'
      AND properties.series = 'product-engineering'
    GROUP BY distinct_id
)
```

You can save the query as a PostHog SQL insight and add it to a dashboard.

## Browser behavior and limitations

This technique intentionally relies on a partitioned third-party cookie.

It is not equivalent to installing PostHog directly on the publishing platform.

### Chromium-based browsers

Modern Chromium browsers support CHIPS / `Partitioned` cookies. When multiple articles live under the same top-level publishing site, the pixel can generally reuse the same partitioned reader ID.

### Firefox

Firefox partitions third-party storage by top-level site. Multiple articles on the same publishing site can therefore generally share the same anonymous identity within that site's partition.

### Safari

Safari blocks third-party cookies much more aggressively. Do not assume that a reader ID set by this pixel will persist between article views in Safari.

As a result, cross-article metrics such as "viewed 2+ articles" will undercount some Safari readers.

### Other sources of undercounting or overcounting

Anonymous identity is browser-local, not account-level identity.

The same human may receive multiple IDs when they:

- use multiple browsers or devices,
- clear cookies/site data,
- use private browsing,
- are subject to browser storage expiry,
- use privacy software that blocks the pixel.

Bots and crawlers may also request images. If bot traffic matters, filter it downstream or add additional edge-side controls.

## Caching

The Worker returns:

```http
Cache-Control: private, no-store, max-age=0
```

Cloudflare should therefore execute the Worker for each browser request instead of caching one user's response for another user.

The publishing platform itself must also avoid replacing the remote image with a permanent proxy/cache. If the platform fetches the image once and serves its own copy to every visitor, visitor-level tracking is impossible with this approach.

## Privacy

The Worker generates a random anonymous ID and does not intentionally forward the visitor's IP address or User-Agent to PostHog.

The browser's request still reaches Cloudflare, so Cloudflare may process network metadata as part of operating the Worker.

You are responsible for making sure your use of analytics, cookies, and tracking is permitted by the publishing platform and complies with the privacy and consent requirements that apply to you and your readers.

This project deliberately avoids fingerprinting, ETag-based identifiers, cache-based identifiers, and other techniques intended to bypass browser privacy controls.

## Abuse considerations

The endpoint is public because it must be loadable by a browser `<img>`.

Possible mitigations:

- set `ALLOWED_REFERRER_HOSTS`,
- use a dedicated hostname,
- enable Cloudflare rate limiting if necessary,
- filter obvious bot traffic in PostHog,
- monitor Worker logs for unusual request volume.

The PostHog project token used for capture is designed for ingestion and does not grant read access to your PostHog project.

## Local development

Install dependencies:

```bash
npm install
```

Create a local `.dev.vars` file:

```dotenv
POSTHOG_API_KEY=phc_your_project_token
```

Run:

```bash
npm run dev
```

Then test:

```bash
curl -i \
  -H 'Referer: https://example.com/article/test' \
  'http://localhost:8787/p.gif?article=test'
```

Type-check:

```bash
npm run check
```

## Why not PostHog's Workflow tracking pixel?

PostHog Workflow tracking pixels are useful when PostHog already knows the recipient's identity.

This project solves a different problem: an anonymous visitor loads a pixel from multiple articles, and the pixel must create and persist an anonymous identity before sending those events to PostHog.

That identity layer is what this Worker adds.

## PostHog API

Events are sent to PostHog's public capture endpoint:

```text
POST /i/v0/e/
```

See the official PostHog documentation:

- https://posthog.com/docs/api/capture

## License

MIT. See [LICENSE](./LICENSE).
