// 내 글에 달린 댓글이 "질문·어려움"이면, Claude 없이도 프로그램이 직접 답을 찾아 답글 예시를 만든다.
//  1) 질문인지 판단 → 2) 핵심 단어로 검색어 만들기 → 3) 내 글 본문 → 네이버 블로그 검색 결과 순으로 근거 찾기
//  4) 숫자·순서가 들어간 문장을 골라 "찾아온 방법"을 답글로 만든다.
// 결과는 data/neighbors-help.json 에 저장해 같은 댓글이면 다시 찾지 않는다.
const path = require("path");
const fs = require("fs");
const { keywordsOf } = require("./trends");
const scraper = require("./scraper");

const HELP_PATH = path.join(__dirname, "..", "data", "neighbors-help.json");
const HELP_VERSION = 2;

const stripEmoji = (s) =>
  String(s || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

// 질문·어려움을 말하는 표현
const QUESTION = /못\s?(하|해|했|해서|하고|찾|열|켜|만들|쓰|써)|안\s?(돼|되|나|열|보|떠|켜|잡|뜨)|어렵|도와|모르겠|몰라|어떻게|어떡|오류|에러|궁금|되나요|할까요|하나요|인가요|방법|왜\s|막혀|막혔|실패|헷갈|문제|안되|불가/;
// 그냥 인사·감사인 댓글은 제외 (질문 표현이 없으면 어차피 안 걸리지만 "감사합니다~ 어떻게 하나 했는데 해결됐어요" 같은 건 거른다)
const RESOLVED = /해결(됐|되었|했)|잘\s?(됐|되네|됩니다|돼요)|성공/;

const isQuestion = (text) => {
  const t = stripEmoji(text);
  return t.length >= 6 && QUESTION.test(t) && !RESOLVED.test(t);
};

// 검색어에 넣지 않을 말 (도움 요청 표현)
const FLUFF = new Set("도와주세여 도와주세요 도와줘요 도움 못하고 못해요 안돼요 안되요 있어요 있는데 모르겠어요 어떻게 어떡해요 궁금해요 알려주세요 알려줘요 부탁드려요 부탁해요 ㅠㅠ 해주세요 하는지 되는지 하나요 되나요 방법 있어 있는 있는데 하나 되나 하는 하고 하면".split(" "));

/** 질문 댓글 → 핵심 단어 (예: "위젯 설정을 못하고 있어요" → ["위젯","설정"]) */
function coreTerms(text) {
  return keywordsOf(stripEmoji(text).replace(/[;~!?？.ㅠㅜㅋㅎ]+/g, " ")).filter((w) => !FLUFF.has(w) && w.length >= 2);
}

/** 검색어: 내 글 제목의 주제어(최대 2개) + 질문의 핵심 단어 + "방법" */
function buildQuery(text, myTitle) {
  const core = coreTerms(text).slice(0, 3);
  const topic = keywordsOf(myTitle || "").filter((w) => !core.includes(w)).slice(0, 2);
  return [...topic, ...core, "방법"].join(" ").trim();
}

const isJunk = (w) => /^(안녕하세|제가|저는|저도|올해|오늘|이번|그리고|하지만|정말|진짜|너무|사실|생각|우리|감사|처음|이야기|소개|정리|방법|내용)$/.test(w) || /^x?\d{1,3}$/i.test(w);
const NUM = /\d+\s*(분|초|단계|개|원|%|번|일|명|가지|시간|회|MB|GB|px)/;
const STEP = /^\s*(\d+[.)]|[①-⑩]|STEP|Step|step|첫째|둘째|셋째)|(클릭|선택|누르|입력|들어가|설정|이동|체크|연결|복사|붙여)/;

/** 본문에서 질문과 관련된 문장을 점수로 골라낸다: 핵심 단어가 들어가고, 숫자·순서·동작이 있으면 가점 */
function pickLines(text, terms, max = 3) {
  const seen = new Set();
  const scored = [];
  for (const raw of String(text || "").split(/\n|(?<=[.!?다요])\s+/)) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length < 12 || line.length > 110 || seen.has(line)) continue;
    seen.add(line);
    const hit = terms.filter((t) => line.includes(t)).length;
    if (!hit && terms.length) continue;
    let s = hit * 3 + (NUM.test(line) ? 2 : 0) + (STEP.test(line) ? 2 : 0);
    if (/광고|협찬|구독|이웃추가|문의|http|www\.|\[사진|\[이미지|\[그림/.test(line)) s -= 5;
    if (s > 0) scored.push({ line, s });
  }
  return scored.sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.line);
}

