/**
 * Tavily proxy — Cloudflare Worker.
 *
 * Forwards requests to https://api.tavily.com from a Cloudflare egress IP
 * (US-based) so calls succeed from regions where Tavily's AWS WAF blocks the
 * client (e.g. residential mobile IPs in some LATAM countries).
 *
 * The client must still send `Authorization: Bearer <TAVILY_API_KEY>`.
 * The Worker does not store or inject the key.
 */
export default {
  async fetch(request, env, ctx) {
    // 1. Map the incoming path to api.tavily.com (e.g. /search, /extract, /map).
    const url = new URL(request.url);
    const targetUrl = "https://api.tavily.com" + url.pathname;

    // 2. Clone the original request, preserving method, headers, and body.
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
    });

    // 3. Override User-Agent so AWS WAF sees a standard browser fingerprint.
    proxyRequest.headers.set(
      "User-Agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    );

    // 4. Issue the request from Cloudflare's edge and return the response.
    const response = await fetch(proxyRequest);
    return response;
  },
};
