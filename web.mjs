// Live web access for Hamrin 1.0: search and page reading, scraped from this server.
// Queries leave from the server's address, never the visitor's, and nothing is stored.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT_MS = 12_000;
const MAX_BYTES = 2_500_000;
const MAX_REDIRECTS = 4;
export const PAGE_CHARS = 5000;

// ---------- address safety ----------

function isPrivateV4(address) {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateV4(address);
  if (family === 6) {
    const value = address.toLowerCase();
    if (value === "::" || value === "::1") return true;
    if (value.startsWith("::ffff:")) {
      const tail = value.slice(7);
      return net.isIP(tail) === 4 ? isPrivateV4(tail) : true;
    }
    return value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb") || value.startsWith("ff");
  }
  return true;
}

// Every connection is checked at the moment it resolves, so a host cannot swap to a private address later.
function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const open = (addresses || []).filter((item) => !isPrivateAddress(item.address));
    if (!open.length) return callback(new Error("That address is not reachable from here."));
    if (options && options.all) return callback(null, open);
    return callback(null, open[0].address, open[0].family);
  });
}

function parseTarget(raw) {
  let url;
  try {
    url = new URL(String(raw || "").trim());
  } catch {
    throw new Error("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https pages can be read.");
  if (url.username || url.password) throw new Error("URLs with credentials are not allowed.");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (![80, 443, 8080, 8443].includes(port)) throw new Error("That port is not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("That address is not reachable from here.");
  if (net.isIP(host) && isPrivateAddress(host)) throw new Error("That address is not reachable from here.");
  return url;
}

// ---------- fetching ----------

function once(url, headers) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const request = lib.request(
      url,
      {
        method: "GET",
        lookup: safeLookup,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,text/plain;q=0.7,*/*;q=0.5",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate, br",
          ...headers,
        },
        timeout: TIMEOUT_MS,
      },
      (response) => {
        const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
        let stream = response;
        if (encoding === "gzip") stream = response.pipe(zlib.createGunzip());
        else if (encoding === "deflate") stream = response.pipe(zlib.createInflate());
        else if (encoding === "br") stream = response.pipe(zlib.createBrotliDecompress());
        const chunks = [];
        let size = 0;
        let done = false;
        const finish = (error) => {
          if (done) return;
          done = true;
          if (error) return reject(error);
          resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) });
        };
        stream.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            chunks.push(chunk.subarray(0, Math.max(0, chunk.length - (size - MAX_BYTES))));
            response.destroy();
            finish();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => finish());
        stream.on("error", (error) => finish(error));
        response.on("error", (error) => finish(error));
      },
    );
    request.on("timeout", () => request.destroy(new Error("The site took too long to answer.")));
    request.on("error", reject);
    request.end();
  });
}

async function get(raw, headers = {}) {
  let url = parseTarget(raw);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const result = await once(url, headers);
    if ([301, 302, 303, 307, 308].includes(result.status) && result.headers.location) {
      url = parseTarget(new URL(result.headers.location, url).toString());
      continue;
    }
    return { ...result, url: url.toString() };
  }
  throw new Error("Too many redirects.");
}

function decodeBody(result) {
  const type = String(result.headers["content-type"] || "");
  const charset = /charset=([^;]+)/i.exec(type)?.[1]?.trim().toLowerCase() || /<meta[^>]+charset=["']?([\w-]+)/i.exec(result.body.subarray(0, 4096).toString("latin1"))?.[1]?.toLowerCase() || "utf-8";
  try {
    return new TextDecoder(charset).decode(result.body);
  } catch {
    return result.body.toString("utf8");
  }
}

// ---------- text helpers ----------

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "-", mdash: "-", hellip: "...", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "(c)", middot: "·", bull: "•", laquo: "«", raquo: "»" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (full, body) => {
    if (body[0] === "#") {
      const code = body[1].toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITIES[body.toLowerCase()] ?? full;
  });
}

function cdata(text) {
  return String(text || "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");
}

function plain(html) {
  return decodeEntities(cdata(html).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block);
  return match ? cdata(match[1]) : "";
}

function items(xml) {
  return [...String(xml).matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map((match) => match[1]);
}

function clip(text, length) {
  const value = String(text || "").trim();
  return value.length > length ? value.slice(0, length - 1).trimEnd() + "…" : value;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// ---------- search ----------

function unwrapBing(link) {
  try {
    const url = new URL(decodeEntities(link));
    if (/bing\.com$/i.test(url.hostname)) {
      const inner = url.searchParams.get("url");
      if (inner) return inner;
    }
    return url.toString();
  } catch {
    return decodeEntities(link);
  }
}

async function jget(url) {
  const result = await get(url, { accept: "application/json" });
  if (result.status !== 200) throw new Error(`${hostOf(url)} answered ${result.status}`);
  return JSON.parse(decodeBody(result));
}

// Search engines hand scrapers junk, so web search is assembled from sources that answer honestly.
async function wikipedia(topic) {
  const data = await jget(
    `https://en.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(topic)}&gsrlimit=4&prop=extracts|info&exintro=1&explaintext=1&exchars=260&inprop=url`,
  );
  return Object.values(data.query?.pages || {})
    .sort((a, b) => a.index - b.index)
    .map((page) => ({ title: page.title, url: page.fullurl, snippet: clip(page.extract, 240), source: "Wikipedia" }));
}

async function instantAnswer(topic) {
  const data = await jget(`https://api.duckduckgo.com/?q=${encodeURIComponent(topic)}&format=json&no_html=1&skip_disambig=1`);
  if (!data.AbstractText || !data.AbstractURL) return [];
  return [{ title: data.Heading || topic, url: data.AbstractURL, snippet: clip(data.AbstractText, 260), source: data.AbstractSource || "DuckDuckGo" }];
}

async function stackOverflow(topic) {
  const data = await jget(`https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(topic)}&site=stackoverflow&pagesize=3`);
  return (data.items || []).map((item) => ({
    title: clip(decodeEntities(item.title), 140),
    url: item.link,
    snippet: `${item.is_answered ? "Answered" : "Unanswered"}, score ${item.score}, ${item.answer_count} answers. Tags: ${(item.tags || []).slice(0, 4).join(", ")}`,
    source: "Stack Overflow",
    date: new Date(item.last_activity_date * 1000).toISOString().slice(0, 10),
  }));
}

async function githubRepos(topic) {
  const data = await jget(`https://api.github.com/search/repositories?q=${encodeURIComponent(topic)}&sort=stars&per_page=3`);
  return (data.items || []).map((item) => ({
    title: item.full_name,
    url: item.html_url,
    snippet: clip(`${item.description || "No description"} (${item.stargazers_count} stars)`, 220),
    source: "GitHub",
    date: String(item.pushed_at || "").slice(0, 10),
  }));
}

async function hackerNews(topic) {
  const data = await jget(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(topic)}&tags=story&hitsPerPage=3`);
  return (data.hits || []).map((hit) => ({
    title: clip(hit.title || "", 140),
    url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    snippet: `${hit.points || 0} points, ${hit.num_comments || 0} comments on Hacker News`,
    source: "Hacker News",
    date: String(hit.created_at || "").slice(0, 10),
  }));
}

const COINS = {
  bitcoin: "bitcoin", btc: "bitcoin", ethereum: "ethereum", eth: "ethereum", solana: "solana", sol: "solana", dogecoin: "dogecoin", doge: "dogecoin",
  xrp: "ripple", ripple: "ripple", cardano: "cardano", ada: "cardano", litecoin: "litecoin", ltc: "litecoin", bnb: "binancecoin", polkadot: "polkadot",
  avalanche: "avalanche-2", avax: "avalanche-2", chainlink: "chainlink", tron: "tron", toncoin: "the-open-network", ton: "the-open-network",
};

async function coinPrices(query) {
  if (!/\b(price|worth|how much|trading|usd|value|market)\b/i.test(query)) return "";
  const ids = [...new Set((query.toLowerCase().match(/[a-z]+/g) || []).map((word) => COINS[word]).filter(Boolean))].slice(0, 4);
  if (!ids.length) return "";
  const data = await jget(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(",")}&vs_currencies=usd&include_24hr_change=true`);
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return ids
    .filter((id) => data[id])
    .map((id) => `${id}: $${Number(data[id].usd).toLocaleString("en-US", { maximumFractionDigits: 4 })} (${Number(data[id].usd_24h_change || 0).toFixed(1)}% in 24h), CoinGecko live, ${stamp}`)
    .join("\n");
}

const WMO = { 0: "clear", 1: "mostly clear", 2: "partly cloudy", 3: "overcast", 45: "fog", 48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "rain showers", 81: "rain showers", 82: "violent showers", 95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with hail" };

async function weatherNow(query) {
  const match = /\b(?:weather|temperature|forecast|rain|snow)\b.*?\b(?:in|at|for|near)\s+([a-z][a-z .,'-]{1,50})/i.exec(query) || /^([a-z][a-z .,'-]{1,40})\s+(?:weather|forecast|temperature)\b/i.exec(query);
  if (!match) return "";
  const place = match[1].replace(/\b(today|now|tomorrow|tonight|right now|currently)\b/gi, "").replace(/[?.!]+$/, "").trim();
  if (place.length < 2) return "";
  const geo = await jget(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1`);
  const spot = geo.results?.[0];
  if (!spot) return "";
  const now = await jget(
    `https://api.open-meteo.com/v1/forecast?latitude=${spot.latitude}&longitude=${spot.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=3`,
  );
  const c = now.current || {};
  const d = now.daily || {};
  const days = (d.time || []).map((day, index) => `${day}: ${d.temperature_2m_min?.[index]}-${d.temperature_2m_max?.[index]}°C, rain chance ${d.precipitation_probability_max?.[index] ?? "?"}%`).join("; ");
  return `Weather in ${spot.name}, ${spot.country} (Open-Meteo live, local time ${String(c.time || "").replace("T", " ")}): ${c.temperature_2m}°C, feels like ${c.apparent_temperature}°C, ${WMO[c.weather_code] || "conditions unknown"}, humidity ${c.relative_humidity_2m}%, wind ${c.wind_speed_10m} km/h. Next days: ${days}.`;
}

async function bingNews(query) {
  const result = await get(`https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=en-US&mkt=en-US&cc=US`);
  if (result.status !== 200) throw new Error("News answered " + result.status);
  return items(decodeBody(result)).map((block) => {
    const url = unwrapBing(tag(block, "link"));
    const source = plain(tag(block, "News:Source")) || hostOf(url);
    return {
      title: clip(plain(tag(block, "title")), 140),
      url,
      snippet: clip(plain(tag(block, "description")), 200),
      source,
      date: tag(block, "pubDate") ? new Date(tag(block, "pubDate")).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
    };
  });
}

async function googleNews(query) {
  const result = await get(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`);
  if (result.status !== 200) throw new Error("News answered " + result.status);
  return items(decodeBody(result)).map((block) => {
    const title = plain(tag(block, "title"));
    const source = plain(tag(block, "source"));
    return {
      title: clip(source && title.endsWith(" - " + source) ? title.slice(0, -(source.length + 3)) : title, 140),
      url: "",
      snippet: "(headline only, no link)",
      source,
      date: tag(block, "pubDate") ? new Date(tag(block, "pubDate")).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "",
    };
  });
}

const NEWSY = /\b(news|latest|today|tonight|yesterday|breaking|happening|current|currently|now|live|update|updates|results?|score|scores|election|elections|midterms?|vote|poll|polls|price|prices|stock|stocks|weather|forecast|war|crash|launch|announced|this (week|month|year)|20\d\d)\b/i;

function dedupe(list) {
  const seen = new Set();
  return list.filter((item) => {
    const key = item.url || item.title.toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return !!item.title;
  });
}

// "whats happening in US midterms" searches better as "US midterms".
function keywords(query) {
  const stripped = query
    .replace(/^(please\s+)?(can|could|would) you\s+/i, "")
    .replace(/^(tell me|show me|find|search( the web)?( for)?|look up|google)\s+(about\s+)?/i, "")
    .replace(/^(what('?s| is| are| was)?|whats)\s+(the\s+)?(latest|newest|current|happening|going on|new)(\s+(in|with|on|at|about|for))?\s+/i, "")
    .replace(/^(what('?s| is| are)?|whats|who('?s| is)|how('?s| is))\s+/i, "")
    .trim();
  return stripped.length >= 3 ? stripped : query;
}

export async function webSearch(rawQuery) {
  const query = String(rawQuery || "").replace(/\s+/g, " ").trim().slice(0, 200);
  if (!query) throw new Error("A search query is required.");
  const wantNews = NEWSY.test(query);
  const wantCode = DEV.test(query);
  const topic = keywords(query);
  const none = Promise.resolve([]);

  const [quickCoin, quickWeather, bing, google, instant, wiki, stack, github, hn] = await Promise.allSettled([
    coinPrices(query),
    weatherNow(query),
    wantNews ? bingNews(topic) : none,
    wantNews ? googleNews(topic) : none,
    instantAnswer(topic),
    wikipedia(topic),
    wantCode ? stackOverflow(topic) : none,
    wantCode ? githubRepos(topic) : none,
    wantCode ? hackerNews(topic) : none,
  ]);
  const ok = (settled) => (settled.status === "fulfilled" ? settled.value : []);

  const quick = [quickCoin, quickWeather].map((settled) => (settled.status === "fulfilled" ? settled.value : "")).filter(Boolean);
  const news = dedupe([...ok(bing), ...ok(google)]).slice(0, 6);
  const tokens = relevanceTokens(topic);
  const results = dedupe([...ok(instant), ...ok(wiki), ...ok(stack), ...ok(github), ...ok(hn)])
    .filter((item) => item.source === "Stack Overflow" || relevant(item, tokens))
    .slice(0, 9);

  if (!quick.length && !results.length && !news.length) {
    throw new Error("Nothing came back for that search. Rephrase it with different keywords, or read a page directly with fetch_url if you know where the answer lives.");
  }
  return { query: topic, today: new Date().toISOString().slice(0, 10), quick, news, results };
}

const DEV = /\b(api|sdk|npm|pip|python|javascript|typescript|node(\.js)?|react|vue|svelte|next\.?js|css|html|sql|rust|golang|java|kotlin|swift|docker|kubernetes|git|github|linux|bash|regex|error|exception|bug|library|framework|package|compile|function|hook|hooks|docs?|documentation|tutorial|how (do|to|can)|solidity|web3|code|script|server)\b/i;

const STOP = new Set(["the", "and", "for", "with", "what", "how", "are", "was", "who", "when", "where", "why", "this", "that", "from", "about", "latest", "news", "today", "now", "current", "price", "docs", "doc", "documentation"]);

function relevanceTokens(topic) {
  return [...new Set((topic.toLowerCase().match(/[a-z0-9.#+]{3,}/g) || []).filter((word) => !STOP.has(word)))];
}

function relevant(item, tokens) {
  if (!tokens.length) return true;
  const hay = `${item.title} ${item.snippet}`.toLowerCase();
  return tokens.some((word) => hay.includes(word));
}

// ---------- reading a page ----------

const DROP = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "form", "select", "button", "nav", "footer", "aside", "header", "figure", "dialog"];

function mainBlock(html) {
  for (const name of ["article", "main"]) {
    const match = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i").exec(html);
    if (match && plain(match[1]).length > 600) return match[1];
  }
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html);
  return body ? body[1] : html;
}

function htmlToText(html) {
  let text = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const name of DROP) text = text.replace(new RegExp(`<${name}\\b[^>]*>[\\s\\S]*?</${name}>`, "gi"), " ");
  text = text
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level) => "\n\n" + "#".repeat(Math.min(3, Number(level))) + " ")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|tr|table|ul|ol|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<(p|div|section|tr|table|ul|ol|blockquote|pre)\b[^>]*>/gi, "\n")
    .replace(/<td\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/^(?:[-|•*]\s*)+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageLinks(html, base) {
  const out = [];
  const seen = new Set();
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = plain(match[2]);
    if (label.length < 12 || label.length > 120) continue;
    let url;
    try {
      url = new URL(decodeEntities(match[1]), base);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol)) continue;
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label: clip(label, 90), url: key });
    if (out.length >= 12) break;
  }
  return out;
}

export async function webFetch(rawUrl, offset = 0) {
  const result = await get(rawUrl);
  const type = String(result.headers["content-type"] || "").toLowerCase();
  if (result.status >= 400) throw new Error(`The site answered ${result.status}. Try another source.`);
  if (/^(image|video|audio)\//.test(type) || /pdf|zip|octet-stream/.test(type)) throw new Error("That is not a readable page (" + (type.split(";")[0] || "binary") + ").");

  const raw = decodeBody(result);
  let title = "";
  let text = "";
  let links = [];
  if (/html|xhtml/.test(type) || /^\s*<(!doctype|html)/i.test(raw)) {
    title = plain(tag(raw, "title"));
    const meta = /<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([^"']*)["']/i.exec(raw);
    const body = htmlToText(mainBlock(raw));
    text = (meta && !body.includes(meta[1].slice(0, 40)) ? plain(meta[1]) + "\n\n" : "") + body;
    links = pageLinks(raw, result.url);
  } else if (/json/.test(type)) {
    try {
      text = JSON.stringify(JSON.parse(raw), null, 1);
    } catch {
      text = raw;
    }
  } else if (/xml|rss|atom/.test(type)) {
    const found = items(raw);
    text = found.length
      ? found.slice(0, 25).map((block) => `- ${plain(tag(block, "title"))} (${plain(tag(block, "link"))}) ${clip(plain(tag(block, "description")), 160)}`).join("\n")
      : plain(raw);
  } else {
    text = raw;
  }
  text = text.trim();
  if (text.length < 80) throw new Error("That page has no readable text (it likely needs JavaScript). Try another source.");
  const start = Math.max(0, Math.min(Number(offset) || 0, text.length));
  const slice = text.slice(start, start + PAGE_CHARS);
  const end = start + slice.length;
  return {
    url: result.url,
    title: clip(title, 160),
    text: slice,
    offset: start,
    next: end < text.length ? end : null,
    total: text.length,
    links: start === 0 ? links : [],
    fetchedAt: new Date().toISOString(),
  };
}
