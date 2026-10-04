// 내 글에 달린 댓글이 "질문·어려움"이면, Claude 없이도 프로그램이 직접 답을 찾아 답글 예시를 만든다.
//  1) 질문인지 판단 → 2) 핵심 단어로 검색어 만들기 → 3) 내 글 본문 → 네이버 블로그 검색 결과 순으로 근거 찾기
//  4) 숫자·순서가 들어간 문장을 골라 "찾아온 방법"을 답글로 만든다.
// 결과는 data/neighbors-help.json 에 저장해 같은 댓글이면 다시 찾지 않는다.
const path = require("path");
const fs = require("fs");
const { keywordsOf } = require("./trends");
const scraper = require("./scraper");

const HELP_PATH = path.join(__dirname, "..", "data", "neighbors-help.json");
const HELP_VERSION = 1;

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
  return [
    `${nick}님, ${issue} 막히셨군요 ㅠㅠ ${a}. 이대로 해보시고 그래도 안 되면 편하게 알려주세요.`,
    `${issue}은 이렇게 하면 돼요. ${a}${b ? `. ${b}` : ""}. 해결되면 알려주세요 ㅎㅎ`,
  ];
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

/** 캐시된 이웃 데이터에서 질문 댓글들을 모은다 [{key, logNo, blogId, nickname, date, text, title}] */
function collectQuestions(cache) {
  const out = new Map();
  for (const p of cache.people || []) {
    for (const c of p.comments || []) {
      if (!isQuestion(c.text)) continue;
      const it = { logNo: c.logNo, blogId: p.blogId, nickname: p.nickname, date: c.date, text: c.text, title: c.title };
      out.set(helpKey(it), it);
    }
  }
  for (const u of cache.unanswered || []) {
    if (!isQuestion(u.text)) continue;
    out.set(helpKey(u), { logNo: u.logNo, blogId: u.blogId, nickname: u.nickname, date: u.date, text: u.text, title: u.title });
  }
  return [...out.values()].map((q) => ({ ...q, key: helpKey(q) }));
}

let state = { running: false, progress: "" };
const getState = () => state;
const postCache = new Map(); // logNo → 내 글 본문 (한 번만 읽는다)

/** 아직 답을 안 만든 질문들에 대해 근거를 찾아 저장한다 (백그라운드) */
async function build(cache, { force = false } = {}) {
  if (state.running || !cache) return;
  const have = readHelp();
  const todo = collectQuestions(cache).filter((q) => force || !have[q.key]);
  if (!todo.length) return;
  state = { running: true, progress: `질문 답변 찾는 중 (0/${todo.length})` };
  try {
    const cfg = require("./config");
    const { fetchPostTextOf } = require("./suggest");
    const all = readAll();
    for (const [i, q] of todo.entries()) {
      state.progress = `질문 답변 찾는 중 (${i + 1}/${todo.length})`;
      if (!postCache.has(q.logNo)) postCache.set(q.logNo, await fetchPostTextOf(cfg.blogId(), q.logNo).catch(() => ""));
      const r = await research(q.text, q.title, postCache.get(q.logNo), cfg.blogId());
      all[q.key] = { v: HELP_VERSION, list: compose(q, r), query: r.query, facts: r.facts, sources: r.sources, found: r.facts.length > 0 };
      fs.writeFileSync(HELP_PATH, JSON.stringify(all, null, 2));
    }
    state = { running: false, progress: "완료" };
  } catch (e) {
    state = { running: false, progress: "", error: e.message };
  }
}

module.exports = { isQuestion, coreTerms, buildQuery, pickLines, research, compose, readHelp, collectQuestions, build, getState, helpKey, _test: { stripEmoji } };
