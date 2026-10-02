// 이웃들이 요즘 쓰는 글로 "다음 콘텐츠 추천" 폭을 넓힌다.
// - 주제: 추천 댓글에 쓰는 23개 주제 분류(public/suggest-templates.js)를 그대로 사용
// - 키워드: 제목을 단어로 쪼개서 "여러 이웃이 같이 쓴 단어"를 찾는다 (한 이웃은 한 번만 셈)
// 이웃 목록을 새로 불러와야 이웃별 최근 글(recentPosts)이 채워진다. 없으면 최신 글 1개만 쓴다.
const { topicOf } = require("../public/suggest-templates.js");

const RECENT_DAYS = 30;

// 너무 흔해서 주제를 못 나타내는 단어
const STOP = new Set(
  (
    "후기 정리 총정리 방법 추천 리뷰 이유 내돈내산 공유 완벽 소개 의미 포인트 전문 기록 오늘 진짜 하는 좋은 가능 이번 그리고 우리 모든 가지 " +
    "어떻게 무엇 정말 너무 최신 사용 만들기 하기 관련 경우 사람 이야기 확인 필수 꿀팁 비교 가격 무료 대박 최고 기준 사례 분석 정보 요약 " +
    "시간 알아보기 알아보자 알아야 있는 없는 된다 좋아요 했어요 해요 위한 위해 대한 통해 가는 가기 보기 쓰는 쓰기 먹는 하루 부터 까지 " +
    "공지사항 이벤트 신청 당첨 이용 안내 전후 차이 장단점 세가지 가지 시점 모든것 한번 한눈에 한 번에 제대로 직접 실제 솔직 솔직후기 " +
    "매일 일차 주차 회차 마지막 마지막편 편 탄 년 월 일 day til 노하우 top best 아이 불리 뭐길래 괜찮을까 어디 무엇 누구 이것 그것 모음"
  ).split(/\s+/)
);
const PARTICLE = /(으로|에서|까지|부터|이랑|하고|에게|한테|처럼|보다|이라|라고|이란|하는|했던|해서|이다|입니다|은|는|이|가|을|를|에|의|로|와|과|도|만|요)$/;

function keywordsOf(title) {
  const text = String(title || "").replace(/[「」『』《》〈〉<>\[\]()]/g, " ");
  const out = new Set();
  for (let tok of text.split(/[^0-9A-Za-z가-힣]+/)) {
    if (!tok) continue;
    if (/^[A-Za-z]+$/.test(tok)) tok = tok.toUpperCase(); // 영문은 대소문자 통일 (GPT, gpt)
    const stripped = tok.replace(PARTICLE, "");
    if (stripped.length >= 2 && stripped !== tok) tok = stripped;
    if (tok.length < 2 || /^\d+$/.test(tok) || STOP.has(tok.toLowerCase()) || STOP.has(tok)) continue;
    if (/(까|까요|길래|나요|죠|니다|어요|아요|해요|세요|는지|을까)$/.test(tok)) continue; // 질문·서술형 말끝은 주제가 아님
    out.add(tok);
  }
  return [...out];
}

const norm = (s) => String(s || "").toLowerCase().replace(/[^0-9a-z가-힣]/g, "");

// 내 주력 주제가 AI일 때, 이웃 인기 주제와 엮은 글 제목 예시
const AI_ANGLE = {
  맛집: "AI로 맛집·여행 코스 짜는 법 (클로드·GPT 프롬프트 공유)",
  여행: "AI로 여행 일정 한 번에 짜는 법",
  나들이: "AI로 주말 나들이 코스 짜는 법",
  건강: "AI로 건강·식단 관리하는 법",
  운동: "AI로 운동 루틴·식단 짜는 법",
  재테크: "AI로 가계부·재테크 정리하는 법",
  책: "AI로 독서노트·서평 쓰는 법",
  문화: "AI로 영화·드라마·음악 추천받는 법",
  게임: "AI로 게임 공략 정리하는 법",
  블로그: "AI로 블로그 글감·제목 뽑는 법",
  일상: "AI로 하루 기록·일기 쓰는 법",
  육아: "AI로 아이 놀이·학습 계획 짜는 법",
  공부: "AI로 공부 계획 세우고 요약하는 법",
  "직장·부업": "AI로 업무 자동화·부업 시작하는 법",
  "뷰티·패션": "AI로 코디·퍼스널컬러 찾는 법",
  반려동물: "AI로 반려동물 케어 정보 찾는 법",
  연애: "AI로 데이트 코스·선물 고르는 법",
  사주: "AI로 사주·운세 풀어보기",
  디자인: "AI로 디자인·다이어리 서식 만드는 법",
  살림: "AI로 살림·청소 루틴 짜는 법",
  후기: "AI로 제품 비교하고 구매 결정하는 법",
};
const angleTitle = (myMain, topic) => (myMain === "AI" && AI_ANGLE[topic]) || `내 주력 '${myMain}' × 이웃 인기 '${topic}' 엮어보기`;

/**
 * @param d  성과 통계 캐시 (d.posts = 내 글)
 * @param nb 이웃 캐시 (nb.neighbors, nb.people)
 */
