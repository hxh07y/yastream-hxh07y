import * as crypto from "crypto";
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import {
  getDlcUrl,
  getEpisodeHosters,
  getUrlsFromViewcrate,
  getUrlsFromViewcrateDlc,
  parseJkAndCryptedFromHtml,
} from "./viewcrate.js";

describe("Viewcrate Hoster", () => {
  it("get viewcrate urls", async () => {
    const url = "https://viewcrate.cc/c/eb3622fb78bca7ffa70c9af05e7ad4cd";
    const urls = await getUrlsFromViewcrate(url);
    console.log("urls", urls);
    console.log("length", urls.length);
    expect(urls).not.toBeNull();
  }, 30000);
  it("get viewcrate urls dlc", async () => {
    const url = "https://viewcrate.cc/c/41b7f685f3023a9512a87131b6a32337"
    // const url = "https://viewcrate.cc/c/3f2df7200516abfa874b69802665a6ef";
    // const url = "https://viewcrate.cc/c/37493600688a32dccc61253f2ec1392b"
    // const url = "https://viewcrate.cc/c/eb3622fb78bca7ffa70c9af05e7ad4cd";
    // const url = "https://viewcrate.cc/c/e0eebd57da6e265d55771fe51d5ffab0";
    // const url = "https://viewcrate.cc/c/b1d961fdb62630b581009b285427530d"
    const { urls, episodes } = await getUrlsFromViewcrateDlc(url);
    console.log("urls", urls);
    console.log("urls length", urls.length);
    console.log("episodes", episodes);
    expect(urls).not.toBeNull();
  }, 10000);

  it.skip("decrypt", async () => {
    const response = `<html>

<head>
    <meta name="color-scheme" content="light dark">
    <meta charset="utf-8">
</head>

<body>
    <pre>{"crypted":"MfQR3yzdUBaa/ppjUnvLBnIYxs0gxrWYAvde+MLy4ipFcDnYfDiNzBWrmRrUk8HZQE9y7AUytKX+qd6z/vnLsb0NeKGJ557lyr83QuXTaqo+41xMgQWFMuqUj6oSffO5RYvj98swbNzWg27/8A5FgWndHNA09SqRBiQYTj7f9hqJnqaFtqGMWd9HxzciAHw36LgOUd8mZVNhNUV/o9/FAeNd1RtlfZWm5boAfAO/83BAXj/RXLVxGfBogttpcl7/S8FlJadSOyiaPE+XRCdQu3O+aKW/7Lzj2tP0DtXn5OYz/xaM1mg1Qa2iXaMjiPFcABEYRxpPT8KwjHIdd34DjCof/BdUt1iL/AEpbo/5YWWcMtmThayvfCuHfOuNWzw5Y9nr2DNnMfVdkiyazZWEXnCYX50uDnjHf8AO0On1ogGPYlChBk2KqTijf8ZtF8k3jR9f/P62dgsPNTEiWnd9rtf4SN9X9iWh5Ijlknf33fCTx+xi4C9X4IAQtTKeZHNWvpIWNMmguL+AYjZSDaOVfuY8qI69ho8IpcG+tnauL/35S0ei7AsU/1qBPU7bjwggodzJFiLH7mSPRZfehufJMUN9ZaXDo7mTcR+IHZrmn4TkL2wVUUCRUDMA4kbPFLtGdwG6n2xvZm04TXKG7krL5L6nGXBtnxPyHiXu0pKrrtG97/qX7zE2ZhJU7leV80LydrRjcTquSD8NaX/JwFwy4ekanTnWc8gesQEu+HN3nps6gNT9sNlkyZh0CDk/QR/pSMkVQ3356Wuovd+6Btl/0fZ4+UHrI12k55aqfWakvnGbUzUYz/Q/KdAOZRpUUZoYBlA4NovJulBBs34w2eRDfmqcB8YUbBwdZ0jIVW3sGHwDeDk8u3ZEVgalEEbn7Fl4czlpvBNYxds94CBg6zYG2dOEXsogT5Yofn08bMmfiUFvs6l8OZvUsxQvx+nF/qRFK29laqbxAPqGeqi9QhEnT1IUCVRUtfLljQACDqnQoKY=","jk":"function f(){ return 'c94304ee9e39313ae97c5ed6f390b6dd'; }","package":"Perfect Crown S01 1080p WEB-DL DSNP"}</pre>
    <div class="json-formatter-container"></div>
</body>

</html>`;
    const { crypted, jk } = parseJkAndCryptedFromHtml(response);
    console.log("crypted", crypted);
    console.log("jk", jk);
    const key = Buffer.from(jk, "hex");
    const encrypted = Buffer.from(crypted, "base64");
    const decipher = crypto.createDecipheriv(
      "aes-128-cbc",
      key,
      Buffer.alloc(16, 0),
    );
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    const text = decrypted.toString("utf8");
    const links = text.match(/https?:\/\/[^\s"'<>]+/g) || [];
    console.log("links", links);
  }, 15000);

  it("maps rendered hoster badges to their containing episodes", () => {
    const html = fs.readFileSync("./src/source/web/viewcrate2.html", "utf8");
    const episodes = getEpisodeHosters(html);

    expect(episodes).toHaveLength(11);
    expect(episodes.map(({ ep }) => ep)).toEqual(
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
    expect(
      episodes.reduce((total, episode) => total + episode.data.length, 0),
    ).toBe(33);

    const hosterCounts = episodes
      .flatMap(({ data }) => data)
      .reduce<Record<string, number>>((counts, { hoster }) => {
        counts[hoster] = (counts[hoster] || 0) + 1;
        return counts;
      }, {});

    expect(hosterCounts).toEqual({
      pixeldrain: 11,
      gofile: 11,
      send: 11,
    });
    expect(
      episodes.every((episode) =>
        episode.data.every(({ size }) => Number(size) > 0),
      ),
    ).toBe(true);
  });

  it("get dlc url", async () => {
    const html = fs.readFileSync("./src/source/web/viewcrate2.html", "utf8");
    const dlcUrl = await getDlcUrl(html);
    console.log("dlcUrl", dlcUrl);
    return dlcUrl;
  });

  it("decrypt", async () => {
    const crypto = require("crypto");

    const crypted =
      "cDALeHifWb9PpQgQeR42P5zyjH2PjuNz90L3KRasT4C03+KFQGt/O+4n6Uh3RpyGXt130Y9aQw2IA4T87ovoLzL1mLUrGswYdBagoNhe1WprsUBEKp2lcaz5VprbW7YylxXPTjHU4suqVHpsbC8hF8FkvysDf2580V3xaPQxs9lqC07XgbAXX8bVT25M+T+tj4s484xKF5Jk2O5rlaRSiweeCiwT2ZV3osQPa3ozQ6PGV3hYHd2HOaLV0JxTmd5l+DUzhkbJsehWYbbkfcErGDlVNS9DpolcWWx3TTvp2+IAU2k9F4UFeIqPrufCvb6IJxLcBz80h14s1v+1G4omdPm//2p4gjmZStglIzEwQuww+dJfeJpPDVcyq/FpNgk3u9cmrlafaUH99Ry0Zic5qVhCyKkm5YAG3EQ+hLvhGKIE9EJ9OxAkTF0tzF2jqKGbnKbTq5F3/5ljtt33VTS4uZUel+4jSKRXCrdZhFYii1grPBg42s5lyNO2IEHcPWhHVY7RsVFRbhRhpV8PxL7ls08mQy89MZMTHxFvAH15+Q4BKJdg8M8VxkKetPajVbexCvb1DQv6ChAwJL5A6zHwk+LXgYoyN3Xt/eq8LBV8jj7djJa/2WiEMCA5WsrCTx/EmHXcMOmVy6JpXjdH56lIoP7/O4zBg74C7TweiCQQpItfgyDqzG8GR4gUjvIZ+3M7xgv8fltrDuw9ndac5QT58DTMwZMUEL77ixR6VLpv1nLvYd/bBzlArvTux218WvJ9WutfK8ZuJSHoDtsunz0lRClRAjcZcrqDoLzuizPJT6mYJ+lZpVz2dJX2RF5bZa7CgXIodaQDHUTd2iToiKppStttOVw3LWCC8p0qooqP5NQc0XXikdCwd3/OXvy/1PhYdO41QYiD0ANOElTQAGP4mZZVwLGY8F+ikGnMnfVGySOZjINnQf0nP5CImdZl13nSSxZNzDnOhvxwgaNNpNH8zpQmbo2uenrafcZ7bKQY4yE0zA89A8Jw1+Ke3r9mR2KanbjL1yNvQVGSCXhuN0C/1Q+jvdO9Vpudhp28JE8gR5U9WIpeSMbWhI5irQ/ctVKiuEUe/yRBE4S4l3Duui59YDFNO93UTTIikRemd2Ud8eVvvXf3HBIJS1Gv+EapLHmJ/xHcW44o8XdByj9f7foi4lISkWbVI9T7jkpOSsSbxH8EHY8ZerYgC+IIUQj9yAQLhYklSv+bECnbMJNIDqtgJJO/ot1GpD7T/AKibeJkDwQ=";
    const jk = "ed6422cc3f481a6e8cd8b0297736f3c1";

    const key = Buffer.from(jk, "hex");
    const combined = Buffer.from(crypted, "base64");

    // 1. Slice the last 16 bytes for the true IV
    // const iv = combined.subarray(0, 8);
    const iv = crypto.createHash("md5").update(key).digest();
    const encrypted = combined.subarray(16);
    // const iv = combined.subarray(combined.length - 16);
    // 2. Take everything else up to that point as the encrypted payload
    // const encrypted = combined.subarray(0, combined.length - 16);

    const decipher = crypto.createDecipheriv("aes-128-cbc", key, iv);
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    const text = decrypted.toString("utf8");
    console.log(text);
  });
});
