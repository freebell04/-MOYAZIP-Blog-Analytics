// 답방 댓글 / 댓글 답글 "예시"를 만든다. 실제로 쓰고 올리는 건 사용자가 직접 한다.
//
// - visit: 이웃의 최신 글 본문을 읽고, 그 글에 남길 만한 댓글 예시
// - reply: 내 글에 달린 댓글에 달 답글 예시
// 내가 실제로 단 댓글들을 말투 샘플로 넣고, 여러 명을 한 번의 Claude 호출로 묶어서 만든다.
// 결과는 파일에 저장해 두고 같은 글/댓글이면 다시 만들지 않는다.
const path = require("path");
const fs = require("fs");
const { askClaude, extractJson } = require("./claude");
const { keywordsOf } = require("./trends");
const neighbors = require("./neighbors");

const SUGGEST_PATH = path.join(__dirname, "..", "data", "neighbors-suggest.json");
const BATCH_SIZE = 5; // AI 한 번에 5명까지 (요청문이 짧아야 AI 창이 가볍다)
// buildPrompt()의 규칙(이모지 금지, 핵심 내용 파악 등)을 바꿀 때마다 올린다.
// 예전 버전으로 만들어둔 결과는 업데이트해도 파일에 남아 재사용되므로, 여기서 버전이 다르면
// "없는 것"으로 취급해 다시 만들게 한다 (사용자가 일일이 [다시 만들기]를 누를 필요 없이).
const PROMPT_VERSION = 9;

// Claude(터미널용 CLI)가 없거나 로그인·사용량 문제로 안 되면, 로그인 크롬의 ChatGPT/Gemini로 대신 만든다.
// (대부분의 사용자는 Claude CLI가 없다) 한 번 실패하면 이 서버가 켜져 있는 동안은 바로 웹 AI로 간다.
let claudeDown = false;
// AI가 키를 줄여 쓰는 경우가 있다 (Gemini: "visit:abc:123" → "abc"). 정확한 키가 없으면 블로그 아이디가 든 키로 찾는다
function pick(json, it) {
  if (!json || typeof json !== "object") return undefined;
  if (Array.isArray(json[it.key])) return json[it.key];
  const id = it.kind === "visit" ? it.p.blogId : it.u.blogId;
  const extra = it.kind === "visit" ? it.p.latestPost.logNo : it.u.logNo;
  const ks = Object.keys(json).filter((k) => Array.isArray(json[k]) && k.includes(id));
  return json[ks.find((k) => k.includes(extra)) || ks[0]];
}
function remap(json, batch) {
  const out = {};
  for (const it of batch) { const v = pick(json, it); if (v) out[it.key] = v; }
  return out;
}