/** 근거 찾기: 내 글 → 네이버 블로그 검색(상위 글 본문) */
async function research(text, myTitle, myText, myBlogId) {
  const terms = coreTerms(text);
  const query = buildQuery(text, myTitle);
  const facts = [];
  const mine = pickLines(myText, terms, 2);
  for (const l of mine) facts.push({ text: l, src: "내 글" });
  let sources = [];
  if (facts.length < 2 && query) {
    try {
      const cards = await scraper.fastCards(scraper.blogTabUrl(query, 1, false));
      const links = cards.filter((c) => c.href && !c.href.includes(`/${myBlogId}/`) && /blog\.naver\.com|tistory|brunch/.test(c.href)).slice(0, 3);
      for (const c of links) {
        const body = await scraper.fastArticleText(c.href).catch(() => "");
        const picked = pickLines((body || "") + "\n" + (c.snippet || ""), terms, 2);
        if (picked.length) {
          sources.push({ title: c.title, link: c.href });
          for (const l of picked) facts.push({ text: l, src: c.title, link: c.href });
        }
        if (facts.length >= 4) break;
      }
    } catch {}
  }
  return { query, terms, facts: facts.slice(0, 4), sources };
}

const shorten = (s, n) => (s.length > n ? s.slice(0, n - 1).replace(/\s\S*$/, "") + "…" : s);
const clean = (s) => s.replace(/^[\s\d.)①-⑩\-•·▶▷■□★☆]+/, "").replace(/[.!~\s]+$/, "");

/** 찾은 근거로 답글 예시 2개 (이모지 없음). 근거가 없으면 되묻는 답글 */
function compose(u, r) {
  const nick = u.nickname || "";
  const issue = r.terms.slice(0, 2).join(" ") || "그 부분";
  const f = r.facts.map((x) => clean(x.text));
  if (!f.length) {
    return [
      `${nick}님, ${issue} 때문에 막히셨군요 ㅠㅠ 어느 단계에서 멈추는지(화면에 뜨는 문구) 알려주시면 같이 확인해볼게요.`,
      `${issue}은 설정 화면에서 입력값이 비어 있거나 저장이 안 돼서 막히는 경우가 많아요. 저장 버튼까지 눌렀는지 먼저 확인해보시고 안 되면 말씀해 주세요.`,
    ];
  }
  const a = shorten(f[0], 70);
  const b = f[1] ? shorten(f[1], 60) : "";
  const link = (r.facts.find((x) => x.link) || {}).link || "";
  return [
    `${nick}님, ${issue} 막히셨군요 ㅠㅠ ${a}. 이대로 해보시고 그래도 안 되면 편하게 알려주세요.`,
    `${issue}은 이렇게 하면 돼요. ${a}${b ? `. ${b}` : ""}.${link ? ` 자세한 방법은 여기에 잘 나와 있어요 ${link}` : ""} 해결되면 알려주세요 ㅎㅎ`,
  ];
}

// 댓글 의도: 사용 요청 / 질문·어려움 / 그 밖(감사·인사·짧은 반응)
const REQUEST = /(사용|써|쓰|이용|체험|신청|받|참여|해보|써보).{0,8}(싶|하고\s?싶|할게|하고파|가능)|링크.{0,8}(주세|부탁|보내|알려)|신청\s?(할게|합니다|해요)|(주세요|부탁).{0,4}(링크|프로그램)|프로그램.{0,10}(싶|궁금|받)/;
const intentOf = (text) => (REQUEST.test(stripEmoji(text)) ? "request" : isQuestion(text) ? "question" : "other");

