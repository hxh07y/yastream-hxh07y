import * as cheerio from "cheerio";
import * as crypto from "crypto";
import type { ConsoleMessage, HTTPRequest, HTTPResponse } from "puppeteer";
import { axiosGet, axiosPost } from "../../utils/axios.js";
import { getFlareSolverr } from "../../utils/browser/flaresolverr.js";
import { getBrowser, withCdpPageLock } from "../../utils/browser/puppeteer.js";
import { ENV } from "../../utils/env.js";
import { VIEWCRATE_ORIGIN } from "../../utils/constant.js";
import { ViewcrateError } from "../../utils/error.js";
import { Logger } from "../../utils/logger.js";
import { EpisodeHoster, getHosterFromUrl, Hoster } from "../hoster/hoster.js";
import { getUrlsFromDecryptit } from "./decryptit.js";

interface ViewcrateCnl {
  crypted: string;
  jk: string;
}
const logger = new Logger("VIEWCRATE");

/** Sometimes miss links */
export async function getUrlsFromViewcrate(url: string) {
  const publicId = new URL(url).pathname.split("/").pop();
  const viewcrateCryptUrl = `${VIEWCRATE_ORIGIN}/api/cnl_encrypt/${publicId}`;
  const cnlHtml = await axiosPost<ViewcrateCnl>(viewcrateCryptUrl);
  if (!cnlHtml) throw new ViewcrateError("No cnl html");
  const urls = getUrlsFromCnl(cnlHtml);
  return urls;
}

/** Has all links */
export async function getUrlsFromViewcrateDlc(url: string, password?: string) {
  logger.log(`GET viewcrate dlc | ${url}`);
  // need to load js to have episodes
  // const html = await axiosGet<string>(url);
  const html = await getViewcrateHtml(url, password);
  if (!html) throw new ViewcrateError("No html");
  const pageText = cheerio.load(html)("body").text().toLowerCase();
  const extractedHosterCount = getEpisodeHosters(html).reduce(
    (total, episode) => total + episode.data.length,
    0,
  );
  if (pageText.includes("protected content") && extractedHosterCount === 0) {
    throw new ViewcrateError("Protected content (no episode hosters rendered)");
  }
  const link = await getDlcUrl(html);
  if (!link) throw new ViewcrateError("No dlc link");
  const dlcUrl = new URL(link, VIEWCRATE_ORIGIN).toString();
  const dlc = await axiosGet<string>(dlcUrl);
  if (!dlc) throw new ViewcrateError("No dlc content");
  const urls = await getUrlsFromDecryptit(dlc);
  const episodes = getEpisodeHosters(html);
  return { urls, episodes };
}

