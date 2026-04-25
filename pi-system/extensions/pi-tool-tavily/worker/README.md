# Tavily Proxy Worker

Cloudflare Worker that proxies `pi-tool-tavily` requests to `api.tavily.com` from a Cloudflare egress IP.

## Why a proxy

Tavily's API sits behind AWS WAF. From some regions / mobile carriers (notably LATAM residential IPs) requests get challenged or blocked. A Cloudflare Worker fronts the call from a US edge IP and rewrites the User-Agent, which sidesteps the block. The Worker does not store or inject your API key — the client sends `Authorization: Bearer $TAVILY_API_KEY` directly.

You only need this if direct calls to `api.tavily.com` fail. Leave `TAVILY_PROXY_URL` unset to hit Tavily directly.

## Files

```
worker/
  worker.js       # the Worker source (10 lines of real logic)
  wrangler.toml   # wrangler config
```

## Deploy (option A — Wrangler CLI)

Requires Node 18+ and a free Cloudflare account.

```bash
npm install -g wrangler           # one-time
cd pi-system/extensions/pi-tool-tavily/worker
wrangler login                    # opens browser for OAuth
wrangler deploy                   # publishes the Worker
```

Wrangler prints the deployed URL, e.g. `https://tavily-proxy.<your-subdomain>.workers.dev`.

Edit `wrangler.toml` if you want a different worker name.

## Deploy (option B — Cloudflare dashboard)

1. <https://dash.cloudflare.com/> → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it (e.g. `tavily-proxy`) → **Deploy**.
3. **Edit code** → replace the default with the contents of `worker.js` → **Save and deploy**.
4. Copy the assigned URL.

## Wire it up

Export the Worker URL so `pi-tool-tavily` routes through it:

```bash
export TAVILY_PROXY_URL="https://tavily-proxy.<your-subdomain>.workers.dev"
```

Add the same line to `~/.env` so it persists across sessions. With it unset, the extension calls `https://api.tavily.com` directly.

## Test

```bash
curl -X POST "$TAVILY_PROXY_URL/search" \
  -H "Authorization: Bearer $TAVILY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query":"hello world","max_results":1}'
```

A 200 with JSON results = working. A 401 = your `TAVILY_API_KEY` is wrong. A 403 from `tavily.com` = the WAF rule changed; try a different User-Agent in `worker.js`.

## Cost

Free tier covers 100k requests/day. Personal use is ~free.

## Lock the proxy down (optional)

The Worker is open by default — anyone with the URL can use your Cloudflare quota (they still need a Tavily key to get useful results, but they consume your CPU minutes). To restrict, add a shared-secret check at the top of `fetch()`:

```js
if (request.headers.get("x-pi-secret") !== env.PROXY_SECRET) {
  return new Response("Forbidden", { status: 403 });
}
```

Then `wrangler secret put PROXY_SECRET` and have `tavily.js` send the header. (Not implemented in `tavily.js` by default — patch locally if you need it.)
