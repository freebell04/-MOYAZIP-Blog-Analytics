// 답방 댓글 / 댓글 답글 "예시"를 만든다. 실제로 쓰고 올리는 건 사용자가 직접 한다.
//
// - visit: 이웃의 최신 글 본문을 읽고, 그 글에 남길 만한 댓글 예시
// - reply: 내 글에 달린 댓글에 달 답글 예시
// 내가 실제로 단 댓글들을 말투 샘플로 넣고, 여러 명을 한 번의 Claude 호출로 묶어서 만든다.
// 결과는 파일에 저장해 두고 같은 글/댓글이면 다시 만들지 않는다.
const path = require("path");
const fs = require("fs");
const { askClaude, extractJson } = require("./claude");
const neighbors = require("./neighbors");

const SUGGEST_PATH = path.join(__dirname, "..", "data", "neighbors-suggest.json");
const BATCH_SIZE = 8;

function readSuggestions() {
  try {
    return JSON.parse(fs.readFileSync(SUGGEST_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeSuggestions(all) {
  fs.writeFileSync(SUGGEST_PATH, JSON.stringify(all, null, 2));
}

/** 네이버 블로그 글 본문 텍스트 (모바일 페이지를 그냥 받아서 태그만 걷어냄, 로그인 불필요) */
async function fetchPostText(blogId, logNo) {
  const res = await fetch(`https://m.blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`, {
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
    signal: AbortSignal.timeout(10000),
  });
  const html = await res.text();
  const i = html.indexOf("se-main-container");
  const body = (i >= 0 ? html.slice(i) : html).split(/<div class="(?:post_footer|se_tag|comment)/)[0];
  return body
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#x200B;|​/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/^se-main-container">/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

// 키 규칙 (프론트와 동일): visit:<blogId>:<logNo>  /  reply:<logNo>:<blogId>:<댓글시각>
const visitKey = (p) => `visit:${p.blogId}:${p.latestPost.logNo}`;
const replyKey = (u) => `reply:${u.logNo}:${u.blogId}:${u.date}`;

let state = { running: false, progress: "", error: null };

function getState() {
  return state;
}

/**
 * keys로 지정한 항목들의 추천 문구를 만든다 (백그라운드). force면 이미 있어도 다시 만든다.
 */
async function generate(keys, { force = false } = {}) {
  if (state.running) return;
  const cache = neighbors.getCached();
  if (!cache) throw new Error("먼저 [새로 불러오기]를 해주세요.");

  const existing = readSuggestions();
  const wanted = new Set(keys.filter((k) => force || !existing[k]));
  const items = [];
  // 답방 대상은 이웃 목록 전체 (공감·댓글 준 사람 포함)
  for (const p of cache.neighbors || cache.people) {
    if (p.latestPost && wanted.has(visitKey(p))) items.push({ key: visitKey(p), kind: "visit", p });
  }
  for (const u of cache.unanswered) {
    if (wanted.has(replyKey(u))) items.push({ key: replyKey(u), kind: "reply", u });
  }
  if (!items.length) return;

  state = { running: true, progress: `글 읽는 중 (0/${items.length})`, error: null };
  (async () => {
    try {
      for (const [i, it] of items.entries()) {
        state.progress = `글 읽는 중 (${i + 1}/${items.length})`;
        if (it.kind === "visit") it.text = await fetchPostText(it.p.blogId, it.p.latestPost.logNo).catch(() => "");
      }
      for (let b = 0; b < items.length; b += BATCH_SIZE) {
        const batch = items.slice(b, b + BATCH_SIZE);
        state.progress = `추천 문구 만드는 중 (${Math.min(b + BATCH_SIZE, items.length)}/${items.length}명)... 1분 정도 걸려요`;
        const result = extractJson(await askClaude(buildPrompt(batch, cache.myComments || []), { timeoutMs: 240000 }));
        const all = readSuggestions();
        for (const it of batch) {
          const list = result[it.key];
          if (Array.isArray(list) && list.length) all[it.key] = list.map(String).slice(0, 3);
        }
        writeSuggestions(all);
      }
      state = { running: false, progress: "완료", error: null };
    } catch (e) {
      const msg = /credit balance/i.test(e.message)
        ? "Claude 사용량(크레딧)이 부족해서 만들 수 없어요. 터미널에서 claude를 실행해 로그인·사용량을 확인해주세요."
        : e.message;
      state = { running: false, progress: "", error: msg };
    }
  })();
}

function buildPrompt(batch, myComments) {
  const tone = myComments.length
    ? `아래는 이 블로거가 실제로 쓴 댓글/답글이야. 말투(어미, 이모지·특수문자 쓰는 습관, 길이)를 최대한 따라해줘:\n` +
      myComments.slice(0, 12).map((t) => `- ${t}`).join("\n")
    : `말투는 친근한 존댓말, 이모지는 0~2개 정도로.`;

  const blocks = batch.map((it) => {
    if (it.kind === "visit") {
      return (
        `[${it.key}] (이웃 글에 남길 댓글)\n` +
        `이웃 닉네임: ${it.p.nickname}\n글 제목: ${it.p.latestPost.title}\n` +
        `글 본문 앞부분: ${it.text || "(본문을 못 읽음 — 제목만 참고)"}`
      );
    }
    return (
      `[${it.key}] (내 글에 달린 댓글에 다는 답글)\n` +
      `댓글 단 사람: ${it.u.nickname}\n내 글 제목: ${it.u.title}\n` +
      (it.u.rootText ? `원댓글: ${it.u.rootText || "(스티커)"}\n` : "") +
      `상대가 마지막으로 남긴 말: ${it.u.text.trim() || "(스티커/이미지만 남김)"}`
    );
  });

  return (
    `네이버 블로그 "${require("./config").blogName()}" 운영자가 이웃과 소통할 때 쓸 댓글 예시를 만들어줘. 실제로 올리는 건 본인이 직접 고쳐서 쓴다.\n\n` +
    `${tone}\n\n` +
    `규칙:\n` +
    `- 항목마다 예시 2개. 각 1~2문장, 60자 안팎.\n` +
    `- 이웃 글 댓글은 본문의 구체적인 내용(장소, 제품, 에피소드 등) 하나를 꼭 짚어서, 읽고 쓴 티가 나게.\n` +
    `- "좋은 글 잘 보고 갑니다" 같은 복붙 느낌 인사, 과한 칭찬, 광고·홍보 멘트, 내 블로그 홍보 금지.\n` +
    `- 답글은 상대 말에 자연스럽게 반응하고 감사 표현을 담되, 두 예시의 느낌을 다르게.\n\n` +
    blocks.join("\n\n") +
    `\n\n대괄호 안의 키를 그대로 써서 다음 JSON 형식으로만 답해:\n{"<키>": ["예시1", "예시2"], ...}`
  );
}

module.exports = { generate, getState, readSuggestions };
