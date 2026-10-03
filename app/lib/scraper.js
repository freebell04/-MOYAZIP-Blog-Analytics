// 네이버 통합검색에서 뉴스/블로그 결과를 Playwright로 직접 크롤링
const { chromium } = require("playwright");

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

async function pageCards(page, url) {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForTimeout(1200);
    return await page.evaluate(PARSE_CARDS);
  } catch {
    return [];
  }
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

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const words = keyword.split(/\s+/).filter((w) => w.length >= 2);

    // 인기글: 관련도순 블로그 탭. 다시 찾을 때마다 다음 페이지. 새 글이 모자라면 최신순으로 채운다.
    // (이웃 글 같은 참고 제목이 있으면 거기서 뽑은 단어를 붙인 보강 검색어를 먼저 쓰고, 모자라면 원래 키워드로 채운다)
    const refTitles = Array.isArray(hints.titles) ? hints.titles.slice(0, 8).map(String) : [];
    const rich = refTitles.length ? enrichKeyword(keyword, refTitles) : keyword;
    let popular = [];
    if (rich !== keyword) popular = take(await pageCards(page, blogTabUrl(rich, 1 + 10 * round, false)), isBlog);
    if (popular.length < GROUP_SIZE) popular = popular.concat(take(await pageCards(page, blogTabUrl(keyword, 1 + 10 * round, false)), isBlog, GROUP_SIZE - popular.length));
    if (popular.length < GROUP_SIZE) popular = popular.concat(take(await pageCards(page, blogTabUrl(keyword, 1 + 10 * round, true)), isBlog, GROUP_SIZE - popular.length));

    // 나무위키: "키워드 나무위키" 검색에서 namu.wiki 문서만. 검색어를 단어별로도 바꿔가며 문서를 더 모은다.
    const namuQueries = [keyword, ...words.filter((w) => w !== keyword)];
    let namu = [];
    for (const q of namuQueries) {
      namu = namu.concat(take(await pageCards(page, `https://search.naver.com/search.naver?query=${enc(q + " 나무위키")}`), isNamu));
      if (namu.length >= 4) break;
    }

    // 후기·리뷰: 후기/리뷰/내돈내산... 단어를 번갈아 붙여 블로그 탭 검색
    const w = REVIEW_WORDS[round % REVIEW_WORDS.length];
    const reviewPage = 1 + 10 * Math.floor(round / REVIEW_WORDS.length);
    let review = take(await pageCards(page, blogTabUrl(`${rich} ${w}`, reviewPage, false)), isBlog);
    if (review.length < GROUP_SIZE) review = review.concat(take(await pageCards(page, blogTabUrl(`${keyword} 리뷰`, 1 + 10 * round, true)), isBlog, GROUP_SIZE - review.length));
    // 제목에 후기·리뷰 말이 들어간 글을 위로
    const isReviewy = (x) => /후기|리뷰|내돈내산|사용기|써보|해보/.test(x.title);
    review.sort((a, b) => Number(isReviewy(b)) - Number(isReviewy(a)));

    // 뉴스: 최신순 뉴스 탭
    // (검색 화면 옆의 관련 없는 기사가 섞이므로, 제목·요약에 검색어 단어가 들어간 것만 남긴다)
    const rel = (it) => (words.length ? words : [keyword]).some((k) => (it.title + " " + (it.snippet || "")).includes(k));
    const newsCards = (await pageCards(page, `https://search.naver.com/search.naver?ssc=tab.news.all&query=${enc(keyword)}&sort=1&start=${1 + 10 * round}`)).filter(rel);
    const news = take(newsCards, isNews, 5);

    return { popular, namu, review, news, round, richKeyword: rich, exhausted: !popular.length && !namu.length && !review.length && !news.length, namuSearchUrl: `https://namu.wiki/Search?q=${enc(keyword)}` };
  } finally {
    await browser.close();
  }
}

/**
 * 후보 글 링크의 본문을 가져온다 (뉴스/블로그 공용, 대략적인 텍스트 추출).
 */
async function fetchArticleText(url) {
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

module.exports = { searchNaver, searchGrouped, enrichKeyword, fetchArticleText };