function buildTrends(d, nb) {
  if (!nb || !nb.neighbors) return null;
  d = d || { posts: [] };
  const since = Date.now() - RECENT_DAYS * 86400000;
  const gaveSet = new Set((nb.people || []).filter((p) => p.likes.length + p.comments.length > 0).map((p) => p.blogId));

  // 이웃 글 모으기
  const posts = [];
  for (const n of nb.neighbors) {
    const list = n.recentPosts && n.recentPosts.length ? n.recentPosts : n.latestPost ? [n.latestPost] : [];
    for (const p of list) {
      if (!p || !p.title || new Date(p.date).getTime() < since) continue;
      posts.push({ blogId: n.blogId, nick: n.nickname || n.blogId, title: p.title, link: p.link, date: p.date, close: n.mutual || n.iAdded || gaveSet.has(n.blogId) });
    }
  }
  const neighborCount = new Set(posts.map((p) => p.blogId)).size;

  // 내 글의 주제·키워드
  const myTitles = (d.posts || []).map((p) => p.title);
  const myNorm = myTitles.map(norm);
  const myTopicCount = {};
  for (const t of myTitles) {
    const k = topicOf(t);
    if (k) myTopicCount[k] = (myTopicCount[k] || 0) + 1;
  }
  const myMain = Object.entries(myTopicCount).sort((a, b) => b[1] - a[1])[0];
  const coveredByMe = (kw) => myNorm.some((t) => t.includes(norm(kw)));

  // 주제별
  const topics = {};
  for (const p of posts) {
    const k = topicOf(p.title);
    if (!k) continue;
    const t = (topics[k] ||= { topic: k, who: new Set(), posts: [] });
    t.who.add(p.blogId);
    t.posts.push(p);
  }
  const topicList = Object.values(topics)
    .map((t) => ({ topic: t.topic, neighborCount: t.who.size, postCount: t.posts.length, mine: myTopicCount[t.topic] || 0, examples: t.posts.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3) }))
    .sort((a, b) => b.neighborCount - a.neighborCount || b.postCount - a.postCount);

  // 키워드별 (한 이웃은 한 번만)
  const kws = {};
  for (const p of posts) {
    for (const kw of keywordsOf(p.title)) {
      const k = (kws[kw] ||= { keyword: kw, who: new Set(), posts: [], close: 0 });
      if (!k.who.has(p.blogId)) {
        k.who.add(p.blogId);
        if (p.close) k.close++;
      }
      k.posts.push(p);
    }
  }
  const keywordList = Object.values(kws)
    .filter((k) => k.who.size >= 2)
    .map((k) => ({
      keyword: k.keyword,
      neighborCount: k.who.size,
      closeCount: k.close,
      covered: coveredByMe(k.keyword),
      latest: k.posts.reduce((m, p) => (p.date > m ? p.date : m), ""),
      examples: k.posts.sort((a, b) => b.date.localeCompare(a.date)).filter((p, i, a) => a.findIndex((x) => x.blogId === p.blogId) === i).slice(0, 3),
    }))
    .sort((a, b) => b.neighborCount - a.neighborCount || b.closeCount - a.closeCount || b.latest.localeCompare(a.latest))
    .slice(0, 30);

  // ---- 추천 ----
  const ex = (list) => list.map((p) => ({ nick: p.nick, title: p.title, link: p.link }));
  const ideas = [];

  // (1) 이웃 트렌드 키워드인데 나는 아직 안 쓴 것
  for (const k of keywordList.filter((k) => !k.covered).slice(0, 4)) {
    ideas.push({
      type: "trend",
      title: `이웃 트렌드: "${k.keyword}"`,
      reason: `최근 ${RECENT_DAYS}일 동안 이웃 ${k.neighborCount}명이 '${k.keyword}' 글을 올렸어요${k.closeCount ? ` (그중 가까운 이웃 ${k.closeCount}명)` : ""}. 나는 아직 이 키워드로 쓴 글이 없어요.`,
      keyword: k.keyword,
      examples: ex(k.examples),
    });
  }

  // (2) 내 주력 주제 × 이웃 인기 주제
  if (myMain) {
    // 명절은 아래 시즌 추천에서 따로 다룬다
    for (const t of topicList.filter((t) => t.topic !== myMain[0] && t.topic !== "명절" && t.neighborCount >= 2).slice(0, 3)) {
      ideas.push({
        type: "cross",
        title: angleTitle(myMain[0], t.topic),
        reason: `이웃 ${t.neighborCount}명이 최근 '${t.topic}' 글을 썼어요 (나는 ${t.mine}개). 내가 가장 많이 쓰는 '${myMain[0]}' 관점으로 풀면 이웃 공감과 검색 유입을 같이 노릴 수 있어요.`,
        keyword: t.topic,
        examples: ex(t.examples),
      });
    }
  }

  // (3) 시즌 주제
  const season = topicList.find((t) => t.topic === "명절" && t.neighborCount >= 2);
  if (season) {
    ideas.push({
      type: "season",
      title: `시즌 글: 명절·연휴`,
      reason: `이웃 ${season.neighborCount}명이 최근 명절·연휴 글을 올렸어요. 시즌 글은 지금 올려야 읽혀요 — 내 주제와 엮어서 짧게라도 올려보세요.`,
      keyword: "명절",
      examples: ex(season.examples),
    });
  }

  return {
    recentDays: RECENT_DAYS,
    neighborCount,
    postCount: posts.length,
    hasRecentPosts: nb.neighbors.some((n) => n.recentPosts),
    myMainTopic: myMain ? myMain[0] : null,
    topics: topicList.slice(0, 12),
    keywords: keywordList.slice(0, 20),
    ideas,
  };
}

/** 통계 데이터에 이웃 트렌드 추천을 붙인 사본 (엑셀·노션 리포트용) */
function withTrendIdeas(d, trends) {
  if (!d || !trends || !trends.ideas.length) return d;
  return { ...d, analysis: { ...d.analysis, ideas: [...d.analysis.ideas, ...trends.ideas] } };
}

module.exports = { buildTrends, withTrendIdeas, keywordsOf };
