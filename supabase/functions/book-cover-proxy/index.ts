const ALLOWED_EXACT_HOSTS = new Set([
  "books.google.com",
  "books.google.co.jp",
  "covers.openlibrary.org",
  "cover.openbd.jp",
]);

function isAllowedHost(hostname: string) {
  const host = hostname.toLowerCase();
  return ALLOWED_EXACT_HOSTS.has(host) || host.endsWith(".googleusercontent.com");
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  const requestUrl = new URL(req.url);
  const source = requestUrl.searchParams.get("src") || "";
  if (!source || source.length > 2500) {
    return new Response("Invalid source", { status: 400, headers: corsHeaders });
  }

  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    return new Response("Invalid URL", { status: 400, headers: corsHeaders });
  }

  if (sourceUrl.protocol !== "https:" || !isAllowedHost(sourceUrl.hostname)) {
    return new Response("Source is not allowed", { status: 403, headers: corsHeaders });
  }

  try {
    const upstream = await fetch(sourceUrl.toString(), {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; kore-motteru-cover/1.0)",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
        Referer: sourceUrl.hostname.startsWith("books.google")
          ? "https://books.google.com/"
          : "https://kouchikuciel-png.github.io/",
      },
      signal: AbortSignal.timeout(9000),
    });

    if (!upstream.ok) {
      return new Response(`Upstream ${upstream.status}`, {
        status: 502,
        headers: { ...corsHeaders, "Cache-Control": "no-store" },
      });
    }

    const contentType = (upstream.headers.get("content-type") || "").split(";")[0].trim();
    if (!contentType.startsWith("image/")) {
      return new Response("Upstream did not return an image", {
        status: 415,
        headers: { ...corsHeaders, "Cache-Control": "no-store" },
      });
    }

    const bytes = await upstream.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) {
      return new Response("Image too large", { status: 413, headers: corsHeaders });
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    console.error("cover proxy error", error);
    return new Response("Cover fetch failed", {
      status: 502,
      headers: { ...corsHeaders, "Cache-Control": "no-store" },
    });
  }
});
