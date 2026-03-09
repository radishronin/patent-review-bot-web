/**
 * Cloudflare Worker — Anthropic API streaming proxy
 *
 * Forwards POST /v1/messages requests to Anthropic, attaching the API key
 * from the ANTHROPIC_API_KEY secret (set via `wrangler secret put`).
 * Streams the SSE response back to the browser unchanged.
 *
 * Environment secrets required:
 *   ANTHROPIC_API_KEY  — set with: wrangler secret put ANTHROPIC_API_KEY
 */

const ANTHROPIC_API   = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

// CORS headers returned on every response
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, anthropic-version',
};

export default {
  async fetch(request, env) {
    // ── OPTIONS preflight ──────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Only accept POST ───────────────────────────────────────
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', {
        status: 405,
        headers: CORS_HEADERS,
      });
    }

    // ── Forward to Anthropic ───────────────────────────────────
    let upstreamResponse;
    try {
      upstreamResponse = await fetch(ANTHROPIC_API, {
        method: 'POST',
        headers: {
          'content-type':      'application/json',
          'anthropic-version': ANTHROPIC_VERSION,
          'x-api-key':         env.ANTHROPIC_API_KEY,
        },
        // Pass the request body through as-is; the browser already serialized it
        body: request.body,
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Upstream fetch failed', detail: err.message }), {
        status: 502,
        headers: { ...CORS_HEADERS, 'content-type': 'application/json' },
      });
    }

    // ── Stream the SSE response back unchanged ─────────────────
    // Copy Anthropic's response headers, then overlay CORS + content-type.
    const responseHeaders = new Headers(upstreamResponse.headers);
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      responseHeaders.set(k, v);
    }
    // Ensure chunked streaming works in all runtimes
    responseHeaders.delete('content-encoding');
    responseHeaders.delete('content-length');

    return new Response(upstreamResponse.body, {
      status:  upstreamResponse.status,
      headers: responseHeaders,
    });
  },
};
