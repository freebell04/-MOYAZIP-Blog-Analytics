// "이 주제로 글감 찾기": 추천 주제가 실제로 잘 나오는 검색어를 먼저 찾는다.
//  - 후보: 키워드 + 아이디어 제목의 핵심어 + 이웃 글 제목의 공통어, 그리고 각 후보의 네이버 자동완성(사람들이 실제로 치는 검색어)
//  - 점수: 그 검색어로 블로그를 찾았을 때 상위 글 제목에 주제 단어가 얼마나 들어가는지(적합도) + 자동완성에 있는 검색어인지(수요)
const { keywordsOf } = require("./trends");

const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "accept-language": "ko-KR,ko;q=0.9" };
const norm = (s) => String(s || "").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");

async function suggest(q) {
  try {
    const u = `https://ac.search.naver.com/nx/ac?q=${encodeURIComponent(q)}&con=1&frm=nv&ans=2&r_format=json&r_enc=UTF-8&r_unicode=0&t_koreng=1&run=2&rev=4&q_enc=UTF-8&st=100`;
    const j = await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(4000) })).json();
    return ((j.items && j.items[0]) || []).map((x) => String(x[0] || "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const titleCache = new Map(); // 같은 검색어를 짧은 시간에 다시 찾지 않게
async function blogTitles(q, retry = true) {
  const hit = titleCache.get(q);
  if (hit && Date.now() - hit.at < 10 * 60000) return hit.titles;
  try {
    const html = await (await fetch(`https://search.naver.com/search.naver?ssc=tab.blog.all&query=${encodeURIComponent(q)}`, { headers: UA, signal: AbortSignal.timeout(6000) })).text();
    const titles = [...html.matchAll(/sds-comps-text-type-headline1[^>]*>([\s\S]*?)<\/span>/g)]
      .map((m) => m[1].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').trim())
      .filter(Boolean)
      .slice(0, 15);
    if (!titles.length && retry) {
      // 짧은 시간에 많이 요청하면 가끔 비어 오는 응답이 와서, 잠깐 쉬었다가 한 번 더 시도한다
      await new Promise((r) => setTimeout(r, 1200));
      return blogTitles(q, false);
    }
    if (titles.length) titleCache.set(q, { at: Date.now(), titles });
    return titles;
  } catch {
    return [];
  }
}

/**
 * @param {{keyword:string,title?:string,refs?:{title:string}[]}} idea
 * @returns {Promise<{query:string, candidates:{q:string,fit:number,demand:boolean}[], reason:string}>}
 */
async function bestQuery(idea) {
  const keyword = String(idea.keyword || "").trim();
  const rawTitle = String(idea.title || "");
  // '"클로드 유튜브 요약 방법" 딱 맞춘 글'처럼 따옴표로 감싼 핵심어가 있으면 그 안쪽만 쓴다 (딱 맞춘 글 같은 장식어 제외)
  const title = (rawTitle.match(/["“'‘「『]([^"”'’」』]{2,})["”'’」』]/) || [])[1] || rawTitle;
  const refTitles = (idea.refs || []).map((r) => String(r.title || "")).slice(0, 8);
  if (!keyword) return { query: "", candidates: [], reason: "" };

  const kwWords = keywordsOf(keyword).length ? keywordsOf(keyword) : [keyword];
  const FLUFF = new Set(["시즌", "글", "주제", "추천", "방법", "후속편", "시리즈", "맞춘"]); // 제목 장식어는 검색어에 넣지 않는다
  const titleWords = keywordsOf(title).filter((w) => !norm(keyword).includes(norm(w)) && !FLUFF.has(w));
  const angle = titleWords[0] || ""; // 예) 'AI로 맛집·여행 코스…' → AI
  // 이웃 글에서 두 번 이상 나오는 단어 (구체적인 소재)
  const cnt = new Map();
  for (const t of refTitles) for (const w of keywordsOf(t)) if (!norm(keyword).includes(norm(w))) cnt.set(w, (cnt.get(w) || 0) + 1);
  const common = [...cnt.entries()].filter((e) => e[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);

  const topicBits = titleWords.slice(0, 3);
  const seeds = [
    ...new Set(
      [
        keyword,
        angle && `${angle} ${keyword}`,
        topicBits.length >= 1 && `${keyword} ${topicBits.slice(0, 2).join(" ")}`,
        topicBits.length >= 2 && topicBits.join(" "),
        common.length && `${keyword} ${common.join(" ")}`,
      ].filter(Boolean)
    ),
  ];

  // 후보 = 씨앗 + 각 씨앗의 자동완성
  const sugg = await Promise.all(seeds.map(suggest));
  const cands = new Map(); // 정규화한 검색어 → {q, demand, rank, seed}
  const add = (q, isDemand, rank, isSeed) => {
    q = q.replace(/\s+/g, " ").trim();
    if (!q || q.split(" ").length > 6) return;
    const k = norm(q);
    const cur = cands.get(k);
    if (!cur) cands.set(k, { q, demand: isDemand, rank, isSeed });
    else {
      if (isDemand && !cur.demand) Object.assign(cur, { demand: true, rank });
      if (isSeed) cur.isSeed = true;
    }
  };
  seeds.forEach((s) => add(s, false, 99, true));
  sugg.forEach((list) => list.slice(0, 5).forEach((q, i) => add(q, true, i, false)));

  // 너무 동떨어진 후보는 거른다: 주제 단어를 하나도 안 담은 것, 그리고 내 관점(예: AI)이 있으면 그걸 담은 것 위주로
  const topicWords = [...new Set([...kwWords, ...topicBits])].map(norm);
  let pool = [...cands.values()].filter((c) => kwWords.some((w) => norm(c.q).includes(norm(w))) || topicWords.filter((w) => norm(c.q).includes(w)).length >= 2);
  if (angle && pool.some((c) => norm(c.q).includes(norm(angle)))) pool = pool.filter((c) => norm(c.q).includes(norm(angle)));
  pool = pool.slice(0, 6); // 검색 요청을 너무 많이 보내지 않게

  // 적합도: 그 검색어로 찾은 상위 블로그 글 중, 이 아이디어의 주제 단어를 절반 이상 담은 글이 몇 개인지
  const need = Math.max(1, Math.min(3, Math.ceil(topicWords.length * 0.5)));
  const scoreOne = async (c) => {
    {
      const titles = (await blogTitles(c.q)).map(norm);
      const onTopic = titles.filter((t) => topicWords.filter((w) => t.includes(w)).length >= need).length;
      let score = onTopic * 2 + (c.demand ? 4 - Math.min(3, c.rank) * 0.5 : 0);
      if (angle && norm(c.q).includes(norm(angle))) score += 3; // 내 관점(예: AI)이 들어간 검색어를 우대
      if (c.isSeed) score += 1; // 검색 결과를 못 읽었을 때를 대비해 씨앗 검색어를 살짝 우대
      score -= Math.max(0, c.q.split(" ").length - 4) * 2; // 너무 길면 감점
      return { q: c.q, fit: onTopic, demand: c.demand, titles: titles.length, score };
    }
  };
  const scored = [];
  for (let i = 0; i < pool.length; i += 5) scored.push(...(await Promise.all(pool.slice(i, i + 5).map(scoreOne)))); // 한꺼번에 너무 많이 요청하지 않게 5개씩
  scored.sort((a, b) => b.score - a.score);
  const noSignal = scored.length && scored.every((x) => x.fit === 0 && !x.demand); // 검색 결과를 못 읽었거나 근거가 없을 때
  const simple = scored.filter((x) => x.q.split(" ").length <= 2).sort((a, b) => b.score - a.score)[0];
  const best = (noSignal && simple) || scored[0] || { q: keyword, fit: 0, demand: false };
  const reason = noSignal ? "검색 결과를 충분히 확인하지 못해 가장 무난한 검색어로 골랐어요" : best.demand ? "네이버에서 실제로 많이 검색되는 말이고, 상위 글에 이 주제가 잘 나와요" : "상위 글에 이 주제가 가장 잘 나오는 검색어예요";
  return { query: best.q, candidates: scored.slice(0, 6).map(({ q, fit, demand }) => ({ q, fit, demand })), reason };
}

module.exports = { bestQuery, suggest, blogTitles };
