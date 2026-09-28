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

module.exports = { searchNaver, fetchArticleText };