async function askAi(prompt, keys, background = false) {
  if (!claudeDown) {
    try {
      return { json: remap(extractJson(await askClaude(prompt, { timeoutMs: 240000 })), keys), via: "Claude" };
    } catch (e) {
      if (/timeout/i.test(e.message)) throw e;
      claudeDown = true;
    }
  }
  const aiChat = require("./aiChat");
  let ai = aiChat.lastWriteAi();
  if (!aiChat.SITES[ai] || ai === "claude") ai = "chatgpt";
  state.progress = `${aiChat.SITES[ai].name}가 글을 읽고 추천 댓글을 쓰는 중... (크롬 탭, 30초쯤 걸려요)`;
  const json = await aiChat.askWeb(ai, prompt, (j) => keys.some((it) => pick(j, it)), { background });
  return { json: remap(json, keys), via: aiChat.SITES[ai].name };
}

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
  const text = body
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, "\n") // 문단 구분은 줄바꿈으로 남긴다 (글의 흐름을 알아보게)
    .replace(/<[^>]+>/g, " ");
  return clipPost(
    decode(text)
      .replace(/^se-main-container">/, "")
      // 본문 끝에 눈에 안 보이는 공유용 메타데이터({"title":...})가 글자로 같이 딸려 나오는 경우가 있어 잘라낸다
      .split(/\{"title":/)[0]
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .filter(Boolean)
      .join("\n")
  );
}

const decode = (t) =>
  String(t)
    .replace(/&nbsp;|&#x200B;|​/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d))
    .replace(/&amp;/g, "&");

/** 너무 긴 글은 앞부분(주제·구체적 내용)과 끝부분(결론·마무리)을 남기고 가운데를 줄인다 */
// 댓글 하나 쓰는 데 글 전체는 필요 없다: 앞부분(무슨 글인지·핵심) + 끝부분(결론)만 보내서 AI 창이 가볍게
function clipPost(t, max = 1600) {
  if (t.length <= max) return t;
  return t.slice(0, 1200) + "\n(… 중간 생략 …)\n" + t.slice(-400);
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
async function generate(keys, { force = false, auto = false } = {}) {
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
        if (it.kind === "reply") {
          it.myText = await fetchPostText(require("./config").blogId(), it.u.logNo).catch(() => "");
          // 질문·어려움을 말한 댓글이면 프로그램이 미리 찾아둔 답변 근거를 같이 넘긴다
          const h = require("./helpAnswer").readHelp()[require("./helpAnswer").helpKey(it.u)];
          if (h) it.help = h;
        }
      }
      const batches = [];
      for (let b = 0; b < items.length; b += BATCH_SIZE) batches.push(items.slice(b, b + BATCH_SIZE));
      let doneBatches = 0;
      // 배치를 동시에(최대 3개) 만든다: Claude를 한 번 부르는 데 오래 걸려서, 순서대로 하면 사람 수가 많을수록 오래 걸린다
      let nextBatch = 0;
      const worker = async () => {
        while (nextBatch < batches.length) {
          const batch = batches[nextBatch++];
          state.progress = `추천 문구 만드는 중 (${doneBatches}/${batches.length}묶음 끝)... 1분 정도 걸려요`;
          const result = (await askAi(buildPrompt(batch, cache.myComments || []), batch, auto)).json;
          // 검사: 본문의 구체적인 내용이 안 들어갔거나 뻔한 문장이면 버리고, 하나도 못 건진 글만 한 번 더 만든다
          const lists = {};
          const retry = [];
          for (const it of batch) {
            const good = filterGood(result[it.key], it);
            if (good.length) lists[it.key] = good;
            else retry.push(it);
          }
          if (retry.length) {
            state.progress = `더 구체적으로 다시 만드는 중 (${retry.length}명)...`;
            try {
              const again = (await askAi(buildPrompt(retry, cache.myComments || [], true), retry, auto)).json;
              for (const it of retry) {
                const good = filterGood(again[it.key], it);
                // 그래도 기준에 못 미치면, 첫 결과 중 뻔한 인사만 뺀 것이라도 남긴다 (빈 칸보다는 낫다)
                lists[it.key] = good.length ? good : bestEffort(result[it.key], again[it.key]);
              }
            } catch {
              for (const it of retry) lists[it.key] = bestEffort(result[it.key]);
            }
          }
          const all = readRaw();
          for (const it of batch) {
            const list = lists[it.key];
            if (Array.isArray(list) && list.length) all[it.key] = { v: PROMPT_VERSION, list: list.map(String).slice(0, 2) };
          }
          writeRaw(all);
          doneBatches++;
        }
      };
      await Promise.all(Array.from({ length: claudeDown ? 1 : Math.min(3, batches.length) }, worker));
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

// 어디에나 붙는 뻔한 문장 (이런 말이 들어간 댓글은 쓰지 않는다)
const BANNED = /수치까지|이 부분(이|은) (제일|저도)|참고해볼게요|도움 많이 됐어요|가볼게요|가보겠습니다|잘 보고 (갑니다|가요|갈게요)|잘 읽고 (갑니다|가요|갈게요)|구경 잘|유익한 (정보|글)|좋은 (정보|글) (감사|잘)|기대(할게요|하겠습니다|됩니다|돼요)|응원(합니다|할게요|해요)|또 놀러|자주 올게요|공감하고 갑니다|놀러 왔어요/;

// 어느 글에나 나오는 흔한 말 (구체적인 내용이 아니라서 "구체적인 단어"로 세지 않는다)
const COMMON = new Set(
  ("안녕하세 안녕하세요 안녕하십니까 제가 저는 저의 저도 올해 오늘 어제 이번 지난 요즘 최근 그리고 하지만 그래서 그러나 때문 정말 진짜 너무 매우 아주 사실 생각 경우 우리 여러분 감사 입니다 합니다 있습니다 했습니다 같아요 같습니다 " +
    "이렇게 그렇게 저렇게 어떻게 이런 그런 저런 이것 그것 무엇 누구 어디 언제 하나 먼저 다음 마지막 처음 이상 이하 정도 부분 내용 이야기 소개 설명 정리 방법 시간 하루 일상 기록 포스팅 블로그 이웃 공감 댓글 사진 링크 클릭 확인 참고 참여 진행 시작 마무리 " +
    "누구나 인생 사용하다 무엇인지 사람 사람들 모두 함께 같이 다시 계속 항상 가장 조금 많이 많은 좋은 다른 새로운 대한 위한 통해 관련 대해 에서 으로").split(/\s+/)
);
const isJunk = (w) => COMMON.has(w) || /^x?\d{1,3}$/i.test(w) || /^(quot|amp|nbsp|lt|gt)$/i.test(w) || /^[a-z]$/i.test(w);

/** 본문에만 있는 구체적인 단어들 (제목에 이미 있는 말, 인사·흔한 말, 글 첫머리 인사에만 나오는 말은 뺀다) */
function bodySpecifics(it) {
  const body = it.kind === "visit" ? it.text : it.myText;
  const title = it.kind === "visit" ? it.p.latestPost.title : it.u.title;
  const titleSet = new Set(keywordsOf(title || ""));
  const head = String(body || "").slice(0, 40); // 첫머리는 인사인 경우가 많다
  const rest = String(body || "").slice(40);
  const words = [...new Set(keywordsOf(rest))].filter((w) => !titleSet.has(w) && !isJunk(w) && (w.length >= 3 || (w.length >= 2 && /[A-Za-z0-9]/.test(w))) && !(head.includes(w) && !rest.includes(w)));
  return { body: body || "", words };
}

/** 이 댓글이 쓸 만한가: 뻔한 인사가 없고, 본문에 나온 구체적인 단어를 2개 이상 담았는가 (본문을 못 읽었거나 짧은 글은 인사말 검사만) */
function isGood(comment, it) {
  const c = String(comment || "").trim();
  if (c.length < 20 || BANNED.test(c)) return false;
  if (it.kind === "reply" && (it.help || require("./helpAnswer").intentOf(it.u.text) !== "other")) return true; // 요청·질문 답글은 그 댓글에 맞게 답했는지가 중요하지 본문 단어 수가 아님
  const { body, words } = bodySpecifics(it);
  if (body.length < 300) return true;
  return words.filter((w) => c.includes(w)).length >= 1;
}
const filterGood = (list, it) => (Array.isArray(list) ? list.map(String).filter((c) => isGood(c, it)) : []).slice(0, 2);
const leastBad = (list) => (Array.isArray(list) ? list.map(String).filter((c) => c.trim().length >= 20 && !BANNED.test(c)) : []);
// 기준에 못 미친 경우의 마지막 수단: 인사 문구가 없는 것을 먼저, 그것도 없으면 받은 결과라도 남긴다 (화면이 비는 것보다 낫다)
const bestEffort = (...lists) => {
  const all = lists.flatMap((l) => (Array.isArray(l) ? l.map(String).filter((c) => c.trim().length >= 10) : []));
  const clean = all.filter((c) => !BANNED.test(c));
  return (clean.length ? clean : all).slice(0, 2);
};

function buildPrompt(batch, myComments, stricter = false) {
  const tone = myComments.length
    ? `아래는 이 블로거가 실제로 쓴 댓글/답글이야(이모지는 다 지웠어). 말투(어미, 문장 길이, "ㅎㅎ"/"ㅠㅠ" 같은 습관)만 참고하고 이모지는 절대 넣지 마:\n` +
      myComments.slice(0, 12).map((t) => `- ${stripEmoji(t)}`).filter((t) => t !== "-").join("\n")
    : `말투는 친근한 존댓말.`;

  const blocks = batch.map((it) => {
    const hint = stricter ? `\n(꼭 넣을 만한 본문 속 구체적인 단어: ${bodySpecifics(it).words.slice(0, 8).join(", ") || "본문에서 직접 골라"})` : "";
    if (it.kind === "visit") {
      return (
        `[${it.key}] (이웃 글에 남길 댓글)\n` +
        `이웃 닉네임: ${it.p.nickname}\n글 제목: ${it.p.latestPost.title}\n` +
        `글 본문:\n${it.text || "(본문을 못 읽음 — 제목만 참고)"}${hint}`
      );
    }
    return (
      `[${it.key}] (내 글에 달린 댓글에 다는 답글)\n` +
      `댓글 단 사람: ${it.u.nickname}\n내 글 제목: ${it.u.title}\n` +
      `내가 그 글에 쓴 내용:\n${it.myText || "(본문을 못 읽음 — 제목만 참고)"}\n` +
      (it.u.rootText ? `원댓글: ${it.u.rootText || "(스티커)"}\n` : "") +
      `상대가 마지막으로 남긴 말: ${it.u.text.trim() || "(스티커/이미지만 남김)"}` +
      (require("./helpAnswer").intentOf(it.u.text) === "request"
        ? `
★ 이 댓글은 사용/체험을 해보고 싶다는 요청이야. 감사 인사와 함께 "사용 링크 보내드릴게요"처럼 링크를 보내주겠다는 답으로 써줘.`
        : "") +
      (it.help && it.help.kind === "question"
        ? `
★ 이 댓글은 질문/어려움이야. 아래 "찾아둔 근거"에 있는 방법·숫자로 질문에 직접 답해줘 (근거에 없는 내용은 지어내지 마). 근거: ${it.help.facts.map((f) => f.text).join(" / ") || "(못 찾음 — 어디서 막혔는지 되묻기)"}`
        : "") +
      hint
    );
  });

  return (
    `네이버 블로그 "${require("./config").blogName()}" 운영자가 이웃과 소통할 때 쓸 댓글 예시를 만들어줘. 실제로 올리는 건 본인이 직접 고쳐서 쓴다.\n\n` +
    `${tone}\n\n` +
    (stricter ? `★ 지난번 답은 어느 글에나 쓸 수 있는 일반적인 문장이었어. 이번에는 글의 중심 내용(아래 "구체적인 단어" 참고)을 자연스럽게 짚어서, 그 글을 실제로 읽은 사람만 쓸 수 있는 댓글로 써줘.\n\n` : "") +
    `[이웃 글에 남기는 댓글] 항목마다 예시 2개. 아래 순서로 머릿속에서만 생각하고, 생각한 내용은 출력하지 마.
` +
    `1. 본문을 끝까지 읽고 "이 글이 결국 무슨 글인지"를 한 문장으로 정리해: 무엇(장소·제품·방법)에 대한 글이고, 글쓴이가 가장 전하고 싶은 것(좋았던 점·결론·핵심 팁·겪은 일)이 뭔지.
` +
    `2. 글 유형을 하나로 정해:
` +
    `  · 후기형(일상·감성, 책/영화/장소 방문 후기 등 감상 중심): 글쓴이가 느낀 감정이나 경험에 깊이 공감하는 톤
` +
    `  · 제품 추천형(물건·화장품·전자기기·내돈내산/협찬 리뷰): 그 제품의 특정 장점·기능·디자인을 콕 집어 말하거나 궁금한 점을 묻는 톤
` +
    `  · 정보형(노하우·IT 팁·가이드·지식): 몰랐던 걸 알게 돼 고맙고, 실제로 써먹거나 저장해두겠다는 톤
` +
    `3. 1번에서 정리한 "글의 중심"에 반응하는 댓글을 써. 중심 소재를 이름으로 부르고(예: 그 공원 이름, 제품 이름, 그 방법), 글쓴이의 핵심 경험·정보 하나에 내 반응(공감, 궁금증, 적용 계획)을 붙여.
` +
    `   - 곁가지 문장(지나가듯 한 말, 목차·표의 단어, "따로 정리해 둔 글" 같은 다른 글 안내, 인사말)을 골라 쓰지 마. 글을 대표하는 내용만.
` +
    `   - 글 문장을 따옴표로 옮겨 오지 말고 내 말로 풀어 써. 숫자·가격은 글의 핵심일 때만 자연스럽게.
` +
    `   - 해요체("~했네요", "~더라고요"), 공백 포함 50~100자, 1~2문장. 진짜 이웃이 읽고 바로 남기는 말처럼.
` +
    `   - 두 예시는 다른 포인트를 짚고, 같은 말로 시작하지 마. 하나는 공감·감상, 하나는 짧은 질문이나 "저도 해봐야겠다" 식이면 좋아.
` +
    `   - 본문에 없는 내용·숫자는 지어내지 마.
` +
    `좋은 예 (가상의 글이야. 말투와 수준만 참고하고 내용은 절대 따라 쓰지 마):
` +
    `  후기형 — 비 오는 날 혼자 간 작은 북카페, 창가 자리에서 책 한 권을 다 읽은 글
` +
    `    "비 오는 날 창가 자리에서 책 한 권을 끝까지 읽으셨다니 상상만 해도 마음이 차분해져요. 그런 혼자만의 시간이 꼭 필요했던 하루였나 봐요."
` +
    `  제품 추천형 — 무선청소기를 3주 써보니 흡입력은 좋은데 먼지통이 작다는 글
` +
    `    "흡입력은 만족스러운데 먼지통이 작아 자주 비워야 한다는 점까지 솔직하게 알려주셔서 좋네요. 배터리는 한 번 충전으로 집 전체 청소가 되나요?"
` +
    `  정보형 — 연말정산 미리보기 서비스 사용법 글
` +
    `    "연말정산 미리보기로 환급액을 먼저 확인할 수 있는 줄 몰랐어요. 올해는 알려주신 순서대로 11월에 미리 챙겨봐야겠어요."
` +
    `나쁜 예: 글 속 아무 문장이나 따옴표로 옮겨 놓고 "이 대목이 와닿았어요"를 붙이기 / 제목만 되풀이하기 / "수치까지 알려주셔서 도움 많이 됐어요" 같은 어느 글에나 붙는 틀.

` +
    `금지 (이런 문장은 쓰지 마):\n` +
    `- "가볼게요", "가보고 싶어요"로 끝나는 문장, "잘 보고 갑니다", "유익한 정보 감사해요", "기대할게요", "응원합니다", "정리가 깔끔하네요" 같이 어느 글에나 붙는 인사.\n` +
    `- 이모지·이모티콘·특수 장식 기호(💕, 😊, 🙏, ".ᐟ.ᐟ" 같은 것). 순수 텍스트만.\n` +
    `- 과한 칭찬, 광고·홍보 멘트, 내 블로그 홍보.\n\n` +
    `[내 글에 달린 댓글에 다는 답글]: 항목마다 예시 2개, 각 1~2문장, 70자 안팎. 상대가 쓴 댓글 문장을 그대로 따라 쓰거나 인용하지 마. 찾아와서 읽고 댓글 남겨주셔서 감사하다는 마음을 전하되, 내 글에 나온 숫자·가격·방법 같은 구체적인 정보를 하나 짚어서 "도움이 됐다니 기쁘다"는 식으로 답해. 두 예시의 느낌을 다르게. 금지 사항은 위와 같아.

` +
    blocks.join("\n\n") +
    `\n\n대괄호 안의 키를 그대로 써서 다음 JSON 형식으로만 답해 (분석·메모는 출력하지 말고 최종 댓글만):\n{"<키>": ["예시1", "예시2"], ...}`
  );
}

module.exports = { generate, getState, readSuggestions, fetchPostTextOf: fetchPostText, _test: { buildPrompt, fetchPostText, isGood, filterGood, bodySpecifics, BANNED } };
