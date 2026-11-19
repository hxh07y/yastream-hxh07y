import * as cheerio from "cheerio";
import * as crypto from "crypto";
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
    try {
      const pages = await browser.pages();
      // SO7O exposes its existing WebView rather than allowing new targets.
      // Reuse it even when the current page is not already on Viewcrate.
      const page = pages.find((candidate) => candidate.url() !== "about:blank") || pages[0];
      if (!page) {
        throw new ViewcrateError("SO7O does not expose an existing WebView page");
      }

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
        fields: $(form).find("input").map((__, input) => ({
          name: $(input).attr("name") || "",
          type: $(input).attr("type") || "text",
        })).get(),
      })).get();
      if (status >= 400 || !hasDlcSection) {
        logger.warn(
          `Viewcrate DOM diagnostic | url=${page.url()} | body=${pageText.slice(0, 450)} | forms=${JSON.stringify(formSummary)} | mainDivs=${$("main > div").length}`,
        );
        throw new ViewcrateError(
          `Viewcrate page did not render in SO7O | status=${status} | title=${$("title").text().trim()}`,
        );
      }

      logger.log(
        `Viewcrate browser page ready | status=${status} | bytes=${Buffer.byteLength(html)} | episodeHosters=${sectionHosters} | documentHosters=${documentHosters} | protectedText=${pageText.toLowerCase().includes("protected content")} | passwordProvided=${Boolean(password)} | forms=${formSummary.length} | sectionPreview=${sectionPreview} | sectionChildren=${JSON.stringify(sectionChildren)}`,
      );
      return html;
    } finally {
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
