import { UserConfig } from "../../lib/manifest.js";
import { postRedirectedUrlCDP } from "../../utils/browser/puppeteer.js";
import { cleanUrl } from "../../utils/format.js";
import { getMediaflowproxyTranscodeUrl } from "../../utils/mediaflowproxy.js";
import { matchesAnyHost } from "../../utils/url-validation.js";
import { Logger } from "../../utils/logger.js";

const logger = new Logger("SEND");

export const SEND_HOSTS = ["send.cm", "send.now"];
export const SEND_ORIGINS = SEND_HOSTS.map((host) => `https://${host}`);
export const SEND_ORIGIN = SEND_ORIGINS[0] || "https://send.now";
export function filterSendUrls(urls: string[]) {
  return urls
    .filter((url) =>
      matchesAnyHost(
        url,
        SEND_ORIGINS.map((url) => new URL(url).hostname),
      ),
    )
    .map((url) => cleanUrl(url));
}

export async function getSendDownloadUrl(url: string, config: UserConfig) {
  // https://send.now/y52ejnt1f6bb -> https://dl9750.usercdn.com/d/nryutd7t6cosj4l4kzru5thb27ghmr27e5n53y7cu4kzpeo7vu3b56f6qv4ha7pdf3scxdy4/The.Scarecrow.S01E02.1080p.TVING.WEB-DL.AAC2.0.H.264-Marco.mkv
  const id = new URL(url).pathname.split("/").filter(Boolean).pop();
  if (!id) {
    logger.error(`Unable to resolve Send download: missing file ID in ${url}`);
    return "";
  }

  // Load the actual share page and submit its current form fields.
  // Send.now changes these fields over time, so avoid hardcoding an outdated POST body.
  logger.log(`Resolving Send share | host=${new URL(url).hostname} | mfpConfigured=${Boolean(config.mfpUrl)}`);
  const streamUrl = await postRedirectedUrlCDP(
    url,
    undefined,
    undefined,
    undefined,
    "form",
    true,
  );
  if (!streamUrl) {
    logger.error(`Send resolver returned no media URL | fileId=${id}`);
    return "";
  }

  let sourceHost = "unknown";
  try {
    sourceHost = new URL(streamUrl).hostname;
  } catch {
    logger.error("Send resolver returned a malformed media URL");
    return "";
  }
  logger.log(`Send media URL resolved | sourceHost=${sourceHost}`);

  const playbackUrl = getMediaflowproxyTranscodeUrl(streamUrl, config);
  try {
    const output = new URL(playbackUrl);
    logger.log(`Send playback URL generated | host=${output.hostname} | path=${output.pathname} | mfp=${Boolean(config.mfpUrl)}`);
  } catch {
    logger.error("Send playback URL generation returned an invalid URL");
    return "";
  }
  return playbackUrl;
}

// Not working
//   const response = await getFlareSolverr(url, "send");
//   const html = response?.solution?.response;
//   if (!html) return null;
//   const $ = cheerio.load(html);
//   const form = $("form[name='F1']");
//   const op = form.children('input[name="op"]').attr("value");
//   const sendId = form.children('input[name="id"]').attr("value");
//   const referer = form.children('input[name="referer"]').attr("value");
//   const cfTurnstileResponse = form
//     .children('input[name="cf-turnstile-response"]')
//     .attr("value");
//   const download = form.children('input[name="download_a"]').attr("value");
//   const postData = `op=${op}&id=${sendId}&rand=&referer=${referer || url}&download_a=${download}`;
//   console.log("postData", postData);

// Get cookies
//   const payload: RequestPayload = {
//     cmd: "request.post",
//     url: `${SEND_ORIGIN}/`,
//     session: "send",
//     maxTimeout: 20000,
//     waitInSeconds: 0,
//     postData,
//   };
//   const postResponse = await sendFlareSolverr(payload);
//   //   console.log("postResponse", JSON.stringify(postResponse));
//   const postHtml = postResponse?.solution?.response;
//   if (!postHtml) return null;
//   const $post = cheerio.load(postHtml);
//   const postForm = $post("form[name='F1']");
//   const postOp = postForm.children('input[name="op"]').attr("value");
//   const postSendId = postForm.children('input[name="id"]').attr("value");
//   const postReferer = postForm.children('input[name="referer"]').attr("value");
//   const postCfTurnstileResponse = postForm
//     .children('input[name="cf-turnstile-response"]')
//     .attr("value");
//   const postData2 = `op=${postOp}&id=${postSendId}&rand=&referer=${postReferer || url}&cf-turnstile-response=${postCfTurnstileResponse}&download_a=${download}`;
//   console.log("postData2", postData2);
//   const payload2: RequestPayload = {
//     cmd: "request.post",
//     url: `${SEND_ORIGIN}/`,
//     session: "send",
//     maxTimeout: 20000,
//     waitInSeconds: 0,
//     postData: postData2,
//   };
//   const postResponse2 = await sendFlareSolverr(payload2);
//   console.log("postResponse2", JSON.stringify(postResponse2));
