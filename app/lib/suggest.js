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
const BATCH_SIZE = 8;
// buildPrompt()의 규칙(이모지 금지, 핵심 내용 파악 등)을 바꿀 때마다 올린다.
// 예전 버전으로 만들어둔 결과는 업데이트해도 파일에 남아 재사용되므로, 여기서 버전이 다르면
// "없는 것"으로 취급해 다시 만들게 한다 (사용자가 일일이 [다시 만들기]를 누를 필요 없이).
const PROMPT_VERSION = 8;

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
function clipPost(t, max = 4500) {
  if (t.length <= max) return t;
  return t.slice(0, 3200) + "\n(… 중간 생략 …)\n" + t.slice(-1200);
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
          const result = extractJson(await askClaude(buildPrompt(batch, cache.myComments || []), { timeoutMs: 240000 }));
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
              const again = extractJson(await askClaude(buildPrompt(retry, cache.myComments || [], true), { timeoutMs: 240000 }));
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
      await Promise.all(Array.from({ length: Math.min(3, batches.length) }, worker));
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
    (stricter ? `★ 지난번 답은 본문의 구체적인 내용이 거의 안 들어간 일반적인 문장이었어. 이번에는 아래 "구체적인 단어"를 문장 속에 자연스럽게 최소 2개 이상 넣어서, 그 글을 실제로 읽은 사람만 쓸 수 있는 댓글로 써줘.\n\n` : "") +
    `작업 순서 (반드시 이 순서로 생각해줘, 단 생각한 내용은 출력하지 말고 최종 댓글만 출력):\n` +
    `1. "글 본문"(또는 "내가 그 글에 쓴 내용")을 끝까지 읽고, 글쓴이가 진짜 하고 싶은 말(핵심 주장·결론·깨달음·팁)을 한 문장으로 정리해.\n` +
    `2. 본문에 실제로 나온 구체적인 디테일을 3~5개 뽑아둬: 고유명사(지명·가게·제품·이름), 숫자(가격·시간·횟수), 방법·순서, 글쓴이가 겪은 일, 인상적인 표현이나 결론.\n` +
    `3. 그중 1~2개를 골라 댓글 속에서 직접 짚어. 본문에 없는 내용은 절대 지어내지 마.\n\n` +
    `댓글 형식 (이웃 글에 남기는 댓글): 항목마다 예시 2개.
` +
    `먼저 글을 아래 3가지 유형 중 하나로 정확히 분류하고(분류는 출력하지 말고), 유형에 맞는 톤으로 쓴다.
` +
    `  · [후기형] 감성·일상, 책/영화/장소 방문 후기 등 감상 중심의 글: 글쓴이가 느낀 감정이나 인상 깊은 핵심 문장을 자연스럽게 인용하며 깊이 공감하는 톤 (예: "~라는 구절이 와닿았네요", "~한 감정이 고스란히 전해져요")
` +
    `  · [제품 추천형] 특정 물건·화장품·전자기기·내돈내산/협찬 등 제품 리뷰·추천 글: 리뷰한 제품의 특정 장점·기능·디자인을 콕 집어 칭찬하거나 궁금증을 더하는 톤 (예: "~ 기능이 특히 유용해 보이네요", "저도 요 제품 궁금했는데 꼼꼼한 리뷰 덕분에 참고가 되었어요")
` +
    `  · [정보형] 유용한 노하우·IT 팁·가이드·지식 전달 중심의 글: 정성 담긴 정보에 감사를 표하고, 실생활에 적용하거나 스크랩해두고 보겠다는 뉘앙스의 톤 (예: "알려주신 꿀팁 메모해두고 꼭 써먹어 볼게요!", "모르던 내용이었는데 덕분에 잘 알아갑니다")
` +
    `공통 규칙: "~했네요", "~더라고요" 같은 자연스러운 해요체, 공백 포함 50자~100자 내외로 간결하게, 영혼 없는 기계적 칭찬("잘 읽고 갑니다")은 절대 금지. 두 예시는 구조와 느낌을 다르게. 이웃끼리 편하게 쓰는 진짜 댓글처럼 자연스럽게: 글에서 인상 깊었던 한두 가지(음식·장소·장면·팁 등)를 내 말로 풀어서 짚고, 그에 대한 내 느낌이나 짧은 질문을 이어줘. 글의 문장을 길게 따옴표로 옮겨 오지 마(꼭 필요하면 10자 안팎 짧은 구절만). 가격·숫자는 글에서 정말 눈에 띄는 경우에만 자연스럽게 한 번 언급하고, "수치까지 알려주셔서", "이 부분이 제일 인상 깊었어요", "참고해볼게요", "도움 많이 됐어요 감사합니다" 같은 틀에 박힌 문장은 쓰지 마. 두 댓글이 같은 문장 틀로 시작하지 않게. 본문에 없는 내용·숫자는 지어내지 마.

` +
    `금지 (이런 문장은 쓰지 마):\n` +
    `- "가볼게요", "가보고 싶어요"로 끝나는 문장, "잘 보고 갑니다", "유익한 정보 감사해요", "기대할게요", "응원합니다", "정리가 깔끔하네요" 같이 어느 글에나 붙는 인사.\n` +
    `- 이모지·이모티콘·특수 장식 기호(💕, 😊, 🙏, ".ᐟ.ᐟ" 같은 것). 순수 텍스트만.\n` +
    `- 과한 칭찬, 광고·홍보 멘트, 내 블로그 홍보.\n\n` +
    `답글 형식 (내 글에 달린 댓글에 다는 답글): 항목마다 예시 2개, 각 1~2문장, 70자 안팎. 상대가 쓴 댓글 문장을 그대로 따라 쓰거나 인용하지 마. 찾아와서 읽고 댓글 남겨주셔서 감사하다는 마음을 전하되, 내 글에 나온 숫자·가격·방법 같은 구체적인 정보를 하나 짚어서 "도움이 됐다니 기쁘다"는 식으로 답해. 두 예시의 느낌을 다르게. 금지 사항은 위와 같아.

` +
    blocks.join("\n\n") +
    `\n\n대괄호 안의 키를 그대로 써서 다음 JSON 형식으로만 답해 (분석·메모는 출력하지 말고 최종 댓글만):\n{"<키>": ["예시1", "예시2"], ...}`
  );
}

module.exports = { generate, getState, readSuggestions, fetchPostTextOf: fetchPostText, _test: { buildPrompt, fetchPostText, isGood, filterGood, bodySpecifics, BANNED } };
