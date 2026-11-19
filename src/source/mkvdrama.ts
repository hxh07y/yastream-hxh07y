import {
  CatalogHandlerArgs,
  ContentType,
  MetaDetail,
  MetaPreview,
  MetaVideo,
  Stream,
  Subtitle,
} from "@stremio-addon/sdk";
import * as cheerio from "cheerio";
import { CookieData, Page } from "puppeteer";
import { uuidv7 } from "uuidv7";
import { upsertStream } from "../db/queries.js";
import {
  getMkvdrama,
  upsertMkvdrama as upsertMkvdramas,
} from "../db/query/mkvdrama.js";
import { upsertOuos } from "../db/query/ouo.js";
import { EJob, JOB_STATUS, JOB_TYPE } from "../db/schema/job.js";
import { EOuoInsert } from "../db/schema/ouo.js";
import { Prefix, UserConfig } from "../lib/manifest.js";
import {
  addJob,
  getJob,
  retryJob,
  getJobQueue,
  JobMkvdramaScrape,
  JobMkvdramaStream,
  MkvdramaJobRunner,
} from "../service/job/job.js";
import ProviderService from "../service/provider/provider-service.js";
import StreamService from "../service/resource/stream-service.js";
import { axiosGet } from "../utils/axios.js";
import {
  FlareSolverrResponse,
  getFlareSolverr,
} from "../utils/browser/flaresolverr.js";
import {
  getBrowser,
  getRedirectedUrlCDP,
  withCdpPageLock,
} from "../utils/browser/puppeteer.js";
import { cache, TTL_MS } from "../utils/cache.js";
import { ENV } from "../utils/env.js";
import {
  FILECRYPT_HOST,
  FILECRYPT_ORIGIN,
  MKVDRAMA_HOST,
  MKVDRAMA_ORIGIN,
  VIEWCRATE_HOST,
  VIEWCRATE_ORIGIN,
} from "../utils/constant.js";
import { getOrigin } from "../utils/domain.js";
import { handleError, MkvdramaError, OuoError } from "../utils/error.js";
import { extractTitle } from "../utils/format.js";
import { matchTitle } from "../utils/fuse.js";
import { Quality } from "../utils/info.js";
import { ntfy } from "../utils/notify/ntfy.js";
import { matchesAnyHost, matchesHost } from "../utils/url-validation.js";
import { EpisodeHoster, hosterToStream } from "./hoster/hoster.js";
import { ContentDetail } from "./meta.js";
import { BaseProvider } from "./provider.js";
import { getUrlsFromFilecrypt } from "./web/filecrypt.js";
import { getUrlsFromMkvdrama } from "./web/mkvdrama.js";
import { getOuoId, OUO_HOSTS } from "./web/ouo.js";
import {
  completeOuoVerificationForContent,
  consumeOuoVerificationOpenRequest,
  getOuoVerificationForContent,
  getOrCreateOuoVerification,
  markOuoVerificationRequired,
} from "../utils/ouo-verification.js";
import { getUrlsFromViewcrateDlc } from "./web/viewcrate.js";
interface MkvdramaSeries {
  id: string;
  title: string;
  url: string;
  poster: string;
  type: ContentType;
  country: string;
}
interface MkvdramaSearch {
  url: string;
  title: string;
  mkvdramaId: string;
}

interface MkvdramaDetail {
  title: string;
  description: string;
  thumbnail: string;
  url: string;
}

interface MkvdramaEpisode {
  id: string;
  number: number;
  title: string;
  url: string;
}

const MKVDRAMA_COUNTRY: Record<string, string> = {
  Korean: "south-korea",
  Chinese: "china",
  Japanese: "japan",
  Thai: "thailand",
  Philippine: "philippines",
  Popular: "",
};

export class MkvdramaScraper extends BaseProvider implements MkvdramaJobRunner {
  readonly baseUrl = MKVDRAMA_ORIGIN;
  readonly supportedPrefix: Prefix[] = [
    Prefix.IMDB,
    Prefix.TMDB,
    Prefix.TVDB,
    Prefix.KISSKH,
    Prefix.ONETOUCHTV,
    Prefix.MKVDRAMA,
  ];
  readonly pageSize = 30;
  async searchCatalog(
    args: CatalogHandlerArgs,
    config: UserConfig,
  ): Promise<MetaPreview[]> {
    const { type, extra } = args;
    const search = extra.search;
    if (!search) return [];
    this.logger.log(`Search | ${search}`);
    const url = `${this.baseUrl}/search?q=${search}`;
    const cacheKey = `search:${this.name}:${url}`;
    const cacheResult: MetaPreview[] = cache.get(cacheKey);
    if (cacheResult) return cacheResult;
    const items = await this.getItems(url);
    const catalog: MetaPreview[] = items.map((item) => ({
      id: `${this.name}:${item.id}`,
      type: type || "series",
      name: item.title,
      poster: item.poster,
    }));
    cache.set(cacheKey, catalog, 30 * 60 * 1000);
    return catalog;
  }

  async getCatalog(
    args: CatalogHandlerArgs,
    config: UserConfig,
  ): Promise<MetaPreview[]> {
    const { id, type, extra } = args;
    const cacheKey = `catalog:${this.name}:${id}`;
    const cacheResult: MetaPreview[] = cache.get(cacheKey);
    if (cacheResult) return cacheResult;
    const [prefix, _, country] = id.split(".");
    const skip = extra.skip;
    const page = skip ? Math.ceil(skip / this.pageSize) + 1 : 1;
    const countryName = MKVDRAMA_COUNTRY[country!];
    const url = `${this.baseUrl}/titles?country[]=${countryName}&status=&type=drama&order=latest&page=${page}`;
    const items = await this.getItems(url);
    const catalog: MetaPreview[] = items.map((item) => ({
      id: `mkvdrama:${item.id}`,
      type: type || "series",
      name: item.title,
      poster: item.poster,
    }));
    cache.set(cacheKey, catalog, 60 * 60 * 1000);
    return catalog;
  }

