import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import analytics from "./api/router/analytics.js";
import api from "./api/router/api.js";
import dashboard from "./api/router/dashboard.js";
import publicRouter from "./api/router/public.js";
import stremio from "./api/router/stremio.js";
import { initMigrations } from "./db/drizzle.js";
import { buildManifest } from "./lib/manifest.js";
import { API } from "./utils/constant.js";
import { ENV } from "./utils/env.js";
import { Logger } from "./utils/logger.js";

const logger = new Logger("SERVER");
const HOST = "0.0.0.0";
const PORT = ENV.PORT;
async function warmCache() {
  const defaultCatalogUrls = buildManifest()
    .catalogs.filter((catalog) => {
      return !catalog.id.toLowerCase().includes("search");
    })
    .map((catalog) => `/catalog/${catalog.type}/${catalog.id}.json`);
  const warmUrls = ["/manifest.json", ...defaultCatalogUrls];
  await Promise.all(
    warmUrls.map((url) => {
      fetch("http://localhost:" + PORT + url);
    }),
  );
}

const app = new Hono();
app.use("*", cors());
app.route("/", analytics);
app.route("/", stremio);
app.route(`/${API}`, api);
app.route("/", publicRouter);
app.route("/dashboard", dashboard);

// Temporary, read-only MKVDrama connectivity diagnostic for the test service.
// It makes one fixed POST request and returns status/shape only, never response data.
app.get("/__diagnostics/mkvdrama", async (c) => {
  const target =
    "https://mkvdrama.net/exrwfabz8n/_vb3k_mnxr_w";
  try {
    const response = await fetch(target, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Referer: "https://mkvdrama.net/exrwfabz8n",
      },
      signal: AbortSignal.timeout(12000),
    });
    const contentType = response.headers.get("content-type") || "";
    const cfMitigated = response.headers.get("cf-mitigated") || "";
    const body = await response.text();
    let jsonKeys: string[] = [];
    let isJson = false;
    try {
      const parsed: unknown = JSON.parse(body);
      isJson = true;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        jsonKeys = Object.keys(parsed as Record<string, unknown>).sort();
      }
    } catch {
      // The response is not JSON; do not expose its body.
    }
    return c.json({
      targetHost: "mkvdrama.net",
      method: "POST",
      status: response.status,
      contentType,
      cfMitigated: cfMitigated || null,
      cloudflareChallenge:
        cfMitigated.toLowerCase() === "challenge" ||
        body.toLowerCase().includes("just a moment"),
      isJson,
      jsonKeys,
      expectedFieldsPresent:
        ["hash", "pass_path", "dec_key"].every((key) =>
          jsonKeys.includes(key),
        ),
    });
  } catch (error) {
    return c.json(
      {
        targetHost: "mkvdrama.net",
        method: "POST",
        error:
          error instanceof Error ? error.name : "RequestFailed",
      },
      502,
    );
  }
});

// Error handling
app.onError((err, c) => {
  logger.error(`${err}`);
  return c.text("Internal Server Error", 500);
});

// Start server
await initMigrations();
try {
  serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
    logger.log(`yastream running on http://${HOST}:${PORT}`);
  });
  if (ENV.WARM_CACHE) {
    await warmCache();
    logger.log(`Warming cache completed`);
  }
} catch (error) {
  logger.log(`Fail to start | ${error}`);
}

// Global catch to prevent crashes
process.on("unhandledRejection", (reason, _) => {
  logger.error(`UNHANDLED_REJECTION | Reason: ${reason}`);
});
process.on("uncaughtException", (err) => {
  logger.error(`UNCAUGHT_EXCEPTION | ${err}`);
});
process.on("SIGTERM", () => {
  logger.log("SIGTERM");
  // cache.persistDb();
  process.exit();
});
process.on("SIGINT", () => {
  logger.log("SIGINT");
  // cache.persistDb();
  process.exit();
});
