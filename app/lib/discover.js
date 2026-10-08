// 이웃추가 탭의 "🔎 새 이웃 찾기": 내 주제로 최근 글을 쓴 블로거를 네이버 블로그 검색에서 찾는다.
// (이미 내가 추가한 이웃·내 블로그는 뺀다. 이웃 신청은 사용자가 직접 한다)
const { fastCards, blogTabUrl } = require("./scraper");
const { keywordsOf } = require("./trends");

const idOf = (href) => {
  const m = String(href || "").match(/blog\.naver\.com\/([\w-]+)\/(\d+)/) || String(href || "").match(/blogId=([\w-]+).*logNo=(\d+)/);
  return m ? { blogId: m[1], logNo: m[2] } : null;
};

async function nicknameOf(blogId) {
  try {
    const r = await fetch(`https://rss.blog.naver.com/${blogId}.xml`, { signal: AbortSignal.timeout(3000) });
    const t = await r.text();
    const m = t.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
    return m ? m[1].trim() : "";
  } catch {
    return "";
  }
}

/** 내 최근 글 제목들에서 가장 많이 나온 단어 몇 개 (검색어 추천용) */
function suggestKeywords(myTitles) {
  const count = {};
  for (const t of myTitles) for (const k of new Set(keywordsOf(t))) count[k] = (count[k] || 0) + 1;
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
}

/**
 * @param keyword 검색어
 * @param exclude 빼야 할 블로그 아이디 (내 블로그, 이미 추가한 이웃)
 */
async function discover(keyword, exclude = []) {
  const skip = new Set(exclude.map((x) => String(x).toLowerCase()));
  const pages = await Promise.all([blogTabUrl(keyword, 1, true), blogTabUrl(keyword, 31, true), blogTabUrl(keyword, 1, false)].map((u) => fastCards(u)));
  const out = [];
  const seen = new Set();
  for (const c of pages.flat()) {
    const id = idOf(c.href);
    if (!id || seen.has(id.blogId.toLowerCase()) || skip.has(id.blogId.toLowerCase())) continue;
    seen.add(id.blogId.toLowerCase());
    out.push({ blogId: id.blogId, logNo: id.logNo, title: c.title, snippet: c.snippet.replace(/\s*새 창 열림\s*$/, "").slice(0, 120), link: `https://m.blog.naver.com/${id.blogId}/${id.logNo}` });
    if (out.length >= 20) break;
  }
  const names = await Promise.all(out.map((x) => nicknameOf(x.blogId)));
  out.forEach((x, i) => (x.nickname = names[i] || x.blogId));
  return out;
}

module.exports = { discover, suggestKeywords };