async function getViewcrateHtml(url: string, password?: string): Promise<string> {
  if (!ENV.PUPPETEER_CDP_HTTP_URL) {
    const response = await getFlareSolverr(url, "viewcrate", 2);
    return response?.solution?.response || "";
  }

  return withCdpPageLock("Viewcrate DLC extraction", async () => {
    const browser = await getBrowser();
    const pages = await browser.pages();
    const page = pages[0];
    if (!page) {
      throw new Error("SO7O CDP did not expose an existing WebView page");
    }
    let removeNetworkDiagnostics: (() => void) | undefined;
    let removeVisibilityOverride: (() => Promise<void>) | undefined;
    const responseDiagnosticTasks: Promise<void>[] = [];
    const requestStartedAt = new WeakMap<HTTPRequest, number>();

    try {
      const safeUrl = (rawUrl: string) => {
        try {
          const parsed = new URL(rawUrl);
          const safePath = parsed.pathname
            .split("/")
            .map((segment) =>
              segment.length > 32 || /^[a-f0-9]{24,}$/i.test(segment)
                ? "[redacted]"
                : segment,
            )
            .join("/");
          return `${parsed.host}${safePath}`;
        } catch {
          return "[invalid-url]";
        }
      };
      const hashValue = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
      const safeConsoleText = (value: string) => value.replace(/https?:\/\/\S+/gi, "[url]").replace(/[A-Za-z0-9_+/-]{40,}={0,2}/g, "[redacted]").slice(0, 200);
      const onViewcrateRequest = (request: HTTPRequest) => {
        const requestUrl = request.url();
        if (requestUrl.includes("/bootstrap")) requestStartedAt.set(request, Date.now());
        if (request.resourceType() === "script") {
          logger.log(
            `Viewcrate script request | method=${request.method()} | url=${safeUrl(requestUrl)}`,
          );
        }
        if (!requestUrl.startsWith(VIEWCRATE_ORIGIN)) return;
        const path = new URL(requestUrl).pathname;
        if (!/api|unlock|protect|password|resolve|\/c\//i.test(path)) return;
        logger.log(
          `Viewcrate network request | method=${request.method()} | type=${request.resourceType()} | url=${safeUrl(requestUrl)}`,
        );
        if (path.endsWith("/resolve-link")) {
          const postData = request.postData() || "";
          let payloadSummary: unknown = { type: postData ? "text" : "empty", length: postData.length };
          try {
            const parsed = JSON.parse(postData);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              payloadSummary = Object.fromEntries(
                Object.entries(parsed).map(([key, value]) => {
                  const serialized = typeof value === "string" ? value : JSON.stringify(value);
                  return [key, {
                    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
                    length: serialized?.length ?? 0,
                    sha256: hashValue(serialized ?? ""),
                  }];
                }),
              );
            }
          } catch {
            if (postData) {
              payloadSummary = {
                type: "form-or-text",
                length: postData.length,
                sha256: hashValue(postData),
                fields: [...new URLSearchParams(postData).keys()],
              };
            }
          }
          logger.log(
            `Viewcrate resolve-link request details | method=${request.method()} | contentType=${request.headers()["content-type"] || "unknown"} | payload=${JSON.stringify(payloadSummary)}`,
          );
        }
      };
      const onViewcrateResponse = (response: HTTPResponse) => {
        const responseUrl = response.url();
        const resourceType = response.request().resourceType();
        const contentType = response.headers()["content-type"] || "unknown";
        if (resourceType === "script") {
          logger.log(`Viewcrate script response | status=${response.status()} | contentType=${contentType} | url=${safeUrl(responseUrl)}`);
          responseDiagnosticTasks.push((async () => {
            try {
              const body = await response.buffer();
              logger.log(`Viewcrate script fingerprint | status=${response.status()} | bytes=${body.length} | sha256=${hashValue(body.toString("utf8"))} | url=${safeUrl(responseUrl)}`);
            } catch (error) {
              logger.warn(`Viewcrate script fingerprint unavailable | url=${safeUrl(responseUrl)} | reason=${String(error).slice(0, 100)}`);
            }
          })());
        }
        if (!responseUrl.startsWith(VIEWCRATE_ORIGIN)) return;
        const path = new URL(responseUrl).pathname;
        if (!/api|unlock|protect|password|resolve/i.test(path) && !path.includes("/c/")) return;
        logger.log(
          `Viewcrate network response | status=${response.status()} | type=${resourceType} | contentType=${contentType} | url=${safeUrl(responseUrl)}`,
        );
        if (path.endsWith("/resolve-link")) {
          responseDiagnosticTasks.push((async () => {
            try {
              const body = await response.text();
              let parsed: any;
              try { parsed = JSON.parse(body); } catch { parsed = null; }
              const describe = (value: unknown): unknown => {
                if (typeof value === "string") {
                  let url: URL | null = null;
                  try { url = new URL(value); } catch {}
                  return url
                    ? { type: "url", host: url.hostname, path: url.pathname, length: value.length }
                    : { type: "string", length: value.length, sha256: hashValue(value) };
                }
                if (Array.isArray(value)) return { type: "array", length: value.length, items: value.slice(0, 5).map(describe) };
                if (value && typeof value === "object") {
                  return {
                    type: "object",
                    fields: Object.fromEntries(
                      Object.entries(value as Record<string, unknown>)
                        .slice(0, 30)
                        .map(([key, item]) => [key, describe(item)]),
                    ),
                  };
                }
                return { type: value === null ? "null" : typeof value };
              };
              logger.log(
                `Viewcrate resolve-link response details | status=${response.status()} | bytes=${Buffer.byteLength(body)} | parsedJson=${Boolean(parsed)} | structure=${JSON.stringify(describe(parsed ?? body))}`,
              );
            } catch (error) {
              logger.warn(`Viewcrate resolve-link response details unavailable | reason=${String(error).slice(0, 120)}`);
            }
          })());
        }

        // Compare the server responses before page JavaScript runs. Only structural
        // metadata is logged; response values, cookies, tokens and URLs are omitted.
        if (resourceType === "document" || path.endsWith("/bootstrap")) {
          responseDiagnosticTasks.push((async () => {
            try {
              const body = await response.text();
              if (resourceType === "document") {
                const $ = cheerio.load(body);
                const $section = $("main > div").eq(2);
                const initialForms = $("form").map((_, form) => ({
                  method: ($(form).attr("method") || "get").toLowerCase(),
                  fields: $(form).find("input").map((__, input) => ({
                    name: $(input).attr("name") || "",
                    type: $(input).attr("type") || "text",
                  })).get(),
                })).get();
                const scripts = $("script[src]").map((_, script) => {
                  try { return safeUrl(new URL($(script).attr("src") || "", responseUrl).toString()); }
                  catch { return "[invalid-script-url]"; }
                }).get();
                logger.log(
                  `Viewcrate initial HTML structure | bytes=${Buffer.byteLength(body)} | protectedText=${$("body").text().toLowerCase().includes("protected content")} | dlcSectionPresent=${Boolean($section.attr("data-resolve-url"))} | sectionChildren=${$section.children().length} | sectionTextLength=${$section.text().trim().length} | forms=${JSON.stringify(initialForms)} | scripts=${JSON.stringify(scripts)}`,
                );
              } else {
                let payload: any;
                try { payload = JSON.parse(body); } catch { payload = null; }
                const describe = (value: unknown): unknown => {
                  if (typeof value === "string") return { type: "string", length: value.length };
                  if (Array.isArray(value)) return { type: "array", length: value.length };
                  if (value && typeof value === "object") return { type: "object", keys: Object.keys(value as object).sort() };
                  return { type: value === null ? "null" : typeof value };
                };
                const fields = payload && typeof payload === "object" && !Array.isArray(payload)
                  ? Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, describe(value)]))
                  : describe(payload);
                const fingerprints: Record<string, { length: number; sha256: string }> = {};
                const arrayItems: unknown[] = [];
                if (payload && typeof payload === "object" && !Array.isArray(payload)) {
                  for (const key of ["k", "i", "c"]) {
                    const value = (payload as Record<string, unknown>)[key];
                    if (typeof value === "string") {
                      fingerprints[key] = { length: value.length, sha256: hashValue(value) };
                    }
                  }
                  const entries = (payload as Record<string, unknown>).r;
                  if (Array.isArray(entries)) arrayItems.push(...entries);
                }
                const rDiagnostics = arrayItems.map((value) => {
                  if (typeof value === "string") {
                    return { type: "string", length: value.length, sha256: hashValue(value) };
                  }
                  if (value && typeof value === "object") {
                    const serialized = JSON.stringify(value);
                    return {
                      type: Array.isArray(value) ? "array" : "object",
                      keys: Array.isArray(value) ? undefined : Object.keys(value as object).sort(),
                      length: serialized.length,
                      sha256: hashValue(serialized),
                    };
                  }
                  return { type: value === null ? "null" : typeof value };
                });
                const requestStarted = requestStartedAt.get(response.request());
                const durationMs = requestStarted === undefined ? "unknown" : Date.now() - requestStarted;
                logger.log(
                  `Viewcrate bootstrap structure | status=${response.status()} | durationMs=${durationMs} | bytes=${Buffer.byteLength(body)} | parsedJson=${Boolean(payload)} | structure=${JSON.stringify(fields)} | fingerprints=${JSON.stringify(fingerprints)} | rItems=${JSON.stringify(rDiagnostics)}`,
                );
              }
            } catch (error) {
              logger.warn(`Viewcrate response structure unavailable | type=${resourceType} | reason=${String(error).slice(0, 100)}`);
            }
          })());
        }
      };
      const onViewcrateRequestFailed = (request: HTTPRequest) => {
        logger.warn(
          `Viewcrate request failed | type=${request.resourceType()} | url=${safeUrl(request.url())} | reason=${request.failure()?.errorText || "unknown"}`,
        );
      };
      const onViewcrateConsole = (message: ConsoleMessage) => {
        const type = message.type();
        if (type !== "error" && type !== "warn") return;
        const location = message.location();
        const source = location.url ? safeUrl(location.url) : "unknown";
        logger.warn(`Viewcrate page console | type=${type} | source=${source} | line=${location.lineNumber ?? "unknown"} | text=${safeConsoleText(message.text())}`);
      };
      const onViewcratePageError = (error: unknown) => {
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        const stack =
          error instanceof Error && error.stack
            ? error.stack.split("\n").slice(0, 6).map((line) => safeConsoleText(line)).join(" | ")
            : "unavailable";
        logger.warn(
          `Viewcrate page JavaScript error | ${message.slice(0, 200)} | stack=${stack}`,
        );
      };
      page.on("request", onViewcrateRequest);
      page.on("response", onViewcrateResponse);
      page.on("requestfailed", onViewcrateRequestFailed);
      page.on("pageerror", onViewcratePageError);
      page.on("console", onViewcrateConsole);
      removeNetworkDiagnostics = () => {
        page.off("request", onViewcrateRequest);
        page.off("response", onViewcrateResponse);
        page.off("requestfailed", onViewcrateRequestFailed);
        page.off("pageerror", onViewcratePageError);
        page.off("console", onViewcrateConsole);
      };

      // Viewcrate renders its protected-content placeholder when its page context
      // believes it is hidden. Override visibility only in this page, before
      // navigation, so its own scripts initialize as if the document were visible.
      const visibilityOverride = await page.evaluateOnNewDocument(() => {
        // Keep a small, value-free timeline of DOM changes so we can see when
        // the protected placeholder or episode hosters appear.
        const timeline: Array<Record<string, unknown>> = [];
        const startedAt = performance.now();
        const snapshot = () => {
          const section = document.querySelector("main > div:nth-child(3)[data-resolve-url]");
          const bodyText = document.body?.innerText?.toLowerCase() || "";
          const state = {
            atMs: Math.round(performance.now() - startedAt),
            bootstrapResponseEndMs: Math.round(
              performance.getEntriesByType("resource")
                .filter((entry) => entry.name.includes("/bootstrap"))
                .reduce((latest, entry) => Math.max(latest, (entry as PerformanceResourceTiming).responseEnd || 0), 0),
            ),
            readyState: document.readyState,
            sectionPresent: Boolean(section),
            sectionChildren: section?.children.length || 0,
            hosterCount: Array.from(section?.querySelectorAll("*") || []).filter((element) =>
              Array.from(element.attributes).some((attribute) =>
                attribute.name.startsWith("data-") &&
                /pixeldrain|gofile|send\.now|send\.cm|mega\.nz|viking|fileditch/i.test(attribute.value),
              ),
            ).length,
            protectedContent: bodyText.includes("protected content"),
            downloadHandlerBound: section?.getAttribute("data-download-handler-bound") === "true",
          };
          const previous = timeline[timeline.length - 1];
          if (
            !previous ||
            previous.sectionPresent !== state.sectionPresent ||
            previous.sectionChildren !== state.sectionChildren ||
            previous.hosterCount !== state.hosterCount ||
            previous.protectedContent !== state.protectedContent ||
            previous.downloadHandlerBound !== state.downloadHandlerBound
          ) {
            if (timeline.length < 40) timeline.push(state);
          }
        };
        const record = () => {
          try { snapshot(); } catch { /* diagnostics must not affect page execution */ }
        };
        const observer = new MutationObserver(record);
        const startObserver = () => {
          if (document.documentElement) {
            observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-download-handler-bound"] });
          }
          record();
        };
        if (document.documentElement) startObserver();
        else document.addEventListener("DOMContentLoaded", startObserver, { once: true });
        (window as any).__viewcrateRuntimeDiagnostics = { timeline, getSnapshot: record };
        try {
          Object.defineProperty(Document.prototype, "visibilityState", {
            configurable: true,
            get: () => "visible",
          });
          Object.defineProperty(Document.prototype, "hidden", {
            configurable: true,
            get: () => false,
          });
          document.addEventListener(
            "DOMContentLoaded",
            () => queueMicrotask(() => document.dispatchEvent(new Event("visibilitychange"))),
            { once: true },
          );
        } catch {
          // Keep extraction running; runtime diagnostics will show actual state.
        }


      });
      removeVisibilityOverride = () =>
        page.removeScriptToEvaluateOnNewDocument(visibilityOverride.identifier);
      logger.log("Viewcrate page-scoped visibility override installed");

      let navigationResponse = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      // Submit the saved Viewcrate password through the site's own form so
      // the browser retains the required cookies and session state.
      if (password) {
        const formState = await page.evaluate(() => {
          const forms = Array.from(document.forms);
          const form = forms.find((candidate) =>
            Boolean(
              candidate.querySelector(
                'input[type="password"], input[name*="password" i], input[id*="password" i]',
              ),
            ),
          );
          const input = form?.querySelector<HTMLInputElement>(
            'input[type="password"], input[name*="password" i], input[id*="password" i]',
          );
          return {
            hasPasswordForm: Boolean(form && input),
            formAction: form?.action || "",
            inputName: input?.name || "",
          };
        });

        if (formState.hasPasswordForm) {
          logger.log(
            `Viewcrate protected form detected | action=${formState.formAction || "same-page"} | passwordField=${formState.inputName || "unnamed"}`,
          );
          const navigation = page
            .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 })
            .catch(() => null);
          const submitted = await page.evaluate((secret) => {
            const forms = Array.from(document.forms);
            const form = forms.find((candidate) =>
              Boolean(
                candidate.querySelector(
                  'input[type="password"], input[name*="password" i], input[id*="password" i]',
                ),
              ),
            );
            const input = form?.querySelector<HTMLInputElement>(
              'input[type="password"], input[name*="password" i], input[id*="password" i]',
            );
            if (!form || !input) return false;
            input.value = secret;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            form.requestSubmit();
            return true;
          }, password);
          if (submitted) {
            navigationResponse = (await navigation) || navigationResponse;
            await page.waitForSelector(
              "main > div:nth-child(3)[data-resolve-url]",
              { timeout: 20000 },
            ).catch(() => null);
          }
        } else {
          logger.warn("Viewcrate page did not expose a password form despite a stored password");
        }
      }

      await page
        .waitForSelector("main > div:nth-child(3)[data-resolve-url]", {
          timeout: 25000,
        })
        .catch(() => null);
      // Wait for the page's own episode renderer instead of relying on
      // generated CSS class prefixes, which can change between deployments.
      await page
        .waitForFunction(() => {
          const section = document.querySelector("main > div:nth-child(3)[data-resolve-url]");
          return Boolean(
            section &&
            section.children.length > 0 &&
            section.getAttribute("data-download-handler-bound") === "true",
          );
        }, { timeout: 15000 })
        .catch(() => null);

      // Inspect the already-loaded Viewcrate bundle from the page itself. This avoids
      // requiring a user to click a hoster after Nuvio has failed to extract streams.
      // Only short source windows around static handler/endpoint markers are logged.
      const handlerSourceDiagnostics = await page.evaluate(async () => {
        const resources = Array.from(performance.getEntriesByType("resource"))
          .map((entry) => entry.name)
          .filter((name) => {
            try {
              const resourceUrl = new URL(name);
              return resourceUrl.origin === location.origin &&
                /\\.js(?:\\?|$)/i.test(resourceUrl.pathname);
            } catch {
              return false;
            }
          })
          .slice(-12);
        const output: Array<{ url: string; bytes: number; snippets: string[] }> = [];
        for (const resource of resources) {
          try {
            const response = await fetch(resource, { credentials: "same-origin" });
            if (!response.ok) continue;
            const source = await response.text();
            const markers = /resolve-link|data-[a-z0-9]{5,}|open-base-url|download-handler-bound/gi;
            const snippets: string[] = [];
            let match: RegExpExecArray | null;
            while ((match = markers.exec(source)) && snippets.length < 24) {
              const start = Math.max(0, match.index - 180);
              const end = Math.min(source.length, match.index + match[0].length + 260);
              const snippet = source.slice(start, end).replace(/\\s+/g, " ");
              if (!snippets.includes(snippet)) snippets.push(snippet);
            }
            if (snippets.length) {
              output.push({
                url: new URL(resource).pathname,
                bytes: source.length,
                snippets,
              });
            }
          } catch {
            // A bundle that cannot be fetched from the page is skipped.
          }
        }
        return output;
      }).catch(() => []);
      if (handlerSourceDiagnostics.length) {
        logger.log(
          `Viewcrate loaded handler source diagnostics | bundles=${JSON.stringify(handlerSourceDiagnostics)}`,
        );
      } else {
        logger.warn("Viewcrate loaded handler source diagnostics unavailable | no matching bundle snippets found");
      }

      const pageRuntimeState = await page.evaluate(() => {
        const section = document.querySelector("main > div:nth-child(3)[data-resolve-url]");
        const bootstrapResource = performance
          .getEntriesByType("resource")
          .filter((entry) => entry.name.includes("/bootstrap"))
          .map((entry) => {
            const resource = entry as PerformanceResourceTiming;
            return {
              durationMs: Math.round(resource.duration),
              responseEndMs: Math.round(resource.responseEnd),
              transferSize: resource.transferSize || 0,
            };
          });
        const pageText = document.body?.innerText?.toLowerCase() || "";
        return {
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          focused: document.hasFocus(),
          visibilityOverride: true,
          readyState: document.readyState,
          sectionChildCount: section?.children.length ?? 0,
          downloadHandlerBound: section?.getAttribute("data-download-handler-bound") === "true",
          protectedContent: pageText.includes("protected content"),
          automationSignals: {
            webdriver: navigator.webdriver,
            outerWidth: window.outerWidth,
            outerHeight: window.outerHeight,
          },
          bootstrapResource,
        };
      }).catch(() => ({ visibilityState: "unavailable", hidden: null, focused: null, visibilityOverride: true, readyState: "unavailable", sectionChildCount: -1, downloadHandlerBound: false, protectedContent: false, automationSignals: { webdriver: null, outerWidth: null, outerHeight: null }, bootstrapResource: [], render: null }));
      const runtimeTimeline = await page.evaluate(() => {
        const diagnostics = (window as any).__viewcrateRuntimeDiagnostics;
        diagnostics?.getSnapshot?.();
        return Array.isArray(diagnostics?.timeline) ? diagnostics.timeline : [];
      }).catch(() => []);
      if (runtimeTimeline.length) {
        logger.log(`Viewcrate DOM mutation timeline | events=${JSON.stringify(runtimeTimeline)}`);
        const firstMutation = runtimeTimeline[0];
        const bootstrapResponseEndMs = Number(runtimeTimeline[runtimeTimeline.length - 1].bootstrapResponseEndMs || 0);
        const firstPostBootstrapMutation = runtimeTimeline.find((event: any) =>
          Number(event.atMs) >= bootstrapResponseEndMs && bootstrapResponseEndMs > 0,
        );
        const protectedContentEvent = runtimeTimeline.find((event: any) => event.protectedContent === true);
        const hosterRenderEvent = runtimeTimeline.find((event: any) => Number(event.hosterCount) > 0);
        logger.log(
          `Viewcrate bootstrap runtime markers | firstMutationMs=${firstMutation?.atMs ?? "none"} | bootstrapResponseEndMs=${bootstrapResponseEndMs || "unavailable"} | firstPostBootstrapMutationMs=${firstPostBootstrapMutation?.atMs ?? "none"} | protectedContentMs=${protectedContentEvent?.atMs ?? "never"} | firstHosterRenderMs=${hosterRenderEvent?.atMs ?? "never"}`,
        );
      } else {
        logger.warn("Viewcrate DOM mutation timeline unavailable or empty");
      }
      await Promise.allSettled(responseDiagnosticTasks);
      const html = await page.content();
      const status = navigationResponse?.status() ?? 0;
      const $ = cheerio.load(html);
      const $dlcSection = $("main > div").eq(2);
      const hasDlcSection = Boolean($dlcSection.attr("data-resolve-url"));
      const parsedEpisodeHosters = getEpisodeHosters(html);
      const sectionHosters = parsedEpisodeHosters.reduce(
        (total, episode) => total + episode.data.length,
        0,
      );
      const documentHosters = $("*").filter((_, element) =>
        Object.entries((element as any).attribs || {}).some(
          ([key, value]) =>
            key.startsWith("data-") &&
            typeof value === "string" &&
            Boolean(getHosterFromUrl(value)),
        ),
      ).length;
      const pageText = $("body").text().replace(/\s+/g, " ").trim();
      const sectionPreview = $dlcSection.text().replace(/\s+/g, " ").trim().slice(0, 250);
      const sectionChildren = $dlcSection.children().map((_, element) => {
        const tag = (element as any).tagName || "node";
        const className = $(element).attr("class") || "";
        return className ? `${tag}.${className}` : tag;
      }).get().slice(0, 12);
      const renderedHosterRows = $dlcSection.children().map((episodeIndex, episode) => {
        const $episode = $(episode);
        const episodeNumber = $episode.find("h2").first().text().trim();
        return $episode.find("button").map((buttonIndex, button) => {
          const $button = $(button);
          const $row = $button.parent();
          const spans = $row.find("span").map((_, span) => $(span).text().trim()).get();
          const attributes = Object.entries((button as any).attribs || {}).map(([key, value]) => {
            const text = String(value || "");
            const isUrl = text.startsWith("http://") || text.startsWith("https://");
            let parsed: URL | null = null;
            if (isUrl) {
              try { parsed = new URL(text); } catch {}
            }
            return {
              key,
              length: text.length,
              valueType: isUrl ? "url" : "text",
              host: parsed?.hostname,
              sha256: hashValue(text),
            };
          });
          return {
            episode: episodeNumber || String(episodeIndex + 1),
            buttonIndex,
            label: spans[0] || "",
            size: spans[1] || "",
            buttonLabel: $button.attr("aria-label") || "",
            attributes,
          };
        }).get();
      }).get();
      const firstEpisode = $dlcSection.children().first();
      const firstEpisodeStructure = firstEpisode.find("*").addBack().slice(0, 18).map((_, element) => {
        const attributes = (element as any).attribs || {};
        let href: URL | null = null;
        try {
          if (attributes.href) href = new URL(attributes.href, VIEWCRATE_ORIGIN);
        } catch {}
        const dataValues = Object.entries(attributes)
          .filter(([key, value]) => key.startsWith("data-") && typeof value === "string")
          .map(([key, value]) => {
            let host = "";
            try {
              host = new URL(value as string, VIEWCRATE_ORIGIN).hostname;
            } catch {}
            return { key, host: host || undefined, valueType: (value as string).startsWith("http") ? "url" : "text" };
          });
        return {
          tag: (element as any).tagName || "node",
          className: attributes.class || "",
          attributeNames: Object.keys(attributes),
          href: href ? { host: href.hostname, path: href.pathname } : undefined,
          dataValues,
          text: $(element).children().length === 0 ? $(element).text().trim().slice(0, 100) : undefined,
        };
      }).get();
      const formSummary = $("form").map((_, form) => ({
        action: $(form).attr("action") || "",
        method: ($(form).attr("method") || "get").toLowerCase(),
        fields: $(form).find("input").map((__, input) => ({
          name: $(input).attr("name") || "",
          type: $(input).attr("type") || "text",
        })).get(),
        buttons: $(form).find("button, input[type='submit']").map((__, button) =>
          $(button).text().trim() || $(button).attr("value") || "",
        ).get(),
      })).get();
      const sectionAttributes = $dlcSection.length
        ? { ...($dlcSection[0] as any).attribs }
        : {};
      if (status >= 400 || !hasDlcSection) {
        logger.warn(
          `Viewcrate DOM diagnostic | url=${page.url()} | body=${pageText.slice(0, 450)} | forms=${JSON.stringify(formSummary)} | mainDivs=${$("main > div").length}`,
        );
        throw new ViewcrateError(
          `Viewcrate page did not render in SO7O | status=${status} | title=${$("title").text().trim()}`,
        );
      }

      logger.log(
        `Viewcrate browser page ready | status=${status} | bytes=${Buffer.byteLength(html)} | episodeHosters=${sectionHosters} | documentHosters=${documentHosters} | protectedText=${pageText.toLowerCase().includes("protected content")} | passwordProvided=${Boolean(password)} | forms=${formSummary.length} | sectionPreview=${sectionPreview} | sectionChildren=${JSON.stringify(sectionChildren)} | sectionAttributes=${JSON.stringify(sectionAttributes)} | pageRuntimeState=${JSON.stringify(pageRuntimeState)}`,
      );
      logger.log(
        `Viewcrate first episode DOM structure | elements=${JSON.stringify(firstEpisodeStructure)}`,
      );
      logger.log(
        `Viewcrate rendered hoster rows | count=${renderedHosterRows.length} | rows=${JSON.stringify(renderedHosterRows)}`,
      );
      if (pageRuntimeState.protectedContent && sectionHosters === 0) {
        const signals = pageRuntimeState.automationSignals;
        logger.warn(
          `Viewcrate anti-automation response detected | webdriver=${signals?.webdriver ?? "unavailable"} | outerWidth=${signals?.outerWidth ?? "unavailable"} | outerHeight=${signals?.outerHeight ?? "unavailable"}`,
        );
        throw new ViewcrateError("Viewcrate blocked the automated browser context (Protected Content)");
      }
      return html;
    } finally {
      removeNetworkDiagnostics?.();
      if (removeVisibilityOverride) {
        try {
          await removeVisibilityOverride();
          logger.log("Viewcrate page-scoped visibility override removed");
        } catch (error) {
          logger.warn("Could not remove Viewcrate visibility override | reason=" + String(error).slice(0, 120));
        }
      }
      // The WebView belongs to SO7O; disconnect without closing its page.
      await browser.disconnect();
    }
  });
}

