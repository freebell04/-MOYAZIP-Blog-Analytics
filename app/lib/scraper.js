// 네이버 통합검색에서 뉴스/블로그 결과를 Playwright로 직접 크롤링
// Playwright는 크고(불러오는 데 0.2초) 켤 때는 필요 없어서, 처음 쓰는 순간에 불러온다
const chromium = new Proxy({}, { get: (_, k) => { const c = require("playwright").chromium; const v = c[k]; return typeof v === "function" ? v.bind(c) : v; } });

/**
 * @param {string} keyword
 * @returns {Promise<{news: Array, blogs: Array}>}
 */
async function searchNaver(keyword) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`https://search.naver.com/search.naver?query=${encodeURIComponent(keyword)}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1500);

  // 네이버 검색결과 디자인(SDS 컴포넌트) 공용 파싱:
  // 결과 카드는 종류(뉴스/블로그/카페/지식iN)와 무관하게
  // 링크 안에 headline1 텍스트 + 인근에 body1/body2 스니펫이 들어있는 구조를 공유한다.
  const items = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll("a").forEach((a) => {
      const href = a.href || "";
      const headline = a.querySelector(".sds-comps-text-type-headline1");
      if (!headline) return;

      // 스니펫 후보를 모으면서 상위로 탐색 (레이아웃 깊이가 케이스마다 달라서).
      // 작성자 닉네임 같은 짧은 텍스트가 섞여 들어오므로, 가장 긴 텍스트를 실제 설명문으로 채택.
      let snippet = "";
      let node = a.parentElement;
      for (let depth = 0; depth < 6 && node; depth++) {
        const bodyEls = node.querySelectorAll(".sds-comps-text-type-body1, .sds-comps-text-type-body2");
        for (const el of bodyEls) {
          const parentA = el.closest("a");
          if (!parentA || parentA === a) {
            const t = el.textContent.trim();
            if (t.length > snippet.length) snippet = t;
          }
        }
        if (snippet.length > 30) break; // 충분히 긴 설명문을 찾으면 더 안 올라감
        node = node.parentElement;
      }
      out.push({ href, title: headline.textContent.trim(), snippet });
    });
    return out;
  });

  const news = [];
  const blogs = [];
  for (const item of items) {
    if (!item.title || !item.href) continue;
    if (item.href.includes("blog.naver.com")) {
      blogs.push({ title: item.title, link: item.href, snippet: item.snippet });
    } else if (!item.href.includes("naver.com")) {
      // 네이버 외부(언론사) 도메인 = 뉴스 기사로 취급
      news.push({ title: item.title, link: item.href, snippet: item.snippet });
    }
  }

  await browser.close();

  // 중복 제거 + 상위 10개만
  const dedupe = (arr) => {
    const seen = new Set();
    return arr.filter((x) => {
      if (seen.has(x.link)) return false;
      seen.add(x.link);
      return true;
    });
  };

  return {
    news: dedupe(news).slice(0, 10),
    blogs: dedupe(blogs).slice(0, 10),
  };
}


// ---------------------------------------------------------------------------
// 글감 묶음 검색: 인기글 / 나무위키(근거) / 후기·리뷰 / 뉴스 로 나눠서 돌려준다.
// round가 올라갈수록(🔄 다시 찾기) 다음 페이지·다른 검색어로 넘어가고, exclude(이미 보여준 링크)는 뺀다.
// ---------------------------------------------------------------------------
const REVIEW_WORDS = ["후기", "리뷰", "내돈내산", "솔직후기", "사용기", "방문후기"];
const GROUP_SIZE = 6;

const PARSE_CARDS = () => {
  const out = [];
  document.querySelectorAll("a").forEach((a) => {
    const headline = a.querySelector(".sds-comps-text-type-headline1");
    if (!headline) return;
    let snippet = "";
    let node = a.parentElement;
    for (let depth = 0; depth < 6 && node; depth++) {
      for (const el of node.querySelectorAll(".sds-comps-text-type-body1, .sds-comps-text-type-body2")) {
        const parentA = el.closest("a");
        if (!parentA || parentA === a) {
          const t = el.textContent.trim();
          if (t.length > snippet.length) snippet = t;
        }
      }
      if (snippet.length > 30) break;
      node = node.parentElement;
    }
    out.push({ href: a.href || "", title: headline.textContent.trim(), snippet });
  });
  return out;
};

const enc = encodeURIComponent;
const blogTabUrl = (q, start, latest) =>
  `https://search.naver.com/search.naver?ssc=tab.blog.all&sm=tab_opt&query=${enc(q)}&start=${start}` + (latest ? "&nso=so%3Add%2Cp%3Aall" : "");

