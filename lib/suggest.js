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
// buildPrompt()의 규칙(이모지 금지, 핵심 내용 파악 등)을 바꿀 때마다 올린다.
// 예전 버전으로 만들어둔 결과는 업데이트해도 파일에 남아 재사용되므로, 여기서 버전이 다르면
// "없는 것"으로 취급해 다시 만들게 한다 (사용자가 일일이 [다시 만들기]를 누를 필요 없이).
const PROMPT_VERSION = 4;

function readRaw() {
  try {
    return JSON.parse(fs.readFileSync(SUGGEST_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function writeRaw(all) {
  fs.writeFileSync(SUGGEST_PATH, JSON.stringify(all, null, 2));
}

/** 지금 프롬프트 버전으로 만든 것만 {key: [문장, 문장]} 형태로 돌려준다 (예전 버전은 없는 셈 침) */
function readSuggestions() {
  const raw = readRaw();
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v && v.v === PROMPT_VERSION && Array.isArray(v.list)) out[k] = v.list;
  }
  return out;
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
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/^se-main-container">/, "")
    // 본문 끝에 눈에 안 보이는 공유용 메타데이터({"title":...})가 글자로 같이 딸려 나오는 경우가 있어 잘라낸다
    .split(/\{"title":/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2400); // 짧은 글은 거의 전체가, 긴 글은 앞부분 위주로 들어간다
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
        // 답글도 "내 글에 뭐라고 썼었는지"를 알아야 댓글이 전하려던 말에 제대로 반응할 수 있다
        if (it.kind === "reply") it.myText = await fetchPostText(require("./config").blogId(), it.u.logNo).catch(() => "");
      }
      for (let b = 0; b < items.length; b += BATCH_SIZE) {
        const batch = items.slice(b, b + BATCH_SIZE);
        state.progress = `추천 문구 만드는 중 (${Math.min(b + BATCH_SIZE, items.length)}/${items.length}명)... 1분 정도 걸려요`;
        const result = extractJson(await askClaude(buildPrompt(batch, cache.myComments || []), { timeoutMs: 240000 }));
        const all = readRaw();
        for (const it of batch) {
          const list = result[it.key];
          if (Array.isArray(list) && list.length) all[it.key] = { v: PROMPT_VERSION, list: list.map(String).slice(0, 3) };
        }
        writeRaw(all);
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

// 이모지·그림문자 계열을 전부 걷어낸다 (과거 댓글 샘플에 남아 있어도 말투 참고용으로만 쓰고 따라 쓰지 않게)
const stripEmoji = (s) =>
  String(s || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

function buildPrompt(batch, myComments) {
  const tone = myComments.length
    ? `아래는 이 블로거가 실제로 쓴 댓글/답글이야(이모지는 다 지웠어). 말투(어미, 문장 길이, "ㅎㅎ"/"ㅠㅠ" 같은 습관)만 참고하고 이모지는 절대 넣지 마:\n` +
      myComments.slice(0, 12).map((t) => `- ${stripEmoji(t)}`).filter((t) => t !== "-").join("\n")
    : `말투는 친근한 존댓말.`;

  const blocks = batch.map((it) => {
    if (it.kind === "visit") {
      return (
        `[${it.key}] (이웃 글에 남길 댓글)\n` +
        `이웃 닉네임: ${it.p.nickname}\n글 제목: ${it.p.latestPost.title}\n` +
        `글 본문: ${it.text || "(본문을 못 읽음 — 제목만 참고)"}`
      );
    }
    return (
      `[${it.key}] (내 글에 달린 댓글에 다는 답글)\n` +
      `댓글 단 사람: ${it.u.nickname}\n내 글 제목: ${it.u.title}\n` +
      `내가 그 글에 쓴 내용: ${it.myText || "(본문을 못 읽음 — 제목만 참고)"}\n` +
      (it.u.rootText ? `원댓글: ${it.u.rootText || "(스티커)"}\n` : "") +
      `상대가 마지막으로 남긴 말: ${it.u.text.trim() || "(스티커/이미지만 남김)"}`
    );
  });

  return (
    `네이버 블로그 "${require("./config").blogName()}" 운영자가 이웃과 소통할 때 쓸 댓글 예시를 만들어줘. 실제로 올리는 건 본인이 직접 고쳐서 쓴다.\n\n` +
    `${tone}\n\n` +
    `작업 순서 (반드시 이 순서로 생각해줘):\n` +
    `1. 먼저 "글 본문"(또는 "내가 그 글에 쓴 내용")을 읽고, 이 글이 진짜 하고 싶은 말이 뭔지 한 문장으로 정리해봐. ` +
    `단순히 소재(예: "여행 갔다옴", "AI 도구 소개")가 아니라, 그 글의 핵심 주장·결론·깨달음·팁이 뭔지를 파악해.\n` +
    `2. 댓글/답글은 그 핵심 내용에 반응하는 내용으로 써. 글에 나온 지명·제품명 같은 표면적 단어만 언급하고 끝내지 마.\n\n` +
    `규칙:\n` +
    `- 항목마다 예시 2개, 각 1~2문장, 60자 안팎.\n` +
    `- 이모지·이모티콘·특수 장식 기호(💕, 😊, 🙏, ㅋㅋ 이모지, ".ᐟ.ᐟ" 같은 것) 절대 쓰지 마. 순수 텍스트만.\n` +
    `- "좋은 글 잘 보고 갑니다", "정리가 깔끔하네요", "유익한 정보 감사해요", "다음 글도 기대할게요", "다음 편도 기대할게요" 같은 ` +
    `어디에나 붙는 뻔한 인사·클로징 문장 금지. 문장 끝을 그런 식으로 얼버무리지 말고, 마지막까지 그 글의 핵심 내용 얘기로 채워.\n` +
    `- 그 글에서만 나올 수 있는 구체적인 반응이어야 해 (예: 글쓴이의 결론에 동의/반박하거나, 그 팁을 실제로 써볼 계획을 말하거나, 왜 그 깨달음이 와닿았는지).\n` +
    `- 최소 1개는 글쓴이가 답하기 쉽게, 글 내용과 관련된 짧은 되물음이나 내 경험을 걸고 의견을 구하는 식으로 끝내줘 ` +
    `(예: 그 방법을 자기도 겪었는지 묻거나, 자기 경우엔 어땠는지 되묻는 식). 형식적인 물음("다음엔 어떠신가요?" 같은) 말고, 그 글 내용이 아니면 나올 수 없는 질문이어야 해.\n` +
    `- 과한 칭찬, 광고·홍보 멘트, 내 블로그 홍보 금지.\n` +
    `- 답글은 상대가 남긴 말에 자연스럽게 반응하되, 내 글의 핵심 내용과 연결해서 답하고, 두 예시의 느낌을 다르게.\n\n` +
    blocks.join("\n\n") +
    `\n\n대괄호 안의 키를 그대로 써서 다음 JSON 형식으로만 답해 (핵심 내용 분석은 출력하지 말고 최종 댓글만):\n{"<키>": ["예시1", "예시2"], ...}`
  );
}

module.exports = { generate, getState, readSuggestions };