  async getMeta(
    content: ContentDetail,
    type: ContentType,
  ): Promise<MetaDetail | null> {
    const { mkvdramaId } = content;
    if (!mkvdramaId) return null;
    const metaKey = `meta:${this.name}:${mkvdramaId}`;
    const cacheMeta: MetaDetail = cache.get(metaKey);
    if (cacheMeta) return cacheMeta;
    const data = await this.getDetailAndEpisodes(mkvdramaId);
    if (!data) return null;
    const { detail, episodes } = data;
    if (!detail) return null;
    const meta: MetaDetail = {
      ...detail,
      type: "series",
      videos: episodes,
    };
    cache.set(metaKey, meta, 60 * 60 * 1000);
    return meta;
  }

  async getStreams(
    content: ContentDetail,
    config: UserConfig,
  ): Promise<Stream[]> {
    try {
      const { title, type, year, id, season } = content;
      this.logger.log(`Stream | ${title} ${id}`);
      let mkvdramaId = content.mkvdramaId;
      const episode = content.episode ?? 1;
      const configKey = `${config.tbKey}:${config.mfpUrl}:${config.mfpPass}`;
      const streamKey = `streams:${type}:${configKey}:${this.name}:${id}:${season}:${episode}`;
      if (!mkvdramaId) {
        mkvdramaId = (await this.getSearch(title, year, season))?.mkvdramaId;
      }
      if (!mkvdramaId) return [];

      const providerContentId = `${this.name}:${mkvdramaId}`;
      getOrCreateOuoVerification(providerContentId);
      const getCaptchaItem = (): Stream[] => {
        const verification = getOuoVerificationForContent(providerContentId);
        if (verification?.status !== "awaiting_verification") return [];
        const url = verification.ouoUrl
          ? `so7o://focus?url=${encodeURIComponent(verification.ouoUrl)}`
          : "so7o://focus";
        return [{
          name: "🔐 MKVDrama CAPTCHA",
          description: "Manual CAPTCHA required — open SO7O",
          externalUrl: url,
          behaviorHints: {
            notWebReady: true,
            filename: "MKVDrama-OUO-Verification",
          },
        }];
      };

      const cacheStreams: Stream[] = cache.get(streamKey);
      if (cacheStreams) return [...getCaptchaItem(), ...cacheStreams];
      const dbStreams = await StreamService.getDbStreams(
        `${this.name}:${mkvdramaId}`,
        // season ?? 1,
        1,
        episode ?? 1,
        this.displayName,
        config,
      );
      if (dbStreams.length > 0) {
        cache.set(streamKey, dbStreams, TTL_MS.stream);
        return [...getCaptchaItem(), ...dbStreams];
      }

      // Add job
      const jobId = `job:streams:${this.name}:${mkvdramaId}`;
      const job = await getJob(jobId);
      const { total, wait } = await getJobQueue();
      let description = `${total} in queue\nWait about ${wait} minutes`;
      if (job) {
        switch (job.status) {
          case JOB_STATUS.PENDING:
            break;
          case JOB_STATUS.FAILED:
          case JOB_STATUS.DONE:
            // No DB streams were found for the requested episode. A previous
            // run may have been marked done before its writes completed.
            await retryJob({
              id: jobId,
              status: JOB_STATUS.PENDING,
              type: JOB_TYPE.MKVDRAMA_STREAM,
              data: JSON.stringify({ mkvdramaId, content }),
            });
            description = `${total + 1} in queue\nWait about ${wait + 1} minutes`;
            break;
          default:
            break;
        }
      } else {
        await addJob({
          id: jobId,
          status: JOB_STATUS.PENDING,
          type: JOB_TYPE.MKVDRAMA_STREAM,
          data: JSON.stringify({ mkvdramaId, content }),
        });
        description = `${total + 1} in queue\nWait about ${wait + 1} minutes`;
      }
      const streams: Stream[] = getCaptchaItem();
      streams.push({
        name: this.displayName,
        description: description,
        externalUrl: getOrigin(),
        behaviorHints: {
          notWebReady: true,
          filename: `${description}-${this.name}`,
        },
      });
      return streams;
    } catch (error) {
      handleError(error, this.logger, `Fail getStreams ${content.title}`);
      return [];
    }
  }

  async getSearch(
    title: string,
    year: number,
    season?: number,
  ): Promise<MkvdramaSearch | null> {
    const extractedTitle = extractTitle(title);
    const url = new URL("/search", this.baseUrl);
    url.searchParams.set("q", extractedTitle.title);
    this.logger.log(`GET search | ${url.toString()}`);

    // Search directly; do not depend on FlareSolverr for title matching.
    const data = await this._fetchDirect(url.toString());
    if (!data) return null;

    const searches = this.parseSearch(data);
    const match = matchTitle(searches, title, year, season);
    this.logger.log(
      `Search parsed | candidates=${searches.length} | matched=${Boolean(match[0])}`,
    );
    if (!match[0]) return null;
    return match[0];
  }