const FAST_UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "accept-language": "ko-KR,ko;q=0.9" };
const htmlDecode = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d));
const htmlText = (s) => htmlDecode(String(s || "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/** 검색 결과 HTML에서 카드를 읽는다 (브라우저 없이): [{href, title, snippet}] */
function parseCardsHtml(html) {
  const out = [];
  const re = /<a\s[^>]*?href="([^"]+)"[^>]*>\s*<span[^>]*sds-comps-text-type-headline1[^>]*>([\s\S]*?)<\/span>/g;
  let m;
  while ((m = re.exec(html))) {
    const tail = html.slice(re.lastIndex, re.lastIndex + 3000);
    const sm = tail.match(/<a\s[^>]*(?:fds-ugc-ellipsis\d|sds-comps-text-type-body\d)[^>]*>([\s\S]*?)<\/a>/);
    out.push({ href: htmlDecode(m[1]), title: htmlText(m[2]), snippet: sm ? htmlText(sm[1]) : "" });
  }
  return out;
}

const cardCache = new Map(); // 주소 → {at, cards}: 같은 화면을 45초 안에 또 읽지 않는다 (Enter를 연달아 눌러도 가볍게)

// 네이버는 짧은 시간에 요청이 많이 몰리면 (일반 요청을) 403으로 막고, 한 번 막히면 8초쯤 지나야 풀린다.
// 막힌 뒤에 다시 시도해도 소용이 없어서, 아예 막히지 않게 5초에 10개까지만 보내고 넘치면 잠깐 기다린다. (실제로 막히는 한계는 4~5초에 12개쯤)
const PACE_MAX = 10;
const PACE_WINDOW_MS = 5000;
const recentFast = [];
let blockedUntil = 0;
async function pace() {
  for (;;) {
    const now = Date.now();
    while (recentFast.length && now - recentFast[0] > PACE_WINDOW_MS) recentFast.shift();
    if (recentFast.length < PACE_MAX) { recentFast.push(now); return; }
    await new Promise((res) => setTimeout(res, recentFast[0] + PACE_WINDOW_MS - now + 20));
  }
}

/** 일반 요청(fetch)으로 검색 결과를 읽는다 (0.2~0.7초). 그래도 막히면(403) 빈 배열 → 호출한 쪽이 브라우저로 읽는다 */
async function fastCards(url, retry = true) {
  const hit = cardCache.get(url);
  if (hit && Date.now() - hit.at < 45000) return hit.cards;
  if (Date.now() < blockedUntil) return []; // 방금 막힌 직후엔 시도하지 않고 바로 브라우저로
  await pace();
  try {
    const r = await fetch(url, { headers: FAST_UA, signal: AbortSignal.timeout(8000) });
    if (r.status === 403) { blockedUntil = Date.now() + 8000; return []; }
    if (r.status === 429 || r.status >= 500) {
      if (!retry) return [];
      await new Promise((res) => setTimeout(res, 700));
      return fastCards(url, false);
    }
    if (!r.ok) return [];
    const cards = parseCardsHtml(await r.text());
    if (cards.length) cardCache.set(url, { at: Date.now(), cards });
    return cards;
  } catch {
    return [];
  }
}

// 빠른 읽기가 안 될 때만 쓰는 브라우저 (처음 필요한 순간에 한 번만 켠다)
let fallback = null;
let fallbackChain = Promise.resolve();
async function browserCards(url) {
  const run = async () => {
    fallback ||= (async () => {
      const browser = await chromium.launch({ headless: true });
      return { browser, page: await browser.newPage() };
    })();
    const { page } = await fallback;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
      await page.waitForTimeout(1200);
      return await page.evaluate(PARSE_CARDS);
    } catch {
      return [];
    }
  };
  const p = fallbackChain.then(run, run); // 브라우저는 하나라서 순서대로
  fallbackChain = p.catch(() => {});
  return p;
}
async function closeFallback() {
  const f = fallback;
  fallback = null;
  if (f) await f.then((x) => x.browser.close()).catch(() => {});
}

/** 한 검색 화면의 카드들: 빠른 읽기 → 안 되면 브라우저 */
async function cardsFor(url) {
  const fast = await fastCards(url);
  return fast.length ? fast : browserCards(url);
}

/** 여러 검색 화면을 동시에(최대 3개) 읽어서 {주소: 카드들}로 돌려준다 */
async function fetchCardsMany(urls) {
  const unique = [...new Set(urls)];
  const result = new Map();
  let next = 0;
  const worker = async () => {
    while (next < unique.length) {
      const u = unique[next++];
      result.set(u, await cardsFor(u));
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, unique.length) }, worker)); // 네이버가 막지 않게 3개씩
  return result;
}

