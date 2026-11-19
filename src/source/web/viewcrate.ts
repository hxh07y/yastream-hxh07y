import * as cheerio from "cheerio";
import * as crypto from "crypto";
import type { HTTPRequest, HTTPResponse } from "puppeteer";
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
    let removeNetworkDiagnostics: (() => void) | undefined;
    let removeVisibilityOverride: (() => Promise<void>) | undefined;
    try {
      const pages = await browser.pages();
      // SO7O exposes its existing WebView rather than allowing new targets.
      // Reuse it even when the current page is not already on Viewcrate.
      const page = pages.find((candidate) => candidate.url() !== "about:blank") || pages[0];
      if (!page) {
        throw new ViewcrateError("SO7O does not expose an existing WebView page");
      }

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
      const onViewcrateRequest = (request: HTTPRequest) => {
        const requestUrl = request.url();
        if (!requestUrl.startsWith(VIEWCRATE_ORIGIN)) return;
        const path = new URL(requestUrl).pathname;
        if (request.resourceType() === "script") {
          logger.log(
            `Viewcrate script request | method=${request.method()} | url=${safeUrl(requestUrl)}`,
          );
        }
        if (!/api|unlock|protect|password|resolve|\/c\//i.test(path)) return;
        logger.log(
          `Viewcrate network request | method=${request.method()} | type=${request.resourceType()} | url=${safeUrl(requestUrl)}`,
        );
      };
      const onViewcrateResponse = (response: HTTPResponse) => {
        const responseUrl = response.url();
        if (!responseUrl.startsWith(VIEWCRATE_ORIGIN)) return;
        const path = new URL(responseUrl).pathname;
        if (response.request().resourceType() === "script") {
          logger.log(
            `Viewcrate script response | status=${response.status()} | contentType=${response.headers()["content-type"] || "unknown"} | url=${safeUrl(responseUrl)}`,
          );
        }
        if (!/api|unlock|protect|password|resolve/i.test(path) && !path.includes("/c/")) return;
        logger.log(
          `Viewcrate network response | status=${response.status()} | type=${response.request().resourceType()} | contentType=${response.headers()["content-type"] || "unknown"} | url=${safeUrl(responseUrl)}`,
        );

      };
      const onViewcrateRequestFailed = (request: HTTPRequest) => {
        if (!request.url().startsWith(VIEWCRATE_ORIGIN)) return;
        logger.warn(
          `Viewcrate request failed | type=${request.resourceType()} | url=${safeUrl(request.url())} | reason=${request.failure()?.errorText || "unknown"}`,
        );
      };
      const onViewcratePageError = (error: unknown) => {
        const message =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error);
        logger.warn(
          `Viewcrate page JavaScript error | ${message.slice(0, 200)}`,
        );
      };
      page.on("request", onViewcrateRequest);
      page.on("response", onViewcrateResponse);
      page.on("requestfailed", onViewcrateRequestFailed);
      page.on("pageerror", onViewcratePageError);
      removeNetworkDiagnostics = () => {
        page.off("request", onViewcrateRequest);
        page.off("response", onViewcrateResponse);
        page.off("requestfailed", onViewcrateRequestFailed);
        page.off("pageerror", onViewcratePageError);
      };

      // Viewcrate renders its protected-content placeholder when its page context
      // believes it is hidden. Override visibility only in this page, before
      // navigation, so its own scripts initialize as if the document were visible.
      const visibilityOverride = await page.evaluateOnNewDocument(() => {
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

        // Track the exact transition of the DLC section, and capture the
        // JavaScript call site when page code mutates that section.
        const renderWindow = window as typeof window & {
          __viewcrateRenderDiag?: {
            startedAt: number;
            section?: Element;
            mutations: Array<Record<string, unknown>>;
            operations: Array<Record<string, unknown>>;
            rootObserver?: MutationObserver;
            sectionObserver?: MutationObserver;
            restorers: Array<() => void>;
          };
        };
        const diag = {
          startedAt: performance.now(),
          section: undefined as Element | undefined,
          mutations: [] as Array<Record<string, unknown>>,
          operations: [] as Array<Record<string, unknown>>,
          rootObserver: undefined as MutationObserver | undefined,
          sectionObserver: undefined as MutationObserver | undefined,
          restorers: [] as Array<() => void>,
        };
        renderWindow.__viewcrateRenderDiag = diag;

        const safeFrame = (frame: string) =>
          frame.replace(/https?:\/\/[^\s)]+/g, (raw) => {
            try {
              const parsed = new URL(raw);
              const path = parsed.pathname.split("/").map((part) =>
                part.length > 32 || /^[a-f0-9]{24,}$/i.test(part) ? "[redacted]" : part
              ).join("/");
              return parsed.origin + path;
            } catch {
              return "[redacted-url]";
            }
          });

        const sectionSnapshot = () => {
          const section = diag.section;
          if (!section) return { found: false };
          const text = (section.textContent || "").replace(/\s+/g, " ").trim();
          return {
            found: true,
            childCount: section.children.length,
            hosterCount: section.querySelectorAll("div[class^='y_']").length,
            protectedMarker: /protected content/i.test(text),
            textLength: text.length,
            childTypes: Array.from(section.children).slice(0, 8).map((child) => ({
              tag: child.tagName.toLowerCase(),
              className: typeof child.className === "string" ? child.className.slice(0, 100) : "",
            })),
          };
        };

        const recordOperation = (operation: string, target: Node) => {
          const section = diag.section;
          if (!section || diag.operations.length >= 20) return;
          if (target !== section && target !== section.parentNode && !section.contains(target)) return;
          const stack = String(new Error().stack || "").split("\n").slice(2, 7).map(safeFrame);
          diag.operations.push({
            atMs: Math.round(performance.now() - diag.startedAt),
            operation,
            target: target.nodeName,
            stack,
          });
        };

        const wrapMethod = (prototype: any, name: string) => {
          const original = prototype?.[name];
          if (typeof original !== "function") return;
          const wrapped = function(this: Node, ...args: unknown[]) {
            try { recordOperation(name, this); } catch { /* diagnostics must not affect rendering */ }
            return original.apply(this, args);
          };
          prototype[name] = wrapped;
          diag.restorers.push(() => {
            if (prototype[name] === wrapped) prototype[name] = original;
          });
        };

        const wrapSetter = (prototype: any, name: string) => {
          const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
          if (!descriptor?.set || !descriptor.configurable) return;
          const wrapped = function(this: Node, value: unknown) {
            try { recordOperation(name + "=", this); } catch { /* diagnostics must not affect rendering */ }
            return descriptor.set!.call(this, value);
          };
          Object.defineProperty(prototype, name, { ...descriptor, set: wrapped });
          diag.restorers.push(() => {
            const current = Object.getOwnPropertyDescriptor(prototype, name);
            if (current?.set === wrapped) Object.defineProperty(prototype, name, descriptor);
          });
        };

        const attachSectionObserver = () => {
          const section = document.querySelector("main > div:nth-child(3)[data-resolve-url]");
          if (!section || section === diag.section) return;
          diag.sectionObserver?.disconnect();
          diag.section = section;
          diag.sectionObserver = new MutationObserver((records) => {
            if (diag.mutations.length >= 30) return;
            diag.mutations.push({
              atMs: Math.round(performance.now() - diag.startedAt),
              records: records.length,
              types: Array.from(new Set(records.map((record) => record.type))),
              state: sectionSnapshot(),
            });
          });
          diag.sectionObserver.observe(section, {
            childList: true, subtree: true, attributes: true, characterData: true,
          });
        };

        // These wrappers only record operations targeting the DLC section or
        // descendants; native methods and their return values are preserved.
        for (const name of ["appendChild", "insertBefore", "removeChild", "replaceChild"]) {
          wrapMethod(Node.prototype, name);
        }
        for (const name of ["replaceChildren", "append", "prepend", "replaceWith", "remove", "insertAdjacentHTML", "insertAdjacentText"]) {
          wrapMethod(Element.prototype, name);
        }
        wrapSetter(Element.prototype, "innerHTML");
        wrapSetter(Node.prototype, "textContent");

        diag.rootObserver = new MutationObserver(() => attachSectionObserver());
        if (document.documentElement) {
          diag.rootObserver.observe(document.documentElement, { childList: true, subtree: true });
        }
        attachSectionObserver();
      });
      removeVisibilityOverride = () =>
        page.removeScriptToEvaluateOnNewDocument(visibilityOverride.identifier);
      logger.log("Viewcrate page-scoped visibility override and render diagnostics installed");

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
      // Viewcrate renders episode hosters with JavaScript after the base DOM.
      await page
        .waitForSelector("main > div:nth-child(3) div[class^='y_']", {
          timeout: 15000,
        })
        .catch(() => null);

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
        const diag = (window as typeof window & {
          __viewcrateRenderDiag?: {
            startedAt: number;
            mutations: Array<Record<string, unknown>>;
            operations: Array<Record<string, unknown>>;
          };
        }).__viewcrateRenderDiag;
        const render = diag ? {
          elapsedMs: Math.round(performance.now() - diag.startedAt),
          mutations: diag.mutations,
          operations: diag.operations,
        } : null;
        return {
          visibilityState: document.visibilityState,
          hidden: document.hidden,
          focused: document.hasFocus(),
          visibilityOverride: true,
          readyState: document.readyState,
          sectionChildCount: section?.children.length ?? 0,
          downloadHandlerBound: section?.getAttribute("data-download-handler-bound") === "true",
          bootstrapResource,
          render,
        };
      }).catch(() => ({ visibilityState: "unavailable", hidden: null, focused: null, visibilityOverride: true, readyState: "unavailable", sectionChildCount: -1, downloadHandlerBound: false, bootstrapResource: [], lifecycle: null }));
      const html = await page.content();
      const status = navigationResponse?.status() ?? 0;
      const $ = cheerio.load(html);
      const $dlcSection = $("main > div").eq(2);
      const hasDlcSection = Boolean($dlcSection.attr("data-resolve-url"));
      const sectionHosters = $dlcSection.find("div[class^='y_']").length;
      const documentHosters = $("div[class^='y_']").length;
      const pageText = $("body").text().replace(/\s+/g, " ").trim();
      const sectionPreview = $dlcSection.text().replace(/\s+/g, " ").trim().slice(0, 250);
      const sectionChildren = $dlcSection.children().map((_, element) => {
        const tag = (element as any).tagName || "node";
        const className = $(element).attr("class") || "";
        return className ? `${tag}.${className}` : tag;
      }).get().slice(0, 12);
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
      return html;
    } finally {
      removeNetworkDiagnostics?.();
      try {
        await page.evaluate(() => {
          const diag = (window as typeof window & {
            __viewcrateRenderDiag?: {
              rootObserver?: MutationObserver;
              sectionObserver?: MutationObserver;
              restorers: Array<() => void>;
            };
          }).__viewcrateRenderDiag;
          diag?.rootObserver?.disconnect();
          diag?.sectionObserver?.disconnect();
          for (const restore of diag?.restorers || []) {
            try { restore(); } catch { /* best-effort restoration */ }
          }
          delete (window as typeof window & { __viewcrateRenderDiag?: unknown }).__viewcrateRenderDiag;
        });
      } catch {
        // The page may have navigated or detached during cleanup.
      }
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
    const episodeHosters = $episode.find(`div[class^="y_"]`);
    const data: { hoster: Hoster; size: string }[] = [];
    episodeHosters.each((_, hoster) => {
      const $hoster = $(hoster);
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