  async getSubtitles(content: ContentDetail): Promise<Subtitle[]> {
    return [];
  }

  async getItems(url: string): Promise<MkvdramaSeries[]> {
    try {
      this.logger.log(`GET items | ${url}`);
      const data = await this._fetchDirectAndFlareSolverr(url);
      if (!data) return [];
      let content = "";
      if (typeof data == "string") content = data;
      else {
        content = data.solution?.response || content;
      }
      const $ = cheerio.load(content);
      const articles = $("article.bs").toArray();
      const results: MkvdramaSeries[] = articles
        .map((el) => {
          const $el = $(el);
          const a = $el.find("a.tip");
          const img = $el.find("img");
          const rawTitle = a.attr("title") || "";
          const link = a.attr("href") || "";
          const id = link.replace(/^\//, "").replace(/\/$/, "");
          const poster = img.attr("src") || img.attr("data-src") || "";
          const country = $el.find(".country").text().trim();
          const typeText = $el.find(".typez").text().trim();
          return {
            id,
            title: rawTitle,
            url: link,
            poster,
            type: (typeText.toLowerCase().includes("movie")
              ? "movie"
              : "series") as ContentType,
            country,
          };
        })
        .filter((item) => item.title && item.url);
      return results;
    } catch (error) {
      this.logger.error(`getItems failed: ${error}`);
      return [];
    }
  }

  parseSearch(html: string): MkvdramaSearch[] {
    const $ = cheerio.load(html);
    const series: MkvdramaSearch[] = [];
    $("article.bs").each((_, el) => {
      const href = $(el).find('a[itemprop="url"]').attr("href");
      const title = $(el).find("b").text().trim();
      if (href && title) {
        const mkvdramaId = href.replace(/^\//, "").replace(/\/$/, "");
        const url = new URL(href, this.baseUrl).toString();
        series.push({ title, url, mkvdramaId });
      }
    });
    return series;
  }

  async getDetailAndEpisodes(id: string): Promise<{
    detail: MetaDetail;
    episodes: MetaVideo[];
    links: { link: string; quality: string; label: string }[];
    response: FlareSolverrResponse;
    password: string | null;
  } | null> {
    try {
      const url = `${this.baseUrl}/${id}`;
      this.logger.log(`GET detail | ${url}`);
      let response: FlareSolverrResponse | null = null;

      if (ENV.PUPPETEER_CDP_HTTP_URL) {
        // Hold the shared SO7O page lock until the detail HTML and metadata are
        // fully read; otherwise another provider can replace this page mid-scrape.
        const detailResult = await withCdpPageLock("MKVDrama detail scrape", async () => {
          const browser = await getBrowser();
          try {
            const targetHost = new URL(url).hostname;
            const pages = await browser.pages();
            const page = pages.find((candidate) => {
              try {
                return new URL(candidate.url()).hostname === targetHost;
              } catch {
                return false;
              }
            });

            if (!page) {
              this.logger.error(
                "MKVDrama detail page unavailable: no same-origin SO7O tab is open",
              );
              return false;
            }

            const navigationResponse = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            });
            await page
              .waitForSelector("div.soraddlx", { timeout: 20000 })
              .catch(() => null);
            const downloadSectionCount = await page.evaluate(
              () => document.querySelectorAll("div.soraddlx").length,
            );
            this.logger.log(
              `MKVDrama detail DOM ready | downloadSections=${downloadSectionCount} | url=${page.url()}`,
            );

            const html = await page.content();
            const status = navigationResponse?.status() ?? 0;
            if (status < 200 || status >= 400) {
              this.logger.error(
                `MKVDrama detail browser navigation failed | status=${status} | url=${page.url()}`,
              );
              return false;
            }

            const cookies = await page.cookies(url);
            const userAgent = await page.evaluate(() => navigator.userAgent);
            response = {
              status: "ok",
              solution: {
                url: page.url(),
                status,
                response: html,
                cookies,
                userAgent,
              },
            };
            this.logger.log(
              `MKVDrama detail browser navigation succeeded | status=${status} | bytes=${Buffer.byteLength(html)}`,
            );
            return true;
          } finally {
            await browser.disconnect();
          }
        });
        if (!detailResult) return null;
      } else {
        response = await getFlareSolverr(url, this.name, 10);
      }

      const content = response?.solution?.response || "";
      if (!response || !content || content.includes("Loading download")) {
        this.logger.error(`Not found detail from id | ${id}`);
        return null;
      }
      const $ = cheerio.load(content);
      this.logger.log(
        `MKVDrama detail parsing | bytes=${Buffer.byteLength(content)} | title=${$("h1").text().trim()} | time=${JSON.stringify($("time").text())} | qualityBlocks=${$("div.soraddlx").length}`,
      );
      const rawTitle = $("title").text();
      const title =
        $("h1").text().trim() || rawTitle.slice(0, rawTitle.indexOf("at"));
      const description = $(".entry-content p").first().text().trim();
      const thumbnail = $('meta[property="og:image"]').attr("content") || "";
      const time = $("time").text();
      const detail: MetaDetail = {
        id: `${this.name}:${id}`,
        name: title,
        type: "series",
        description: description,
        poster: thumbnail,
        background: thumbnail,
        released: new Date(time).toISOString(),
      };
      const qualityBlocks = $("div.soraddlx").toArray();
      const ouoRedirectLinks: { link: string; quality: string; label: string }[] = [];
      const episodeRanges: {
        minEpisode: number;
        maxEpisode: number;
        links: { link: string; quality: string; label: string }[];
      }[] = [];

      for (const qualityBlock of qualityBlocks) {
        const $qualityBlock = $(qualityBlock);
        const h3Text = $qualityBlock.find("h3").text().trim();
        const titleMatch = h3Text.match(/Episode\s+(\d+)\s*-\s*(\d+)/i);
        const rangeLinks: { link: string; quality: string; label: string }[] = [];

        $qualityBlock.find("div.soraurlx").each((_, linkBlock) => {
          const $linkBlock = $(linkBlock);
          const quality = $linkBlock.find("strong").first().text().trim();
          if (!quality) return;

          $linkBlock.find("a").each((_, anchor) => {
            const $anchor = $(anchor);
            const label = $anchor.text().trim();
            const link = $anchor.attr("href") || "";
            if (!link || !/^Link\s*[12]$/i.test(label)) return;

            const entry = { link, quality, label };
            rangeLinks.push(entry);
            if (!ouoRedirectLinks.some((existing) => existing.link === link)) {
              ouoRedirectLinks.push(entry);
            }
            this.logger.log(
              `MKVDrama download link ${link}, quality ${quality}, ${label}`,
            );
          });
        });

        if (titleMatch) {
          const minEpisode = parseInt(titleMatch[1]!, 10);
          const maxEpisode = parseInt(titleMatch[2]!, 10);
          if (
            Number.isFinite(minEpisode) &&
            Number.isFinite(maxEpisode) &&
            minEpisode > 0 &&
            maxEpisode >= minEpisode
          ) {
            episodeRanges.push({
              minEpisode,
              maxEpisode,
              links: rangeLinks,
            });
          }
        }
      }

      const season = 1;
      const preferredQualities = ["2160p", "1080pHD", "1080p"];
      const episodeByNumber = new Map<number, MetaVideo>();

      for (const range of episodeRanges) {
        const selectedQuality = preferredQualities.find((quality) =>
          range.links.some((link) => link.quality === quality),
        );
        if (!selectedQuality) continue;

        // Keep Link 1 as the episode metadata's primary link. Link 2 is also
        // retained above so the stream job can try it as an alternate mirror.
        const selectedLink = range.links.find(
          (link) => link.quality === selectedQuality,
        )?.link;
        if (!selectedLink) continue;

        for (let ep = range.minEpisode; ep <= range.maxEpisode; ep++) {
          if (episodeByNumber.has(ep)) continue;
          episodeByNumber.set(ep, {
            id: `${this.name}:${selectedLink}:${season}:${ep}`,
            title: `${detail.name} ${selectedQuality}`,
            episode: ep,
            season,
            overview: `${selectedQuality} Download`,
            released: new Date(time).toISOString(),
          });
        }
      }

      const episodes = [...episodeByNumber.values()].sort(
        (a, b) => (a.episode ?? 0) - (b.episode ?? 0),
      );
      this.logger.log(
        `MKVDrama detail extracted | links=${ouoRedirectLinks.length} | episodeRanges=${episodeRanges.length} | episodes=${episodes.length} | qualities=${[...new Set(ouoRedirectLinks.map((link) => link.quality))].join(",")}`,
      );

      // Extract password from admin comment (first moderator comment)
      const password =
        $(".fe-role-badge--moderator")
          .first()
          .closest(".fe-comment-card")
          .find(".fe-comment-text")
          .attr("data-raw-body")
          ?.replace(/\*\*/g, "")
          .trim() || null;

      return {
        detail,
        episodes,
        links: ouoRedirectLinks,
        response: response,
        password: password,
      };
    } catch (error) {
      handleError(error, this.logger, `getDetailAndEpisodes failed`);
      return null;
    }
  }

