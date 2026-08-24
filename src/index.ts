interface Env {
  POSTHOG_API_KEY?: string;
  POSTHOG_HOST?: string;
  EVENT_NAME?: string;
  COOKIE_NAME?: string;
  COOKIE_MAX_AGE?: string;
  ALLOWED_REFERRER_HOSTS?: string;
}

interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_EVENT_NAME = "article_viewed";
const DEFAULT_COOKIE_NAME = "ph_pixel_id";
const DEFAULT_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

const TRANSPARENT_GIF = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="),
  (char) => char.charCodeAt(0),
);

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();

  if (!header) {
    return cookies;
  }

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (name) {
      cookies.set(name, value);
    }
  }

  return cookies;
}

function validReaderId(value: string | undefined): value is string {
  return Boolean(value && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value));
}

function getCookieMaxAge(env: Env): number {
  const value = Number.parseInt(env.COOKIE_MAX_AGE ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_COOKIE_MAX_AGE;
}

function getAllowedReferrerHosts(env: Env): string[] {
  return (env.ALLOWED_REFERRER_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedReferrer(request: Request, env: Env): boolean {
  const allowedHosts = getAllowedReferrerHosts(env);

  if (allowedHosts.length === 0) {
    return true;
  }

  const referrer = request.headers.get("referer");
  if (!referrer) {
    return false;
  }

  try {
    const hostname = new URL(referrer).hostname.toLowerCase();
    return allowedHosts.some(
      (allowedHost) =>
        hostname === allowedHost || hostname.endsWith(`.${allowedHost}`),
    );
  } catch {
    return false;
  }
}

function pixelResponse(
  readerId: string,
  shouldSetCookie: boolean,
  env: Env,
): Response {
  const headers = new Headers({
    "Content-Type": "image/gif",
    "Content-Length": String(TRANSPARENT_GIF.byteLength),
    "Cache-Control": "private, no-store, max-age=0",
    Pragma: "no-cache",
    Expires: "0",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
  });

  if (shouldSetCookie) {
    const cookieName = env.COOKIE_NAME || DEFAULT_COOKIE_NAME;
    headers.append(
      "Set-Cookie",
      `${cookieName}=${readerId}; Path=/; Max-Age=${getCookieMaxAge(
        env,
      )}; HttpOnly; Secure; SameSite=None; Partitioned`,
    );
  }

  return new Response(TRANSPARENT_GIF, {
    status: 200,
    headers,
  });
}

async function capturePostHogEvent(
  request: Request,
  env: Env,
  readerId: string,
  articleId: string,
  series: string | null,
): Promise<void> {
  if (!env.POSTHOG_API_KEY) {
    console.error("POSTHOG_API_KEY is not configured");
    return;
  }

  const host = (env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
  const referrer = request.headers.get("referer");

  const properties: Record<string, string | boolean> = {
    article_id: articleId,
    source: "posthog-pixel",
    "$process_person_profile": false,
  };

  if (series) {
    properties.series = series;
  }

  if (referrer) {
    properties["$current_url"] = referrer;
  }

  const response = await fetch(`${host}/i/v0/e/`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: env.POSTHOG_API_KEY,
      event: env.EVENT_NAME || DEFAULT_EVENT_NAME,
      distinct_id: readerId,
      properties,
      timestamp: new Date().toISOString(),
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `PostHog capture failed with HTTP ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
}

function healthResponse(env: Env): Response {
  const configured = Boolean(env.POSTHOG_API_KEY);

  return Response.json(
    {
      ok: configured,
      service: "posthog-pixel",
      posthog_host: env.POSTHOG_HOST || DEFAULT_POSTHOG_HOST,
      event_name: env.EVENT_NAME || DEFAULT_EVENT_NAME,
    },
    {
      status: configured ? 200 : 503,
      headers: {
        "Cache-Control": "no-store",
      },
    },
  );
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContextLike,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/healthz") {
      return healthResponse(env);
    }

    if (url.pathname !== "/p.gif" && url.pathname !== "/pixel.gif") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "GET") {
      return new Response("Method not allowed", {
        status: 405,
        headers: { Allow: "GET" },
      });
    }

    const articleId = url.searchParams.get("article")?.trim() ?? "";
    const series = url.searchParams.get("series")?.trim() || null;

    if (!articleId || articleId.length > 200 || (series && series.length > 200)) {
      return new Response("Invalid article or series parameter", { status: 400 });
    }

    const cookieName = env.COOKIE_NAME || DEFAULT_COOKIE_NAME;
    const cookies = parseCookies(request.headers.get("cookie"));
    const existingReaderId = cookies.get(cookieName);
    const readerId = validReaderId(existingReaderId)
      ? existingReaderId
      : crypto.randomUUID();
    const shouldSetCookie = readerId !== existingReaderId;

    if (isAllowedReferrer(request, env)) {
      ctx.waitUntil(
        capturePostHogEvent(request, env, readerId, articleId, series).catch(
          (error) => console.error(error),
        ),
      );
    }

    return pixelResponse(readerId, shouldSetCookie, env);
  },
};