export async function getDlcUrl(html: string): Promise<string | undefined> {
  const $ = cheerio.load(html);
  const attr = $("main > div").eq(2).attr("data-resolve-url");
  if (!attr) throw new ViewcrateError("No DLC link");
  const link = `/api/dlc_url/${attr.replace("/c/", "").split("/")[0]}`;
  if (!link) throw new ViewcrateError("No DLC link");
  const dlcUrl = new URL(link, VIEWCRATE_ORIGIN).toString();
  const finalDlcUrl = await axiosGet<{ url: string }>(dlcUrl);
  return finalDlcUrl?.url;
}

function getProtectedContent(html: string) {
  const $ = cheerio.load(html);
  const csrfToken = $("input[name='csrf_token']").val();
  if (!csrfToken) throw new ViewcrateError("Protected Content No csrf");
  const action = $("form").attr("action");
  if (!action) throw new ViewcrateError("Protected Content No action");
  const postUrl = new URL(action, VIEWCRATE_ORIGIN).toString();
  return { csrfToken, postUrl };
}

export function getEpisodeHosters(html: string): EpisodeHoster[] {
  const $ = cheerio.load(html);
  const $episodes = $("main > div").eq(2).children();
  const episodes: EpisodeHoster[] = [];
  $episodes.each((_, episode) => {
    const $episode = $(episode);
    const episodeTitle = $episode.find("h2").text();
    // Viewcrate's generated hoster class prefix changes between deployments
    // (for example, y_* to z_*). Identify hoster cards by their data-* URL
    // attributes instead of depending on an obfuscated CSS class name.
    const episodeHosters = $episode.find("*").filter((_, element) =>
      Object.entries((element as any).attribs || {}).some(
        ([key, value]) =>
          key.startsWith("data-") &&
          typeof value === "string" &&
          Boolean(getHosterFromUrl(value)),
      ),
    );
    const data: { hoster: Hoster; size: string }[] = [];
    episodeHosters.each((_, hosterElement) => {
      const $hoster = $(hosterElement);
      const sizeText = $hoster.find("span").last().text();
      let size = "";
      if (sizeText.includes("GB")) {
        size = sizeText.replace(/GB/, "").trim();
      } else if (sizeText.includes("MB")) {
        size = (parseFloat(sizeText.replace(/MB/, "").trim()) / 1024).toFixed(
          2,
        );
      }
      for (const [key, value] of Object.entries($hoster.attr() || {})) {
        if (key.startsWith("data-") && value) {
          const hoster = getHosterFromUrl(value);
          if (hoster) data.push({ size, hoster });
        }
      }
    });
    episodes.push({
      ep: parseInt(episodeTitle.replace(/.*E/, "")),
      data: data,
    });
  });
  return episodes;
}

