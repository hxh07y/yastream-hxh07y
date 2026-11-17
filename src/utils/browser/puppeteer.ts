/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { load } from "cheerio";
import puppeteer, { CookieData, Handler, Page } from "puppeteer";
import { OUO_HOSTS } from "../../source/web/ouo.js";
import { matchesAnyHost, matchesHost } from "../../utils/url-validation.js";
import { MKVDRAMA_HOST, PIXELDRAIN_HOST } from "../constant.js";
import { ENV } from "../env.js";
import { handleError } from "../error.js";
import { Logger } from "../logger.js";

const logger = new Logger("PUPPETEER");
const FINAL_HOSTS = [...OUO_HOSTS, PIXELDRAIN_HOST];

export async function getBrowser() {
  let browserWSEndpoint = ENV.PUPPETEER_WS_ENDPOINT;
  let headers: Record<string, string> = {
    Authorization: ENV.PUPPETEER_AUTH_HEADER,
  };

  // Resolve the WebSocket endpoint dynamically for HTTP CDP bridges such as SO7O.
  if (ENV.PUPPETEER_CDP_HTTP_URL) {
    const endpoint = new URL(ENV.PUPPETEER_CDP_HTTP_URL);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/json/version`;
    if (ENV.PUPPETEER_CDP_TOKEN) {
      endpoint.searchParams.set("token", ENV.PUPPETEER_CDP_TOKEN);
    }

    const response = await fetch(endpoint);
    if (!response.ok) {
      throw new Error(`CDP version endpoint returned HTTP ${response.status}`);
    }
    const version = (await response.json()) as {
      webSocketDebuggerUrl?: string;
    };
    if (!version.webSocketDebuggerUrl) {
      throw new Error("CDP version response did not include a WebSocket URL");
    }

    const websocket = new URL(version.webSocketDebuggerUrl);
    if (ENV.PUPPETEER_CDP_TOKEN) {
      websocket.searchParams.set("token", ENV.PUPPETEER_CDP_TOKEN);
    }
    browserWSEndpoint = websocket.toString();
    headers = {};
  }

  if (!browserWSEndpoint) {
    throw new Error("Puppeteer CDP endpoint is not configured");
  }

  return await puppeteer.connect({
    browserWSEndpoint,
    headers,
  });
}

function parseFormFields(html: string, formSelector: string): string {
  const $ = load(html);
  const form = $(formSelector);
  if (!form.length) return "";

  const params = new URLSearchParams();
  form.find("input").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).val();
    if (name && typeof value === "string") {
      params.append(name, value);
    }
  });
  return params.toString();
}

const PAGE_WAIT_MS = 5000;
export async function getPuppeteerRequest(
  url: string,
  cookies?: any,
  userAgent?: string,
) {
  const request = async () => {
    const browser = await getBrowser();
    let page: Page | undefined;
    const ownsPage = !ENV.PUPPETEER_CDP_HTTP_URL;
    let html = "";
    try {
      browser.setCookie(...(cookies || []));
      if (ownsPage) {
        page = await browser.newPage();
      } else {
        const pages = await browser.pages();
        page = pages[0];
        if (!page) throw new Error("SO7O CDP did not expose an existing WebView page");
      }
      page.setUserAgent({ userAgent: userAgent || ENV.USER_AGENT });
      await page.goto(url, {
        waitUntil: "networkidle0",
        timeout: 5000,
      });
      html = await page.content();
    } catch (error) {
      console.error(error);
    } finally {
      if (page && ownsPage) await page.close().catch(() => {});
      await browser.disconnect().catch(() => {});
    }
    return html;
  };
  return ENV.PUPPETEER_CDP_HTTP_URL
    ? withCdpPageLock("getPuppeteerRequest", request)
    : request();
}
// export async function getPuppeteerRequest(
//   url: string,
//   cookies?: any,
//   userAgent?: string,
// ) {
//   const browser = await getBrowser();
//   browser.setCookie(...(cookies || []));
//   const page = await browser.newPage();
//   if (userAgent) {
//     page.setUserAgent({ userAgent });
//   }
//   let xhrStatus = null;
//   const downloadDataPromise = page
//     .waitForResponse(
//       (resp) => {
//         if (
//           resp.url().includes("_l_krc_uo") ||
//           resp.url().includes("oe_pq_invxe_l")
//         ) {
//           xhrStatus = resp.status();
//           return resp.status() === 200;
//         }
//         return false;
//       },
//       { timeout: PAGE_WAIT_MS },
//     )
//     .catch(() => null);
//   await page.goto(url, {
//     waitUntil: "load",
//     timeout: 5000,
//   });
//   const downloadResponse = await downloadDataPromise;
//   if (downloadResponse) {
//     logger.log(`Download data XHR completed in ms`);
//     await new Promise((r) => setTimeout(r, 1500));
//   } else {
//     logger.log(
//       `Download XHR not detected (xhr status: ${xhrStatus}), waiting for selectors...`,
//     );
//     try {
//       await page.waitForSelector(".soraddlx, .soraddl, .soradd", {
//         timeout: PAGE_WAIT_MS,
//       });
//       await new Promise((r) => setTimeout(r, 500));
//     } catch {
//       logger.log(
//         `No download sections appeared within ${PAGE_WAIT_MS}ms`,
//       );
//     }
//   }

//   const content = await page.content();
//   // const cookies = await browser.cookies();
//   await browser.close();
//   return { content, cookies };
// }
const NOT_FINAL_HOSTS = [
  "sl.buisthainan.com",
  "mkvdrama",
  "send",
  "cloudflare",
  "google",
  "gstatic",
  "jsdelivr",
  "turnstile",
];

// SO7O exposes one shared WebView page. Every operation that navigates or
// inspects that page must hold this lock for its full lifetime.
let cdpPageQueue: Promise<void> = Promise.resolve();
let activeCdpPageOperation = "none";
let cdpPageOperationSequence = 0;

export async function withCdpPageLock<T>(
  operationName: string,
  operation: () => Promise<T>,
): Promise<T> {
  const operationId = ++cdpPageOperationSequence;
  const requestedAt = Date.now();
  logger.log(
    `CDP lock request | id=${operationId} | op=${operationName} | pid=${process.pid} | active=${activeCdpPageOperation}`,
  );
  const previousOperation = cdpPageQueue;
  let releaseOperation!: () => void;
  cdpPageQueue = new Promise<void>((resolve) => {
    releaseOperation = resolve;
  });
  await previousOperation;
  const acquiredAt = Date.now();
  activeCdpPageOperation = `${operationName}#${operationId}`;
  logger.log(
    `CDP lock acquired | id=${operationId} | op=${operationName} | pid=${process.pid} | waitMs=${acquiredAt - requestedAt}`,
  );
  try {
    return await operation();
  } finally {
    logger.log(
      `CDP lock released | id=${operationId} | op=${operationName} | pid=${process.pid} | heldMs=${Date.now() - acquiredAt}`,
    );
    activeCdpPageOperation = "none";
    releaseOperation();
  }
}

async function postRedirectedUrlCDPLocked(
  targetUrl: string,
  postData?: string,
  cookies?: CookieData[],
  userAgent?: string,
  formSelector?: string,
  preferMediaSource = false,
) {
  let redirectedUrl = "";
  let mediaSourceUrl = "";
  let browser: Awaited<ReturnType<typeof getBrowser>> | undefined;
  let page: Page | undefined;
  let client: Awaited<ReturnType<Page["createCDPSession"]>> | undefined;
  let interceptionEnabled = false;

  try {
    browser = await getBrowser();
    if (cookies) browser.setCookie(...cookies);

    const pages = await browser.pages();
    page = pages[0];
    if (!page) {
      throw new Error("SO7O CDP did not expose an existing WebView page");
    }

    page.setUserAgent({ userAgent: userAgent || ENV.USER_AGENT });

    let formActionUrl = targetUrl;
    if (formSelector && !postData) {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      const html = await page.content();
      const $ = load(html);
      formActionUrl = $(formSelector).attr("action") || targetUrl;
      postData = parseFormFields(html, formSelector);
      logger.trace(`form action ${formActionUrl}`);
      logger.trace(`parsed postData ${postData?.substring(0, 80)}`);
    }

    await page.setRequestInterception(true);
    interceptionEnabled = true;
    client = await page.createCDPSession();
    await client.send("Network.enable");

    let redirectLocation: string | undefined;
    let postSubmitted = false;
    const changeToPost: Handler<any> = (interceptRequest) => {
      // Only convert the intended top-level navigation into the download form POST.
      // All scripts, stylesheets, and redirect follow-up requests must remain GETs.
      if (
        !postSubmitted &&
        interceptRequest.isNavigationRequest() &&
        interceptRequest.url() === formActionUrl
      ) {
        postSubmitted = true;
        logger.log(`Send POST submitted | ${interceptRequest.url()} | bodyLength=${(postData || "").length}`);
        void interceptRequest.continue({
          method: "POST",
          postData: postData || "",
        });
        return;
      }
      void interceptRequest.continue();
    };
    const onRequestSent: Handler<any> = (params) => {
      const reqUrl = params.request?.url || "";
      if (params.type === "Document" || params.redirectResponse) {
        const redirectResponse = params.redirectResponse;
        const locationHeader = redirectResponse?.headers
          ? Object.entries(redirectResponse.headers).find(
              ([name]) => name.toLowerCase() === "location",
            )?.[1]
          : undefined;
        logger.log(
          `Send CDP request | type=${params.type || "unknown"} | method=${params.request?.method || "unknown"} | url=${reqUrl} | redirectStatus=${redirectResponse?.status ?? "none"} | location=${locationHeader || "none"}`,
        );
        if (locationHeader && typeof locationHeader === "string") {
          try {
            redirectLocation = new URL(locationHeader, reqUrl).toString();
            redirectedUrl = redirectLocation;
          } catch {
            // Keep diagnostics even if the redirect Location is malformed.
          }
        }
      }

      // Preserve the original document URL capture as a fallback.
      if (
        params.type === "Document" &&
        reqUrl.startsWith("http") &&
        !NOT_FINAL_HOSTS.some((host) => reqUrl.includes(host))
      ) {
        if (!redirectLocation) {
          redirectLocation = reqUrl.split("?__cf_chl")[0];
          if (redirectLocation) redirectedUrl = redirectLocation;
        }
      }
    };
    const onResponseReceived: Handler<any> = (params) => {
      const response = params.response;
      if (params.type !== "Document" && !response?.url?.includes("send.now")) {
        return;
      }
      const headers = response?.headers || {};
      const locationHeader = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "location",
      )?.[1];
      const dispositionHeader = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "content-disposition",
      )?.[1];
      logger.log(
        `Send CDP response | type=${params.type || "unknown"} | status=${response?.status ?? "unknown"} | url=${response?.url || "unknown"} | location=${locationHeader || "none"} | disposition=${dispositionHeader || "none"}`,
      );
    };

    const onMainFrameNavigated = (frame: any) => {
      if (frame === page?.mainFrame()) {
        logger.warn(
          `Page navigated during Send POST | url=${frame.url()} | lockOwner=${activeCdpPageOperation} | pid=${process.pid}`,
        );
      }
    };
    page.on("framenavigated", onMainFrameNavigated);
    page.on("request", changeToPost);
    client.on("Network.requestWillBeSent", onRequestSent);
    client.on("Network.responseReceived", onResponseReceived);
    logger.trace(`on request: ${formActionUrl}`);
    try {
      await page.goto(formActionUrl, {
        waitUntil: "domcontentloaded",
        timeout: 10000,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      handleError(error, logger, `Fail post CDP request ${targetUrl}`);
    } finally {
      page.off("request", changeToPost);
      page.off("framenavigated", onMainFrameNavigated);
      client.off("Network.requestWillBeSent", onRequestSent);
      client.off("Network.responseReceived", onResponseReceived);
      if (preferMediaSource) {
        mediaSourceUrl = await page.evaluate(() => {
          const video = document.querySelector("video");
          const source = video?.currentSrc || video?.querySelector("source")?.src || "";
          return source.startsWith("http://") || source.startsWith("https://")
            ? source
            : "";
        }).catch((error) => {
          logger.warn(`Unable to read Send video source: ${error}`);
          return "";
        });
      }
      const pageDiagnostics = await page.evaluate(() => ({
        title: document.title,
        forms: Array.from(document.forms).map((form) => ({
          action: form.action,
          method: form.method,
          fields: Array.from(form.elements)
            .filter((element) => element instanceof HTMLInputElement)
            .map((element) => ({
              name: (element as HTMLInputElement).name,
              type: (element as HTMLInputElement).type,
              hasValue: Boolean((element as HTMLInputElement).value),
            })),
        })),
        videoSources: Array.from(document.querySelectorAll("video, source"))
          .map((element) => ({
            tag: element.tagName,
            src: (element as HTMLMediaElement).src || element.getAttribute("src") || "",
          }))
          .filter((item) => Boolean(item.src)),
        bodyText: (document.body?.innerText || "").replace(/\\s+/g, " ").slice(0, 700),
      })).catch((error) => ({ diagnosticError: String(error) }));
      logger.log(
        `Send POST result | submitted=${postSubmitted} | pageUrl=${page.url()} | capturedUrl=${redirectLocation || "none"} | page=${JSON.stringify(pageDiagnostics)}`,
      );
    }

    logger.trace(`off request: ${targetUrl}`);
    if (preferMediaSource && mediaSourceUrl) {
      logger.log(`Send media source captured: ${mediaSourceUrl}`);
      return mediaSourceUrl;
    }
    if (redirectLocation) {
      logger.log(`redirected (CDP): ${targetUrl} → ${redirectLocation}`);
      return redirectLocation;
    }
  } catch (cdpErr) {
    logger.error(`CDP resolution failed: ${cdpErr}`);
  } finally {
    if (page && interceptionEnabled) {
      await page.setRequestInterception(false).catch(() => {});
    }
    await client?.detach().catch(() => {});
    // Do not close the reused SO7O WebView page or the browser itself.
    await browser?.disconnect().catch(() => {});
  }
  return redirectedUrl;
}

export function postRedirectedUrlCDP(
  targetUrl: string,
  postData?: string,
  cookies?: CookieData[],
  userAgent?: string,
  formSelector?: string,
  preferMediaSource = false,
) {
  return withCdpPageLock("postRedirectedUrlCDP", () =>
    postRedirectedUrlCDPLocked(targetUrl, postData, cookies, userAgent, formSelector, preferMediaSource),
  );
}

/**
 * Turn on capture network events and get redirected url
 * @param targetUrl
 * @param cookies
 * @param userAgent
 * @returns redirectedUrl
 */
async function getRedirectedUrlCDPLocked(
  targetUrl: string,
  cookies?: CookieData[],
  userAgent?: string,
) {
  let redirectedUrl: string | null = "";
  const browser = await getBrowser();
  let page: Page | undefined;
  let client: Awaited<ReturnType<Page["createCDPSession"]>> | undefined;
  const ownsPage = !ENV.PUPPETEER_CDP_HTTP_URL;
  try {
    if (cookies) browser.setCookie(...cookies);
    if (ownsPage) {
      page = await browser.newPage();
    } else {
      const pages = await browser.pages();
      page = pages[0];
      if (!page) throw new Error("SO7O CDP did not expose an existing WebView page");
    }
    page.setUserAgent({ userAgent: userAgent || ENV.USER_AGENT });
    client = await page.createCDPSession();
    await client.send("Network.enable");
    let redirectLocation: string | undefined;
    const onRequestSent: Handler<any> = (params) => {
      logger.trace(`onRequestSent params ${params.documentURL}`);
      const reqUrl = params.request?.url || "";
      logger.log(`reqUrl ${reqUrl}`);

      if (reqUrl.startsWith("http") && matchesHost(reqUrl, MKVDRAMA_HOST)) {
        try {
          if (new URL(reqUrl).pathname.startsWith("/c/")) {
            redirectLocation = reqUrl;
            redirectedUrl = reqUrl;
            return;
          }
        } catch {
          // Ignore malformed request URLs and continue with normal redirect handling.
        }
      }

      if (
        reqUrl.startsWith("http") &&
        !NOT_FINAL_HOSTS.some((host) => reqUrl.includes(host))
      ) {
        if (!redirectLocation) {
          redirectLocation = reqUrl.split("?__cf_chl")[0];
          if (redirectLocation) redirectedUrl = redirectLocation;
        }
      }
      if (matchesAnyHost(params.documentURL, FINAL_HOSTS)) {
        redirectLocation = params.documentURL;
        return;
      }
    };

    client.on("Network.requestWillBeSent", onRequestSent);
    logger.trace(`on request: ${targetUrl}`);
    try {
      await page.goto(targetUrl, {
        waitUntil: "load",
        timeout: ENV.PUPPETEER_TIMEOUT_MS,
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      handleError(error, logger, `Fail CDP request ${targetUrl}`);
    } finally {
      client.off("Network.requestWillBeSent", onRequestSent);
    }
    logger.trace(`off request: ${targetUrl}`);
    if (redirectLocation) {
      logger.log(`redirected (CDP): ${targetUrl} → ${redirectLocation}`);
      return redirectLocation;
    }
  } catch (cdpErr) {
    logger.error(`CDP resolution failed: ${cdpErr}`);
  } finally {
    await client?.detach().catch(() => {});
    if (page && ownsPage) await page.close().catch(() => {});
    await browser.disconnect().catch(() => {});
  }
  return redirectedUrl ? redirectedUrl : null;
}

export function getRedirectedUrlCDP(
  targetUrl: string,
  cookies?: CookieData[],
  userAgent?: string,
) {
  return withCdpPageLock("getRedirectedUrlCDP", () =>
    getRedirectedUrlCDPLocked(targetUrl, cookies, userAgent),
  );
}

// export async function scrapeWithRemoteBrowser(
//   targetUrl: string,
//   cookies?: CookieData[],
// ) {
//   const browser = await getBrowser();
//   try {
//     if (cookies && cookies.length > 0) browser.setCookie(...cookies);
//     const page: Page = await browser.newPage();
//     logger.log(`broswer cookies ${JSON.stringify(await browser.cookies())}`);
//     page;
//     await page.goto(targetUrl, {
//       waitUntil: "domcontentloaded",
//       timeout: 20000,
//     });
//     logger.log(`page title ${await page.url()}`);
//     // Get your link
//     const rawResult = await page.evaluate(() => {});
//   } finally {
//     // This only closes the TAB, not the whole browser process!
//     await browser.disconnect();
//   }
// }
