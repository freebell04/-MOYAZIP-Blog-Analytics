// 이웃 소통 > 주제 추천의 [🔄 새 주제 추천]: 내 글 + 이웃들의 최근 글을 AI에게 보여주고, 매번 다른 글 주제를 받아 온다.
// - 지난번에 받은 주제·이미 다 쓴(작성 완료) 주제는 "빼달라"고 같이 넘겨서 겹치지 않게 한다
// - 이웃 글은 매번 섞어서 일부만 보여준다 (같은 재료만 보면 같은 주제가 나와서)
// AI: Claude(터미널용 CLI)가 되면 그걸, 안 되면 로그인 크롬의 ChatGPT/Gemini (뒤쪽 탭에서)
const path = require("path");
const fs = require("fs");
const { askClaude, extractJson } = require("./claude");

const SAVE_PATH = path.join(__dirname, "..", "data", "topic-ideas.json");
const RECENT_DAYS = 30;

function read() {
  try { return JSON.parse(fs.readFileSync(SAVE_PATH, "utf-8")); } catch { return { ideas: [], history: [] }; }
}
function write(v) {
  fs.mkdirSync(path.dirname(SAVE_PATH), { recursive: true });
  fs.writeFileSync(SAVE_PATH, JSON.stringify(v, null, 2));
}

let state = { running: false, error: null, progress: "" };
const getState = () => state;
const getSaved = () => read();

const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

function buildPrompt(myPosts, nbPosts, avoid, blogName) {
  return (
    `네이버 블로그 "${blogName}" 운영자에게 다음에 쓸 블로그 글 주제 6개를 추천해줘.\n\n` +
    `[내가 최근에 쓴 글 제목] (내 블로그의 주력 분야·말투·독자를 파악하는 데 써)\n` +
    (myPosts.map((t) => `- ${t}`).join("\n") || "- (아직 없음)") +
    `\n\n[이웃들이 최근 ${RECENT_DAYS}일 동안 쓴 글 제목] (요즘 이웃들이 관심 있는 것·검색이 몰리는 것을 파악하는 데 써. 번호는 참고용)\n` +
    nbPosts.map((p, i) => `${i + 1}. ${p.title} (${p.nick})`).join("\n") +
    `\n\n생각하는 순서 (생각은 출력하지 마):\n` +
    `1. 내 글 제목들로 내 블로그의 주력 분야와 강점(내가 잘 아는 것, 독자가 기대하는 것)을 파악해.\n` +
    `2. 이웃 글 제목들에서 여러 명이 겹쳐 쓰는 관심사, 계절·시기 이슈, 사람들이 궁금해하는 문제를 찾아.\n` +
    `3. 둘을 엮어서 "내가 써야 잘 쓸 수 있고, 이웃·검색 독자도 읽고 싶어 할" 구체적인 글 주제를 만들어. 막연한 분야 이름(예: "AI 활용법")이 아니라 바로 제목으로 쓸 수 있을 만큼 구체적으로.\n` +
    `4. 6개는 서로 겹치지 않게: 정보형·후기형·비교형·리스트형·문제해결형 등 형식도 섞어.\n` +
    (avoid.length ? `\n아래 주제는 이미 추천했거나 이미 쓴 거라 비슷한 것도 빼줘:\n${avoid.map((t) => `- ${t}`).join("\n")}\n` : "") +
    `\n주제마다: title(바로 쓸 수 있는 글 제목, 40자 안팎), keyword(글감 검색에 쓸 핵심 검색어 2~4단어), reason(왜 지금 이 주제인지 — 이웃 글·내 강점 근거를 1~2문장), questions(독자가 궁금해할 질문 3개 — 소제목으로 쓸 수 있게), refs(근거가 된 이웃 글 번호 1~3개)\n` +
    `다음 JSON 형식으로만 답해 (다른 설명 없이):\n{"ideas": [{"title": "", "keyword": "", "reason": "", "questions": ["", "", ""], "refs": [1]}]}`
  );
}

async function ask(prompt) {
  try {
    const j = extractJson(await askClaude(prompt, { timeoutMs: 240000 }));
    if (j && Array.isArray(j.ideas)) return j;
  } catch {}
  const aiChat = require("./aiChat");
  let ai = aiChat.lastWriteAi();
  if (!aiChat.SITES[ai] || ai === "claude") ai = "chatgpt";
  state.progress = `${aiChat.SITES[ai].name}가 내 글과 이웃 글을 보고 주제를 고르는 중... (30초쯤)`;
  return aiChat.askWeb(ai, prompt, (j) => Array.isArray(j.ideas) && j.ideas.length > 0, { background: true });
}

/** 새 주제를 만든다 (바로 반환 — 진행은 getState) */
function generate({ myPosts, nb, blogName, done = [] }) {
  if (state.running) return;
  if (!nb || !nb.neighbors) throw new Error("먼저 위의 [새로 불러오기]로 이웃 목록을 불러와주세요.");
  const since = Date.now() - RECENT_DAYS * 86400000;
  const all = [];
  for (const n of nb.neighbors) {
    const list = n.recentPosts && n.recentPosts.length ? n.recentPosts : n.latestPost ? [n.latestPost] : [];
    for (const p of list) if (p && p.title && new Date(p.date).getTime() >= since) all.push({ nick: n.nickname || n.blogId, title: p.title, link: p.link });
  }
  if (!all.length) throw new Error("이웃들의 최근 글이 아직 없어요. [새로 불러오기]를 한 번 더 눌러주세요.");
  const nbPosts = shuffle(all).slice(0, 90); // 매번 다른 재료
  const saved = read();
  const avoid = [...new Set([...done, ...(saved.history || [])])].slice(-60);
  state = { running: true, error: null, progress: "AI에게 주제를 부탁하는 중..." };
  (async () => {
    try {
      const j = await ask(buildPrompt(myPosts.slice(0, 40), nbPosts, avoid, blogName));
      const ideas = j.ideas
        .filter((i) => i && i.title)
        .slice(0, 8)
        .map((i) => ({
          type: "ai",
          title: String(i.title),
          keyword: String(i.keyword || i.title),
          reason: String(i.reason || ""),
          questions: (Array.isArray(i.questions) ? i.questions : []).map(String).slice(0, 4),
          examples: (Array.isArray(i.refs) ? i.refs : []).map((n) => nbPosts[Number(n) - 1]).filter(Boolean).slice(0, 3),
        }));
      if (!ideas.length) throw new Error("AI가 주제를 보내지 않았어요. 다시 눌러주세요.");
      write({ at: new Date().toISOString(), ideas, history: [...(saved.history || []), ...ideas.map((i) => i.title)].slice(-120) });
      state = { running: false, error: null, progress: "" };
    } catch (e) {
      state = { running: false, error: e.message, progress: "" };
    }
  })();
}

module.exports = { generate, getState, getSaved };