  async getContentsFromPage(pageUrl: string): Promise<ContentDetail[]> {
    const response = await getFlareSolverr(pageUrl, this.name, 4);
    const content = response?.solution?.response || "";
    if (!response || content.includes("Preparing...")) {
      this.logger.error(`Not found content from page url | ${pageUrl}`);
      throw new MkvdramaError("No content from page url");
    }
    const $ = cheerio.load(content);
    const contents = $("article.bs")
      .toArray()
      .map((el) => {
        const $el = $(el);
        const $a = $el.find("a.tip");
        const href = $a.attr("href") || "";
        const id = href.replace(/^\//, "").replace(/\/$/, "");
        const title =
          $a.attr("title") ||
          $el.find("h2").attr("content") ||
          $el.find("h2").text().trim();
        const country = $el.find(".country").text().trim();
        const type: ContentType = "series";
        const content: ContentDetail = {
          id,
          mkvdramaId: id,
          title,
          type,
          year: new Date().getFullYear(),
        };
        return content;
      });
    this.logger.log(`Page ${pageUrl}: ${contents.length}`);
    return contents;
  }

  async runMkvdramaScrape(job: EJob) {
    const jobData: JobMkvdramaScrape = JSON.parse(job.data);
    const pageUrl = jobData.pageUrl;
    const contents = await this.getContentsFromPage(pageUrl);
    contents.forEach((content) => {
      const jobId = `job:streams:${this.name}:${content.mkvdramaId}`;
      const jobData: JobMkvdramaStream = {
        mkvdramaId: content.id,
        content,
      };
      addJob({
        id: jobId,
        status: JOB_STATUS.PENDING,
        type: JOB_TYPE.MKVDRAMA_STREAM,
        data: JSON.stringify(jobData),
      });
    });
  }

  async runMkvdramaStream(job: EJob) {
    const jobData: JobMkvdramaStream = JSON.parse(job.data);
    const mkvdramaId = jobData.mkvdramaId;
    const content = jobData.content;
    const providerContentId = `${this.name}:${mkvdramaId}`;

    const dbMkvdrama = await this.getDbMkvdrama(providerContentId);
    let ouos: (EOuoInsert & { quality: Quality })[] = [];
    if (dbMkvdrama && dbMkvdrama.length > 0) {
      dbMkvdrama.forEach((mkvdrama) => {
        const ouo = mkvdrama.ouo;
        if (ouo) ouos.push({ ...ouo, quality: mkvdrama.quality as Quality });
      });
      // A single OUO ID must only be processed once, even if legacy rows
      // or joined results contain the same mirror more than once.
      ouos = [...new Map(ouos.map((ouo) => [ouo.id, ouo])).values()];
    }

    if (ouos.length === 0) {
      const data = await this.getDetailAndEpisodes(mkvdramaId);
      if (!data) {
        this.logger.error(
          `MKVDrama stream job | detail extraction returned null | id=${mkvdramaId}`,
        );
        throw new MkvdramaError("Detail extraction returned no data");
      }
      this.logger.log(
        `MKVDrama stream job | detail received | links=${data.links.length} | episodes=${data.episodes.length}`,
      );
      if (data.links.length === 0) {
        this.logger.error(
          `MKVDrama stream job | detail has no download links | id=${mkvdramaId}`,
        );
        throw new MkvdramaError("No download links found");
      }
      const detail = data.detail;
      // Test both 1080p mirrors, sequentially, because the resolver reuses
      // one SO7O tab and concurrent navigations would interfere with each other.
      const selectedLinks = data.links.filter(
        (link) =>
          link.quality === "1080p" && /^Link\s*[12]$/i.test(link.label),
      );
      if (selectedLinks.length === 0) {
        throw new MkvdramaError("1080p Link 1 and Link 2 not found");
      }
      const links: { link: string | null; quality: string }[] = [];
      for (const selectedLink of selectedLinks) {
        const redirectUrl = new URL(selectedLink.link, this.baseUrl).toString();
        try {
          const ouoLink = await this.getMkvdramaRedirectedUrlCDP(redirectUrl);
          this.logger.log(
            `MKVDrama ${selectedLink.quality} ${selectedLink.label} resolved | found=${Boolean(ouoLink)}`,
          );
          links.push({ link: ouoLink, quality: selectedLink.quality });
        } catch (error) {
          this.logger.warn(
            `MKVDrama ${selectedLink.quality} ${selectedLink.label} failed: ${error}`,
          );
          links.push({ link: null, quality: selectedLink.quality });
        }
      }
      // Resolve OUO mirrors sequentially because both use the same SO7O tab.
      const redirects: (EOuoInsert & { quality: Quality })[] = [];
      for (const link of links) {
        const originalUrl = link.link;
        if (!originalUrl) continue;
        let redirectedUrl: string | undefined;
        let id: string | undefined;
        const isOuo = matchesAnyHost(originalUrl, OUO_HOSTS);
        switch (true) {
          case isOuo:
            redirectedUrl = await this.getMkvdramaOuoFinalUrlCDP(originalUrl, providerContentId);
            id = getOuoId(originalUrl);
            break;
          case matchesHost(originalUrl, VIEWCRATE_ORIGIN):
          case matchesHost(originalUrl, FILECRYPT_ORIGIN):
            redirectedUrl = originalUrl;
            id = getOuoId(originalUrl);
            break;
          default:
            redirectedUrl = originalUrl;
            break;
        }
        if (id && redirectedUrl) {
          redirects.push({
            id,
            originalUrl,
            redirectedUrl,
            password: data.password,
            quality: link.quality as Quality,
          });
        }
      }
      // Link 1 and Link 2 can resolve to the same OUO short URL/ID.
      // Keep one record per OUO ID before any database writes.
      ouos = [
        ...new Map(
          redirects.map((redirect) => [redirect.id, redirect]),
        ).values(),
      ];
      // The OUO interaction is finished once at least one valid destination
      // has been resolved, even if the downstream ViewCrate/Filecrypt fetch fails.
      if (ouos.length > 0) completeOuoVerificationForContent(providerContentId);
      if (ouos.length === 0) throw new OuoError("No ouo links found");
      const upsertOuosPromise = upsertOuos(ouos);

      const syncContent = { ...content, title: detail.name };
      if (detail.poster) syncContent.thumbnail = detail.poster;
      await ProviderService.syncContentAndProvider(
        syncContent,
        mkvdramaId,
        this.name,
      );
      await upsertOuosPromise;
      await upsertMkvdramas(
        ouos.map((ouo) => {
          return {
            id: uuidv7(),
            providerContentId: providerContentId,
            ouoId: ouo.id,
            quality: ouo.quality,
            ttl: TTL_MS.stream,
          };
        }),
      );
    }

    const streamRows = await Promise.all(
      ouos.map(async (ouo) => {
        const redirectedUrl = ouo.redirectedUrl;
        if (!redirectedUrl) {
          throw new MkvdramaError("No redirected url");
        }
        let urls = [];
        let episodes: EpisodeHoster[] = [];
        // can have protected content (password required)
        try {
          switch (true) {
            case matchesHost(redirectedUrl, VIEWCRATE_HOST):
              const viewcrate = await getUrlsFromViewcrateDlc(redirectedUrl);
              urls = viewcrate.urls;
              episodes = viewcrate.episodes;
              break;
            case matchesHost(redirectedUrl, FILECRYPT_HOST):
              const filecrypt = await getUrlsFromFilecrypt(redirectedUrl);
              urls = filecrypt.urls;
              episodes = filecrypt.episodes;
              break;
            case matchesHost(redirectedUrl, MKVDRAMA_HOST):
              const mkvdrama = await getUrlsFromMkvdrama(redirectedUrl);
              urls = mkvdrama.urls;
              episodes = mkvdrama.episodes;
              break;
            default:
              urls.push(redirectedUrl);
              break;
          }
        } catch (error) {
          handleError(error, this.logger, `Fail getUrlsFromViewcrateDlc`);
          ntfy(
            "yastream viewcrate/filecrypt failed",
            `${redirectedUrl}`,
            "min",
          );
          throw error;
        }
        const streamRows = hosterToStream(
          urls,
          episodes,
          ouo.quality,
          providerContentId,
          this.name,
          mkvdramaId,
          "1",
        );
        return streamRows;
      }),
    );
    const streams = streamRows.flat().filter((stream) => stream !== undefined);
    if (streams.length === 0) {
      throw new MkvdramaError("No streams extracted from MKVDrama links");
    }
    const streamMap = Object.groupBy(streams, (stream) => stream.episode);
    await Promise.all(
      Object.values(streamMap).map(async (episodeStreams) => {
        if (episodeStreams) await upsertStream(episodeStreams.flat());
      }),
    );
    completeOuoVerificationForContent(providerContentId);
    return;
  }

  private getMkvdramaRedirectedUrlCDP(targetUrl: string): Promise<string | null> {
    return withCdpPageLock("MKVDrama link redirect", () => this.getMkvdramaRedirectedUrlCDPLocked(targetUrl));
  }

  private async getMkvdramaRedirectedUrlCDPLocked(
    targetUrl: string,
  ): Promise<string | null> {
    const browser = await getBrowser();
    let page: Page | undefined;
    let client: Awaited<ReturnType<Page["createCDPSession"]>> | undefined;
    let redirectedUrl: string | null = null;
    let redirectLocation: string | undefined;
    const notFinalHosts = [
      "sl.buisthainan.com",
      "mkvdrama",
      "send",
      "cloudflare",
      "google",
      "gstatic",
      "jsdelivr",
      "turnstile",
    ];

    try {
      // SO7O cannot create targets. Reuse the existing MKVDrama/OUO tab.
      // Link 1 may already have navigated the shared tab to ouo.press.
      const targetHost = new URL(this.baseUrl).hostname;
      const pages = await browser.pages();
      page =
        pages.find((candidate) => {
          try {
            const hostname = new URL(candidate.url()).hostname;
            return hostname === targetHost || OUO_HOSTS.includes(hostname);
          } catch {
            return false;
          }
        }) ||
        pages.find((candidate) => candidate.url() !== "about:blank");
      if (!page) {
        throw new MkvdramaError("No existing MKVDrama/OUO browser tab for redirect");
      }

      client = await page.createCDPSession();
      await client.send("Network.enable");
      const onRequestSent = (params: any) => {
        const requestUrl = params.request?.url || "";
        if (
          requestUrl.startsWith("http") &&
          matchesHost(requestUrl, MKVDRAMA_HOST)
        ) {
          try {
            if (new URL(requestUrl).pathname.startsWith("/c/")) {
              redirectLocation = requestUrl;
              redirectedUrl = requestUrl;
              return;
            }
          } catch {
            // Ignore malformed request URLs.
          }
        }
        if (
          requestUrl.startsWith("http") &&
          !notFinalHosts.some((host) => requestUrl.includes(host)) &&
          !redirectLocation
        ) {
          redirectLocation = requestUrl.split("?__cf_chl")[0];
          redirectedUrl = redirectLocation || null;
        }
        if (matchesAnyHost(params.documentURL || "", OUO_HOSTS)) {
          redirectLocation = params.documentURL;
          redirectedUrl = params.documentURL;
        }
      };

      client.on("Network.requestWillBeSent", onRequestSent);
      try {
        await page.goto(targetUrl, {
          waitUntil: "load",
          timeout: ENV.PUPPETEER_TIMEOUT_MS,
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        this.logger.warn(`MKVDrama Link 2 navigation did not complete: ${error}`);
      } finally {
        client.off("Network.requestWillBeSent", onRequestSent);
      }

      if (!redirectedUrl) {
        const finalUrl = page.url();
        if (
          finalUrl !== targetUrl &&
          !matchesHost(finalUrl, MKVDRAMA_HOST)
        ) {
          redirectedUrl = finalUrl;
        }
      }
      this.logger.log(
        `MKVDrama Link 2 redirect | found=${Boolean(redirectedUrl)} | url=${redirectedUrl || "none"}`,
      );
      return redirectedUrl;
    } finally {
      if (client) await client.detach().catch(() => {});
      // The browser and tab belong to SO7O; only disconnect this CDP client.
      await browser.disconnect();
    }
  }

  private getMkvdramaOuoFinalUrlCDP(
    targetUrl: string,
    providerContentId: string,
  ): Promise<string | undefined> {
    return withCdpPageLock("MKVDrama OUO resolution", () =>
      this.getMkvdramaOuoFinalUrlCDPLocked(targetUrl, providerContentId),
    );
  }

  private async getMkvdramaOuoFinalUrlCDPLocked(
    targetUrl: string,
    providerContentId: string,
  ): Promise<string | undefined> {
    const browser = await getBrowser();
    let page: Page | undefined;
    let verificationId: string | undefined;
    try {
      const pages = await browser.pages();
      // Link 1 may have left the shared tab on ouo.press before Link 2 runs.
      // Reuse that same tab rather than requiring it to remain on MKVDrama.
      page =
        pages.find((candidate) => {
          try {
            const hostname = new URL(candidate.url()).hostname;
            return (
              matchesHost(candidate.url(), MKVDRAMA_HOST) ||
              OUO_HOSTS.includes(hostname)
            );
          } catch {
            return false;
          }
        }) ||
        pages.find((candidate) => candidate.url() !== "about:blank");
      if (!page) {
        throw new MkvdramaError("No existing SO7O browser tab for OUO redirect");
      }

      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: ENV.PUPPETEER_TIMEOUT_MS,
      }).catch((error) => {
        this.logger.warn(`MKVDrama OUO navigation did not complete: ${error}`);
      });

      // Do not expose the Nuvio handoff merely because the URL is OUO.
      // Wait until the page actually displays its human-click instruction.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      let currentUrl = page.url();
      let manualVerificationDetected = false;
      const detectManualTurnstilePrompt = async () => {
        if (!page || page.isClosed() || !matchesAnyHost(page.url(), OUO_HOSTS)) {
          return false;
        }
        return page.evaluate(() => {
          const bodyText = (document.body?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
          return (
            bodyText.includes("please click the captcha box") ||
            bodyText.includes("click the captcha") ||
            bodyText.includes("verify you are a human")
          );
        }).catch(() => false);
      };
      const publishManualVerification = () => {
        if (manualVerificationDetected) return;
        manualVerificationDetected = true;
        markOuoVerificationRequired(providerContentId, currentUrl);
        const verification = getOuoVerificationForContent(providerContentId);
        verificationId = verification?.id;
        if (verification) {
          this.logger.warn(
            `MKVDrama OUO requires manual verification | refresh the episode streams in Nuvio and open the MKVDrama CAPTCHA item | challenge=${verification.id}`,
          );
        } else {
          this.logger.warn(
            "MKVDrama OUO requires manual verification | no active verification session was found",
          );
        }
      };

      if (matchesAnyHost(currentUrl, OUO_HOSTS)) {
        const diagnostics = await page.evaluate(() => ({
          title: document.title,
          url: location.href,
          forms: Array.from(document.forms).map((form) => ({
            id: form.id || "",
            action: form.getAttribute("action") || "",
            method: (form.method || "get").toUpperCase(),
            inputNames: Array.from(form.elements)
              .filter((element): element is HTMLInputElement =>
                element instanceof HTMLInputElement,
              )
              .map((input) => input.name || ""),
            buttons: Array.from(form.querySelectorAll("button, input[type=submit]"))
              .map((button) =>
                (button.textContent || (button as HTMLInputElement).value || "")
                  .trim()
                  .slice(0, 80),
              ),
          })),
          bodyText: (document.body?.innerText || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 500),
        })).catch((error) => ({ inspectionError: String(error) }));
        this.logger.log(
          `MKVDrama OUO page diagnostics | ${JSON.stringify(diagnostics)}`,
        );
        if (await detectManualTurnstilePrompt()) publishManualVerification();
      }

      // Keep polling long enough for the user to cold-start SO7O and complete
      // the manual Turnstile interaction after Nuvio launches the deep link.
      const deadline = Date.now() + 10 * 60 * 1000;
      let submittedAfterVerification = false;
      while (Date.now() < deadline) {
        if (page.isClosed()) {
          const availablePages = await browser.pages();
          page =
            availablePages.find((candidate) => matchesAnyHost(candidate.url(), OUO_HOSTS)) ||
            availablePages.find((candidate) => candidate.url() !== "about:blank") || page;
        }

        if (
          verificationId &&
          consumeOuoVerificationOpenRequest(verificationId)
        ) {
          const availablePages = await browser.pages();
          const currentOuoPage = availablePages.find((candidate) =>
            matchesAnyHost(candidate.url(), OUO_HOSTS),
          );
          if (currentOuoPage) page = currentOuoPage;
          if (page && !page.isClosed()) {
            await page.bringToFront().catch((error) => {
              this.logger.warn(`Unable to bring SO7O verification tab forward: ${error}`);
            });
            await page.evaluate(() => window.focus()).catch(() => {});
          } else {
            this.logger.warn("SO7O has no active OUO browser tab to bring forward");
          }
          this.logger.log("OUO verification tab focus request processed");
        }

        if (!page || page.isClosed()) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        currentUrl = page.url();
        if (
          !manualVerificationDetected &&
          matchesAnyHost(currentUrl, OUO_HOSTS) &&
          await detectManualTurnstilePrompt()
        ) {
          publishManualVerification();
        }
        if (
          (currentUrl.startsWith("http://") || currentUrl.startsWith("https://")) &&
          !matchesAnyHost(currentUrl, OUO_HOSTS)
        ) {
          this.logger.log(`MKVDrama OUO resolved | url=${currentUrl}`);
          return currentUrl;
        }
        if (currentUrl.startsWith("chrome-error://")) {
          this.logger.warn("SO7O OUO tab is showing a browser error; waiting for a valid redirect");
        }

        if (!submittedAfterVerification && matchesAnyHost(currentUrl, OUO_HOSTS)) {
          const captchaReady = await page.evaluate(() => {
            const response = document.querySelector<HTMLInputElement>(
              'input[name="cf-turnstile-response"]',
            );
            return Boolean(response?.value);
          }).catch(() => false);

          if (captchaReady) {
            this.logger.log(
              "MKVDrama OUO CAPTCHA response detected | submitting verified form",
            );
            submittedAfterVerification = true;
            await page.evaluate(() => {
              const form =
                document.querySelector<HTMLFormElement>(
                  "#form-captcha, #form-go, #form-shorten",
                );
              if (form) form.requestSubmit();
            }).catch((error) => {
              this.logger.warn(
                `MKVDrama OUO verified form submission failed: ${error}`,
              );
            });
          }
        }

        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      this.logger.warn(
        `MKVDrama OUO manual verification timed out | url=${page.url()}`,
      );
      return undefined;
    } finally {
      // SO7O owns this browser and tab; never close either.
      await browser.disconnect();
    }
  }

  async getDbMkvdrama(providerContentId: string) {
    return getMkvdrama(providerContentId);
  }

  async getRedirectedUrls(
    urls: string[],
    cookies?: CookieData[],
    userAgent?: string,
  ): Promise<string[] | null> {
    let ouoLink: string | null = "";
    try {
      const redirectedUrls = await Promise.all(
        urls.map(async (url) => {
          ouoLink = await getRedirectedUrlCDP(url, cookies, userAgent);
          return ouoLink;
        }),
      );
      return redirectedUrls.filter((ouoLink) => ouoLink != null);
    } catch (error) {
      handleError(error, this.logger, `Fail getRedirectedUrls`);
      return null;
    }
  }
  /** First get from flaresolverr ~2s, if fail then browser CDP ~4s */
  async getRedirectedUrl(
    url: string,
    cookies?: CookieData[],
    userAgent?: string,
  ): Promise<string | null> {
    let ouoLink: string | null = "";
    try {
      const response = await getFlareSolverr(url, this.name, 1);
      ouoLink = response?.solution?.url || null;
      if (ouoLink) {
        if (matchesAnyHost(ouoLink, OUO_HOSTS)) {
          this.logger.log(`getRedirectedUrl ${url} from flaresolverr`);
          return ouoLink;
        }
      }
      ouoLink = await getRedirectedUrlCDP(url, cookies, userAgent);
      this.logger.log(`getRedirectedUrl ${url} from puppeteer`);
      return ouoLink;
    } catch (error) {
      handleError(error, this.logger, `Fail getRedirectedUrl ${url}`);
      return null;
    }
  }

  async _fetchDirectAndFlareSolverr(
    url: string,
  ): Promise<string | FlareSolverrResponse | null> {
    const response = await this._fetchDirect(url);
    if (response) return response;
    return getFlareSolverr(url, this.name);
  }

  async _fetchDirect(url: string): Promise<string | null> {
    try {
      // axiosGet selects the MKVDrama-specific client with HTML headers.
      const response = await axiosGet<string>(url);
      if (!response) {
        this.logger.warn("Direct fetch returned no response body; see AXIOS diagnostics");
        return null;
      }
      const lower = response.toLowerCase();
      const challengeMarkers = [
        "cf-chl-",
        "challenge-platform",
        "just a moment",
        "checking your browser",
        "verify you are human",
      ];
      const challenge = challengeMarkers.some((marker) =>
        lower.includes(marker),
      );
      const pageTitle =
        response.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
          ?.replace(/<[^>]+>/g, "")
          .trim()
          .slice(0, 100) || "no title";
      this.logger.log(
        `Direct fetch inspected | bytes=${Buffer.byteLength(response)} | challenge=${challenge} | title=${pageTitle}`,
      );
      if (challenge || lower.includes("cloudflare")) {
        // Axios cannot pass MKVDrama's browser verification. Reuse the
        // already verified same-origin SO7O tab and fetch without navigating it.
        return await withCdpPageLock("MKVDrama challenged-page fallback", async () => {
          const browser = await getBrowser();
          try {
            const targetHost = new URL(url).hostname;
            const pages = await browser.pages();
            const page =
              pages.find((candidate) => {
                try {
                  return new URL(candidate.url()).hostname === targetHost;
                } catch {
                  return false;
                }
              }) ||
              pages.find((candidate) => candidate.url() !== "about:blank");

            if (!page) {
              const availableTabs = pages.map((candidate) => candidate.url());
              this.logger.warn(
                `MKVDrama direct fetch was challenged and no reusable SO7O tab is open | tabs=${JSON.stringify(availableTabs)}`,
              );
              return null;
            }

            const navigationResponse = await page.goto(url, {
              waitUntil: "domcontentloaded",
              timeout: 60000,
            });
            await page.waitForSelector("article.bs", { timeout: 15000 }).catch(() => null);

            const browserHtml = await page.content();
            const browserLower = browserHtml.toLowerCase();
            const browserChallenge = challengeMarkers.some((marker) =>
              browserLower.includes(marker),
            );
            const status = navigationResponse?.status() ?? 0;
            const finalUrl = page.url();

            if (status < 200 || status >= 400 || browserChallenge) {
              this.logger.warn(
                `MKVDrama browser navigation did not clear verification | status=${status} | challenge=${browserChallenge} | url=${finalUrl}`,
              );
              return null;
            }

            this.logger.log(
              `MKVDrama browser navigation succeeded | status=${status} | bytes=${Buffer.byteLength(browserHtml)}`,
            );
            return browserHtml;
          } finally {
            await browser.disconnect();
          }
        });
      }
      return response;
    } catch (error) {
      this.logger.warn(`Axios request failed: ${error}`);
    }
    return null;
  }
}