/** @returns {Promise<{popular, namu, review, news, round, exhausted}>} */
/**
 * 이웃 글 제목 등에서 "이 주제를 구체적으로 만드는 단어"를 뽑아 검색어를 보강한다.
 * 예) 키워드 '맛집' + 이웃 글 제목들 → '맛집 성수 브런치'  (그냥 '맛집'보다 글감이 구체적으로 나온다)
 */
function enrichKeyword(keyword, titles = []) {
  const { keywordsOf } = require("./trends");
  const base = new Set(String(keyword).split(/\s+/).map((w) => w.toLowerCase()));
  const count = new Map();
  for (const t of titles) for (const w of keywordsOf(t)) {
    if (base.has(w.toLowerCase()) || String(keyword).includes(w)) continue;
    count.set(w, (count.get(w) || 0) + 1);
  }
  // 여러 글에 공통으로 나오는 단어만 (한 글에만 나오는 '통장어탕' 같은 말은 검색을 너무 좁힌다).
  // 없으면 첫 번째 제목(= 아이디어 제목)의 핵심어 하나만 붙인다.
  let top = [...count.entries()].filter((e) => e[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);
  if (!top.length && titles[0]) top = [...count.keys()].filter((w) => keywordsOf(titles[0]).includes(w)).slice(0, 1);
  return top.length ? `${keyword} ${top.join(" ")}` : keyword;
}

async function searchGrouped(keyword, round = 0, exclude = [], hints = {}) {
  const seen = new Set(exclude);
  const take = (items, ok, n = GROUP_SIZE) => {
    const out = [];
    for (const it of items) {
      if (!it.title || !it.href || !ok(it.href) || seen.has(it.href)) continue;
      seen.add(it.href);
      out.push({ title: it.title, link: it.href, snippet: it.snippet });
      if (out.length >= n) break;
    }
    return out;
  };
  const isBlog = (h) => /^https?:\/\/(m\.)?blog\.naver\.com\//.test(h);
  const isNamu = (h) => /^https?:\/\/(www\.)?namu\.wiki\//.test(h);
  const isNews = (h) => !/naver\.com|namu\.wiki/.test(h);

  try {
    const words = keyword.split(/\s+/).filter((w) => w.length >= 2);

    // (이웃 글 같은 참고 제목이 있으면 거기서 뽑은 단어를 붙인 보강 검색어를 먼저 쓰고, 모자라면 원래 키워드로 채운다)
    const refTitles = Array.isArray(hints.titles) ? hints.titles.slice(0, 8).map(String) : [];
    const rich = refTitles.length ? enrichKeyword(keyword, refTitles) : keyword;
    const w = REVIEW_WORDS[round % REVIEW_WORDS.length];
    const reviewPage = 1 + 10 * Math.floor(round / REVIEW_WORDS.length);
    const namuQueries = [keyword, ...words.filter((x) => x !== keyword)].slice(0, 3);
    const namuUrl = (q) => `https://search.naver.com/search.naver?query=${enc(q + " 나무위키")}`;
    const urls = {
      popRich: rich !== keyword ? blogTabUrl(rich, 1 + 10 * round, false) : null,
      popBase: blogTabUrl(keyword, 1 + 10 * round, false),
      popLatest: blogTabUrl(keyword, 1 + 10 * round, true),
      review: blogTabUrl(`${rich} ${w}`, reviewPage, false),
      reviewFallback: blogTabUrl(`${keyword} 리뷰`, 1 + 10 * round, true),
      news: `https://search.naver.com/search.naver?ssc=tab.news.all&query=${enc(keyword)}&sort=1&start=${1 + 10 * round}`,
    };
    // 꼭 필요한 화면만 먼저 동시에 읽고, 글이 모자랄 때만 추가로 읽는다 (많이 읽으면 네이버가 막는다)
    const pages = new Map();
    const load = async (list) => {
      const r = await fetchCardsMany(list.filter((u) => u && !pages.has(u)));
      for (const [u, c] of r) pages.set(u, c);
    };
    const cards = (u) => (u && pages.get(u)) || [];
    await load([urls.popRich || urls.popBase, urls.popRich ? urls.popBase : null, namuUrl(namuQueries[0]), urls.review, urls.news]);

    // 인기글: 관련도순 블로그 탭. 다시 찾을 때마다 다음 페이지. 새 글이 모자라면 최신순으로 채운다.
    let popular = [];
    if (urls.popRich) popular = take(cards(urls.popRich), isBlog);
    if (popular.length < GROUP_SIZE) popular = popular.concat(take(cards(urls.popBase), isBlog, GROUP_SIZE - popular.length));
    if (popular.length < GROUP_SIZE) {
      await load([urls.popLatest]);
      popular = popular.concat(take(cards(urls.popLatest), isBlog, GROUP_SIZE - popular.length));
    }

    // 나무위키: "키워드 나무위키" 검색에서 namu.wiki 문서만. 모자라면 검색어를 단어별로 바꿔가며 문서를 더 모은다.
    let namu = [];
    for (const q of namuQueries) {
      await load([namuUrl(q)]);
      namu = namu.concat(take(cards(namuUrl(q)), isNamu));
      if (namu.length >= 4) break;
    }

    // 후기·리뷰: 후기/리뷰/내돈내산... 단어를 번갈아 붙여 블로그 탭 검색
    let review = take(cards(urls.review), isBlog);
    if (review.length < GROUP_SIZE) {
      await load([urls.reviewFallback]);
      review = review.concat(take(cards(urls.reviewFallback), isBlog, GROUP_SIZE - review.length));
    }
    // 제목에 후기·리뷰 말이 들어간 글을 위로
    const isReviewy = (x) => /후기|리뷰|내돈내산|사용기|써보|해보/.test(x.title);
    review.sort((a, b) => Number(isReviewy(b)) - Number(isReviewy(a)));

    // 뉴스: 최신순 뉴스 탭
    // (검색 화면 옆의 관련 없는 기사가 섞이므로, 제목·요약에 검색어 단어가 들어간 것만 남긴다)
    const rel = (it) => (words.length ? words : [keyword]).some((k) => (it.title + " " + (it.snippet || "")).includes(k));
    const news = take(cards(urls.news).filter(rel), isNews, 5);

    return { popular, namu, review, news, round, richKeyword: rich, exhausted: !popular.length && !namu.length && !review.length && !news.length, namuSearchUrl: `https://namu.wiki/Search?q=${enc(keyword)}` };
  } finally {
    await closeFallback();
  }
}

/** 네이버 블로그는 모바일 주소로, 그 밖의 글은 <article>/<body>에서 본문 글자만 뽑는다 (브라우저 없이) */
async function fastArticleText(url) {
  const blog = String(url).match(/blog\.naver\.com\/(?:PostView\.naver\?(?:[^#]*&)?blogId=([\w-]+)&(?:[^#]*&)?logNo=(\d+)|([\w-]+)\/(\d{6,}))/);
  if (blog) {
    const id = blog[1] || blog[3];
    const no = blog[2] || blog[4];
    const r = await fetch(`https://m.blog.naver.com/PostView.naver?blogId=${id}&logNo=${no}`, { headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" }, signal: AbortSignal.timeout(10000) });
    const html = await r.text();
    const i = html.indexOf("se-main-container");
    if (i < 0) return "";
    const body = html.slice(i).split(/<div class="(?:post_footer|se_tag|comment)/)[0];
    return htmlDecode(
      body
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
        .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, "\n")
        .replace(/<[^>]+>/g, "")
    )
      .replace(/^se-main-container">/, "")
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n");
  }
  const r = await fetch(url, { headers: FAST_UA, redirect: "follow", signal: AbortSignal.timeout(10000) });
  if (!r.ok || !/text\/html/.test(r.headers.get("content-type") || "")) return "";
  const html = (await r.text()).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/g, "");
  const art = html.match(/<article[\s\S]*?<\/article>/i);
  return htmlDecode((art ? art[0] : html).replace(/<(br|\/p|\/div|\/h\d|\/li)[^>]*>/gi, "\n").replace(/<[^>]+>/g, ""))
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * 후보 글 링크의 본문을 가져온다 (뉴스/블로그 공용, 대략적인 텍스트 추출).
 */
async function fetchArticleText(url) {
  // 먼저 일반 요청으로 본문을 읽어본다 (브라우저를 켜지 않아 0.3~1초). 너무 짧거나 못 읽으면 예전처럼 브라우저로 읽는다.
  const quick = await fastArticleText(url).catch(() => "");
  if (quick && quick.length >= 200) return quick.slice(0, 4000);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(500);

    // 네이버 블로그는 본문이 iframe(mainFrame) 안에 있음
    const frame = page.frames().find((f) => f.name() === "mainFrame") || page.mainFrame();
    const text = await frame
      .evaluate(() => {
        const el =
          document.querySelector(".se-main-container") || // 스마트에디터원
          document.querySelector("#postViewArea") || // 구 에디터
          document.querySelector("article") ||
          document.body;
        return el ? el.innerText : "";
      })
      .catch(() => "");

    return text.trim().slice(0, 4000);
  } finally {
    await browser.close();
  }
}

module.exports = { searchNaver, searchGrouped, enrichKeyword, fetchArticleText, parseCardsHtml, fastCards, blogTabUrl, fastArticleText };