const topicTitle = (t) => shorten(String(t || "").replace(/["'“”]|\([^)]*\)/g, "").replace(/\s+/g, " ").trim(), 22);

/** 어떤 댓글이든 의도에 맞는 답글 예시 {list, kind, ...} */
function composeFor(q, r) {
  const nick = q.nickname || "";
  const intent = intentOf(q.text);
  if (intent === "question" && r) return { kind: "question", list: compose(q, r), query: r.query, facts: r.facts, sources: r.sources, found: r.facts.length > 0 };
  if (intent === "request") {
    const link = require("./license").TRIAL_URL;
    return {
      kind: "request",
      list: [
        `${nick}님 관심 가져주셔서 감사해요! 사용 링크 보내드릴게요. 체험은 2주 동안 무료로 쓰실 수 있어요.`,
        `감사합니다 ${nick}님! 아래 링크에서 이름과 블로그만 입력하시면 바로 체험해보실 수 있어요. ${link}`,
      ],
    };
  }
  const t = topicTitle(q.title);
  const len = stripEmoji(q.text).replace(/[~!?.ㅎㅋㅠㅜ\s]/g, "").length;
  return {
    kind: "other",
    list:
      len < 6
        ? [`${nick}님 댓글 남겨주셔서 감사해요. 또 놀러 오세요!`, `${nick}님 들러주셔서 감사해요. 편하게 또 얘기 나눠요.`]
        : [
            `${nick}님, '${t}' 글 읽어주시고 댓글까지 남겨주셔서 감사해요. 도움이 되셨다니 저도 기쁘네요.`,
            `${nick}님 덕분에 힘이 나요. '${t}' 내용 중에 궁금한 점 생기면 편하게 물어봐 주세요.`,
          ],
  };
}

// ---------- 이웃 글에 남길 댓글 (Claude 없이, 글 속 문구를 집어서) ----------
const GREET = /^(안녕|반갑|방문|이웃|구독|공감|오늘도|항상|감사)/;
const PROMO = /광고|협찬|구독|이웃추가|문의|http|www\.|\[사진|\[이미지|☎|010-|카카오|상담|예약|할인|이벤트/;
const STORY_RE = /영화|드라마|웹툰|소설|서평|결말|줄거리|시리즈|넷플릭스|\d+화/;
// 사진 설명·주소·표 항목처럼 감상 대상이 아닌 문장
const CAPTION = /모습|배치|촬영|출처|사진|이미지|주소|위치|영업시간|전화|번호|\d+(로|길)\s?\d|층\s?\w*호|:\s/;
// 글쓴이의 판단·이유·느낌이 담긴 표현
const EVAL = /좋|맛있|추천|비교|차이|문제|필요|중요|핵심|때문|덕분|느꼈|생각|의외|아쉬|놀라|편하|불편|만족|후회|깨달|알게/;
const SOLVE_RE = /해결|안\s?될\s?때|안\s?됨|오류|에러|방법|하는 법|하는법|설정|꿀팁|정리|가이드|\d+단계|\d+가지/;

/** 글에서 인용할 만한 문장 하나: 인사·광고가 아니고 숫자·구체어가 있는 것 */
function pickQuote(text, title) {
  const titleSet = new Set(keywordsOf(title || ""));
  const lines = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const cands = [];
  for (const [i, l] of lines.entries()) {
    for (const sent of l.split(/(?<=[.!?다요죠])\s+/)) {
      const t = sent.replace(/\s+/g, " ").replace(/[ㅎㅋㅠㅜ]{2,}/g, "").trim();
      if (t.length < 14 || t.length > 48 || GREET.test(t) || PROMO.test(t) || CAPTION.test(t) || /^[#*\[\(▫️▪️■□●○◆◇▶▷※]/.test(t)) continue;
      if (!/([.!]|습니다|세요|어요|아요|해요|예요|이에요|네요|죠|군요|거든요|같아요|돼요|됐어요|있어요|없어요|했어요|였어요)$/.test(t) || /(보다|까요|\?)$/.test(t)) continue; // 온전한 서술 문장만 (끊긴 조각·질문·표 항목 제외)
      const kws = keywordsOf(t).filter((w) => !titleSet.has(w) && !isJunk(w)).length;
      let sc = kws * 2 + (/\d/.test(t) ? 2 : 0) + (EVAL.test(t) ? 3 : 0);
      if (i < 2) sc -= 3;
      if (i > lines.length - 3) sc -= 1;
      if (sc > 0) cands.push({ t: t.replace(/[.!?]+$/, ""), sc });
    }
  }
  cands.sort((x, y) => y.sc - x.sc);
  return cands.length ? cands[0].t : "";
}

/** 숫자+단위가 들어간 정량 문구 하나 (예: "5시간 컷", "31.5g") */
function pickNumber(text) {
  const m = String(text || "").match(/\d[\d,.]*\s?(?:만원|원|분|초|시간|개월|년|명|개|%|퍼센트|kg|mAh|mm|cm|km|단계|가지|종|회|배|레벨)(?![가-힣A-Za-z])/g);
  return m ? m.sort((a, b) => b.length - a.length)[0].replace(/[.,)\]]+$/, "") : "";
}

function composeVisit(p, text) {
  const title = p.latestPost.title;
  const q = pickQuote(text, title);
  const n = pickNumber(text) || pickNumber(title);
  const topic = require("../public/suggest-templates.js").topicOf(title);
  const story = STORY_RE.test(title) || topic === "책";
  const solve = SOLVE_RE.test(title);
  const Q = q ? `“${q}”` : "";
  const t = topicTitle(title);
  let list;
  if (story) {
    list = [
      `${Q ? Q + " 이 대목이 오래 남았어요. " : ""}결말이 어떻게 이어지는지 곱씹게 되는 글이라 읽고 나서도 여운이 길게 남네요. 감사합니다.`,
      `${Q ? Q + " 부분 읽으면서 " : "읽으면서 "}저도 그 장면이 떠올랐어요. 마지막이 시원하게 안 풀려서 답답했던 마음까지 공감돼요.`,
    ];
  } else if (solve) {
    list = [
      `${Q ? Q + " 이 부분이 핵심이네요. " : ""}${n ? n + " 같은 기준까지 " : "순서까지 "}정리해주셔서 따라 하기 좋아요. 저장해두고 막힐 때 써볼게요. 감사합니다.`,
      `이런 해결법을 여기서 볼 수 있네요. ${Q ? Q + " 이 부분은 저도 적용해볼게요. " : ""}좋은 정보 감사합니다.`,
    ];
  } else if (["맛집", "나들이", "여행"].includes(topic)) {
    list = [
      `${Q ? Q + " 이 부분 보고 저도 가보고 싶어졌어요. " : ""}${n ? n + " 같은 구체적인 정보까지 " : "후기를 자세히 "}알려주셔서 도움 됐어요. 감사합니다.`,
      `${Q ? Q + " 라는 말이 와닿아서 기억에 남아요. " : ""}다음에 갈 때 이 글 참고할게요. 좋은 후기 감사합니다.`,
    ];
  } else if (["일상", "육아", "연애", "반려동물", "사주", "명절"].includes(topic)) {
    list = [
      `${Q ? Q + " 이 문장에서 글쓴이 마음이 느껴졌어요. " : ""}읽는 내내 공감하면서 봤어요. 잘 읽었습니다.`,
      `${Q ? Q + " 이 부분을 읽고 한참 생각했어요. " : ""}'${t}' 이야기 나눠주셔서 감사합니다.`,
    ];
  } else {
    list = [
      `${Q ? Q + " 이 부분이 제일 인상 깊었어요. " : ""}${n ? n + " 같은 수치까지 " : "내용을 "}알려주셔서 도움 많이 됐어요. 감사합니다.`,
      `이런 내용을 여기서 볼 수 있네요. ${Q ? Q + " 이 부분은 저도 참고해볼게요. " : ""}좋은 글 감사합니다.`,
    ];
  }
  return { kind: "visit", list: list.map((x) => x.replace(/\s+/g, " ").trim()), quote: q, number: n };
}

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(HELP_PATH, "utf-8"));
  } catch {
    return {};
  }
}

/** 지금 버전으로 만든 것만 {key: {list, facts, query, sources}} */
function readHelp() {
  const out = {};
  for (const [k, v] of Object.entries(readAll())) if (v && v.v === HELP_VERSION && Array.isArray(v.list)) out[k] = v;
  return out;
}

const helpKey = (c) => `help:${c.logNo}:${c.blogId}:${c.date}`;

/** 답글을 달 댓글들: 사람별 최근 3개 + 아직 답 안 한 댓글 [{key, logNo, blogId, nickname, date, text, title}] */
function collectComments(cache) {
  const out = new Map();
  for (const p of cache.people || []) {
    for (const c of (p.comments || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 3)) {
      const it = { logNo: c.logNo, blogId: p.blogId, nickname: p.nickname, date: c.date, text: c.text, title: c.title };
      out.set(helpKey(it), it);
    }
  }
  for (const u of cache.unanswered || []) out.set(helpKey(u), { logNo: u.logNo, blogId: u.blogId, nickname: u.nickname, date: u.date, text: u.text, title: u.title });
  return [...out.values()].map((q) => ({ ...q, key: helpKey(q) }));
}
const collectQuestions = collectComments;
const visitLocalKey = (p) => `lv:${p.blogId}:${p.latestPost.logNo}`;

let state = { running: false, progress: "" };
const getState = () => state;
const postCache = new Map(); // logNo → 내 글 본문 (한 번만 읽는다)

/** 해야 할 일 개수 (댓글 답글 + 이웃 글 댓글) */
function todoCount(cache) {
  const have = readHelp();
  const c = collectComments(cache).filter((q) => !have[q.key]).length;
  const done = require("./neighbors").getVisited();
  const v = (cache.neighbors || cache.people || []).filter((p) => p.latestPost && done[p.blogId] !== p.latestPost.logNo && !have[visitLocalKey(p)] && Date.now() - new Date(p.latestPost.date) < 30 * 864e5).slice(0, 80).length;
  return c + v;
}

/** 아직 없는 것들을 만들어 저장한다 (백그라운드): 댓글 답글(질문이면 검색) + 이웃 글 댓글 */
async function build(cache, { force = false } = {}) {
  if (state.running || !cache) return;
  const have = readHelp();
  const comments = collectComments(cache).filter((q) => force || !have[q.key]);
  const doneMap = require("./neighbors").getVisited(); // 답방을 마친 글은 추천 댓글을 만들지 않는다
  const visits = (cache.neighbors || cache.people || [])
    .filter((p) => p.latestPost && doneMap[p.blogId] !== p.latestPost.logNo && (force || !have[visitLocalKey(p)]) && Date.now() - new Date(p.latestPost.date) < 30 * 864e5)
    .sort((x, y) => new Date(y.latestPost.date) - new Date(x.latestPost.date))
    .slice(0, 80);
  const total = comments.length + visits.length;
  if (!total) return;
  let done = 0;
  state = { running: true, progress: `답글 준비 중 (0/${total})` };
  try {
    const cfg = require("./config");
    const { fetchPostTextOf } = require("./suggest");
    const all = readAll();
    const save = () => fs.writeFileSync(HELP_PATH, JSON.stringify(all, null, 2));
    for (const q of comments) {
      let r = null;
      if (intentOf(q.text) === "question") {
        if (!postCache.has(q.logNo)) postCache.set(q.logNo, await fetchPostTextOf(cfg.blogId(), q.logNo).catch(() => ""));
        r = await research(q.text, q.title, postCache.get(q.logNo), cfg.blogId());
      }
      all[q.key] = { v: HELP_VERSION, ...composeFor(q, r) };
      save();
      state.progress = `답글 준비 중 (${++done}/${total})`;
    }
    let next = 0;
    const worker = async () => {
      while (next < visits.length) {
        const p = visits[next++];
        const text = await fetchPostTextOf(p.blogId, p.latestPost.logNo).catch(() => "");
        all[visitLocalKey(p)] = { v: HELP_VERSION, ...composeVisit(p, text) };
        state.progress = `답글 준비 중 (${++done}/${total})`;
        if (done % 10 === 0) save();
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, visits.length) }, worker));
    save();
    state = { running: false, progress: "완료" };
  } catch (e) {
    state = { running: false, progress: "", error: e.message };
  }
}

module.exports = { isQuestion, intentOf, coreTerms, buildQuery, pickLines, research, compose, composeFor, composeVisit, readHelp, collectQuestions, collectComments, todoCount, visitLocalKey, build, getState, helpKey, _test: { stripEmoji } };