export function parseJkAndCryptedFromHtml(html: string): {
  crypted: string;
  jk: string;
} {
  const cryptedMatch = html.match(/"crypted":"([^"]+)"/);
  const parsedJk = parseJk(html);
  return {
    crypted: cryptedMatch?.[1] ?? "",
    jk: parsedJk,
  };
}

function parseJk(jk: string) {
  const jkMatch = jk.match(/return\s+['"]([^'"]+)['"]/);
  if (!jkMatch) return "";
  return jkMatch?.[1] ?? "";
}

async function getUrlsFromCnl(viewcrateCnl: ViewcrateCnl) {
  const { crypted, jk } = viewcrateCnl;
  const parsedJk = parseJk(jk);
  const urls = await decryptCnl(parsedJk, crypted);
  return urls;
}

// async function getUrlsFromCnlHtml(html: string) {
//   const { crypted, jk } = parseJkAndCryptedFromHtml(html);
//   const urls = await decryptCnl(jk, crypted);
//   return urls;
// }

async function decryptCnl(jk: string, crypted: string) {
  const key = Buffer.from(jk, "hex");
  const combined = Buffer.from(crypted, "base64");
  const iv = combined.subarray(0, 16);
  const encrypted = combined.subarray(16);
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  const text = decrypted.toString("utf8");
  const urls = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
  return urls;
}

export function decodeViewcrateToken(raw: string) {
  const encoded = raw.trim();
  if (!encoded) return null;
  try {
    const normalized = encoded
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const decoded = Buffer.from(normalized, "base64").toString("utf8").trim();
    return /^[a-f0-9]{16,}$/i.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}
