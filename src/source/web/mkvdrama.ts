import * as cheerio from "cheerio";
import { axiosGet } from "../../utils/axios.js";
import { getFlareSolverr } from "../../utils/browser/flaresolverr.js";
import { getBrowser } from "../../utils/browser/puppeteer.js";
import { ENV } from "../../utils/env.js";
import { MKVDRAMA_ORIGIN } from "../../utils/constant.js";
import { MkvdramaError } from "../../utils/error.js";
import { EpisodeHoster, getHosterFromUrl, Hoster } from "../hoster/hoster.js";
import { getUrlsFromDecryptit } from "./decryptit.js";

export async function getUrlsFromMkvdrama(url: string) {
  // Dynamic MKVDrama host lists are rendered in the already verified SO7O tab.
  if (ENV.PUPPETEER_CDP_HTTP_URL || ENV.PUPPETEER_WS_ENDPOINT) {
    return getUrlsFromMkvdramaCDP(url);
  }

  // Keep the legacy FlareSolverr/DLC route for existing deployments.
  const response = await getFlareSolverr(url, "mkvdrama", 0);
  const html = response?.solution?.response;
  if (!html) throw new MkvdramaError("No html");
  const episodes = getEpisodeHostersFromMkvdrama(html);
  const link = await getDlcUrl(html);
  if (!link) throw new MkvdramaError("No dlc link");
  const dlcUrl = new URL(link, MKVDRAMA_ORIGIN).toString();
  const dlc = await axiosGet<string>(dlcUrl);
  if (!dlc) throw new MkvdramaError("No dlc content");
  const urls = await getUrlsFromDecryptit(dlc);
  return { urls, episodes };
}

async function getUrlsFromMkvdramaCDP(url: string) {
  const target = new URL(url);
  const browser = await getBrowser();

  try {
    const pages = await browser.pages();
    let page = pages.find((candidate) => {
      try {
        const current = new URL(candidate.url());
        return current.hostname === target.hostname && current.pathname === target.pathname;
      } catch {
        return false;
      }
    });

    if (!page) {
      throw new MkvdramaError(
        "MKVDrama host-list tab not found. Open the host-list link in SO7O, complete its human verification manually, wait for GET LINK, then retry.",
      );
    }

    const result = await page.evaluate(() => {
      const records: {
        episode: string;
        host: string;
        size: string;
        url: string;
      }[] = [];
      const originalDescriptor = Object.getOwnPropertyDescriptor(window, "open");
      const captured: string[] = [];

      Object.defineProperty(window, "open", {
        configurable: true,
        writable: true,
        value: (destination: string | URL) => {
          captured.push(String(destination));
          return null;
        },
      });

      try {
        document.querySelectorAll<HTMLLIElement>("li[data-i]").forEach((item) => {
          const button = item.querySelector<HTMLButtonElement>(".dl-btn");
          if (!button) return;

          const before = captured.length;
          button.click();
          const destination = captured.length > before ? captured[captured.length - 1] : "";
          if (!destination) return;

          records.push({
            episode: item.dataset.e || "",
            host: item.dataset.h || "",
            size: item.querySelector(".badge-size")?.textContent?.trim() || "",
            url: destination,
          });
        });
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(window, "open", originalDescriptor);
        } else {
          Reflect.deleteProperty(window, "open");
        }
      }

      return { itemCount: document.querySelectorAll("li[data-i]").length, records };
    });

    if (!result.itemCount) {
      throw new MkvdramaError(
        "The MKVDrama host-list page has no link records. Make sure GET LINK is enabled in the SO7O tab, then retry.",
      );
    }

    const urls: string[] = [];
    const episodes: EpisodeHoster[] = [];

    for (const record of result.records) {
      const episodeMatch = record.episode.match(/E(\d+)/i);
      const ep = episodeMatch ? Number.parseInt(episodeMatch[1] || "", 10) : Number.NaN;
      if (!Number.isFinite(ep)) continue;

      const hoster = getHosterFromUrl(record.url);
      if (!hoster) continue;

      const sizeMatch = record.size.match(/[\d.]+/);
      const rawSize = sizeMatch ? Number.parseFloat(sizeMatch[0]) : Number.NaN;
      const size = Number.isFinite(rawSize)
        ? record.size.toUpperCase().includes("MB")
          ? (rawSize / 1024).toFixed(2)
          : rawSize.toFixed(2)
        : "";

      urls.push(record.url);
      episodes.push({ ep, data: [{ hoster, size }] });
    }

    if (!urls.length) {
      throw new MkvdramaError(
        "No supported host links were captured. Currently supported: Send.now/Send.cm, Pixeldrain, Gofile, and Fileditch Files.",
      );
    }

    return { urls, episodes };
  } finally {
    // The browser belongs to SO7O; disconnect without closing it or its tabs.
    await browser.disconnect();
  }
}

function getDlcUrl(html: string): string | undefined {
  const $ = cheerio.load(html);
  const link = $("a.btn-dlc").attr("href");
  if (!link) throw new MkvdramaError("No DLC link");
  return new URL(link, MKVDRAMA_ORIGIN).toString();
}

function getEpisodeHostersFromMkvdrama(html: string) {
  const $ = cheerio.load(html);
  const episodes: EpisodeHoster[] = [];
  const $episodes = $("ul.link-list").children();
  $episodes.each((_, el) => {
    const $el = $(el);
    const seasonEpisodeStr = $el.attr("data-e") || "";
    const host = $el.attr("data-h") || "";
    const hoster = getHosterFromUrl(host);
    const sizeText = $el.find(".badge-size").text().trim() || "";
    let size = "";
    if (sizeText.includes("GB")) {
      size = sizeText.replace(/GB/, "").trim();
    } else if (sizeText.includes("MB")) {
      size = (parseFloat(sizeText.replace(/MB/, "").trim()) / 1024).toFixed(2);
    }
    if (!seasonEpisodeStr) return;
    const ep = parseInt(seasonEpisodeStr.replace(/.*E/, ""));
    if (isNaN(ep)) return;
    const data: { hoster: Hoster; size: string }[] = [];
    if (hoster) data.push({ size, hoster });
    episodes.push({ ep, data });
  });
  return episodes;
}
