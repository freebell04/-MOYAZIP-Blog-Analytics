// 블로거마다 다른 "내 블로그 글 형식"을 저장하고, AI 요청문에 반영한다.
//
// - 분석: 내 블로그 최근 글 몇 개를 가져와 AI에게 형식(말투·구성·도입/마무리·제목 짓는 법)을 JSON으로 뽑게 한다
// - 저장: data/blog-format.json (사람마다 자기 컴퓨터에만 저장됨)
// - 사용: 글감으로 초안을 쓸 때 요청문이 이 형식을 따르게 한다. 저장된 게 없으면 기본 형식.
const path = require("path");
const fs = require("fs");
const config = require("./config");

const FORMAT_PATH = path.join(__dirname, "..", "data", "blog-format.json");

// 저장된 형식이 없을 때 쓰는 기본값.
// 개인판(모야ZIP)은 네이버 '앞으로 쓸 템플릿'에 맞춘 고정 5섹션, 배포판은 누구에게나 맞는 자유 형식.
const DEFAULT_KIND = "free";

// 이 컴퓨터에만 있는 개인 설정 (data 폴더는 GitHub에도 안 올라가고 업데이트로도 안 바뀐다).
//   {"moyazipTemplate": true} → 형식을 따로 저장하지 않았을 때 모야ZIP 템플릿을 기본으로 쓴다 (블로그 주인 컴퓨터에만 둔다)
const OWNER_PATH = path.join(__dirname, "..", "data", "owner.json");
function ownerSettings() {
  try {
    return JSON.parse(fs.readFileSync(OWNER_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function getSaved() {
  try {
    return JSON.parse(fs.readFileSync(FORMAT_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function isValidFormat(f) {
  return !!(f && typeof f === "object" && Array.isArray(f.sections) && f.sections.length && f.sections.every((s) => s && (s.heading || s.guide)));
}

function save(format) {
  if (!isValidFormat(format)) throw new Error("형식이 올바르지 않아요. sections(소제목 목록)가 있어야 해요.");
  const f = { ...format, savedAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(FORMAT_PATH), { recursive: true });
  fs.writeFileSync(FORMAT_PATH, JSON.stringify(f, null, 2));
  return f;
}

function clear() {
  if (fs.existsSync(FORMAT_PATH)) fs.unlinkSync(FORMAT_PATH);
}

/** 앱 화면에 보여줄 현재 형식 정보. useTemplate: 네이버 '앞으로 쓸 템플릿'을 적용할지 */
/** 이 컴퓨터에서 "내 템플릿(앞으로 쓸 템플릿)으로 바로 쓰기"가 켜져 있는지 (data/owner.json 의 {"myTemplate": true} — 다른 사람에게는 화면에 나타나지 않는다) */
const myTemplateOn = () => !!ownerSettings().myTemplate;

function describe() {
  const saved = getSaved();
  if (saved) return { kind: "saved", name: saved.formatName || "내 블로그 형식", format: saved, useTemplate: false };
  if (DEFAULT_KIND === "moyazip" || ownerSettings().moyazipTemplate) return { kind: "moyazip", name: "모야ZIP 형식 (기본)", format: null, useTemplate: false }; // 네이버 템플릿은 안 불러오고 빈 글쓰기 화면에 바로 쓴다
  return { kind: "free", name: "자유 형식 (기본)", format: null, useTemplate: false };
}

// ---------------------------------------------------------------------------
// 분석용: 내 최근 글 가져오기 (문단 구조를 살려서)
// ---------------------------------------------------------------------------
function decode(s) {
  return s
    .replace(/&nbsp;|&#x200B;|​/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;|&#0?34;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&");
}

async function fetchPostStructured(blogId, logNo) {
  const res = await fetch(`https://m.blog.naver.com/PostView.naver?blogId=${blogId}&logNo=${logNo}`, {
    headers: { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
    signal: AbortSignal.timeout(10000),
  });
  const html = await res.text();
  const i = html.indexOf("se-main-container");
  const body = (i >= 0 ? html.slice(i) : html).split(/<div class="(?:post_footer|se_tag|comment)/)[0];
  return decode(
    body
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "")
      .replace(/<img[^>]*>/g, "\n[이미지]\n")
      .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr)[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  )
    .replace(/^se-main-container">/, "")
    .split(/\{"title":/)[0]
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .filter((l, idx, arr) => l || (arr[idx - 1] || "").trim()) // 빈 줄은 하나만
    .join("\n")
    .replace(/(\[이미지\]\n?){2,}/g, "[이미지 여러 장]\n")
    .trim()
    .slice(0, 3500);
}

async function fetchOwnSamples(count = 3) {
  const blogId = config.blogId();
  const res = await fetch(`https://rss.blog.naver.com/${blogId}.xml`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`내 블로그 글 목록을 못 가져왔어요 (HTTP ${res.status}). 블로그 아이디를 확인해주세요.`);
  const xml = await res.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const tag = (k) => decode(((m[1].match(new RegExp(`<${k}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${k}>`)) || [])[1] || "").trim());
    const link = tag("link").replace(/\?.*$/, "");
    return { title: tag("title"), logNo: (link.match(/\/(\d+)$/) || [])[1] };
  });
  const out = [];
  for (const it of items) {
    if (out.length >= count || !it.logNo) break;
    const text = await fetchPostStructured(blogId, it.logNo).catch(() => "");
    if (text.length > 200) out.push({ title: it.title, text }); // 너무 짧은 글(사진만 있는 글 등)은 건너뜀
  }
  if (!out.length) throw new Error("분석할 만한 글을 찾지 못했어요. 글이 공개 상태인지 확인해주세요.");
  return out;
}

const FORMAT_SCHEMA =
  '{"formatName": "형식 이름(예: 리뷰형 5단 구성)", "titleStyle": "제목 짓는 방식", "tone": "말투·문체 특징", ' +
  '"intro": "글 시작하는 방식", "sections": [{"heading": "소제목(또는 그 자리의 역할)", "guide": "이 부분에 무엇을 어떻게 쓰는지"}], ' +
  '"ending": "글 마무리하는 방식", "rules": ["자주 쓰는 표현·이모지·줄바꿈·강조 습관 등"]}';

function buildAnalyzePrompt(samples) {
  return [
    // 블로그 이름(닉네임)과 아이디를 넣는다. 이름을 아직 안 정했으면(기본값 "내 블로그") 아이디만 쓴다
    (() => {
      const nm = String(config.blogName() || "").trim();
      const id = String(config.blogId() || "").trim();
      const who = nm && nm !== "내 블로그" ? `"${nm}"${id ? `(블로그 아이디: ${id})` : ""}` : id ? `"${id}"` : "내";
      return `아래는 네이버 블로그 ${who}님이 실제로 올린 최근 글 ${samples.length}개야. 이 블로거가 글을 어떤 형식으로 쓰는지 분석해줘.`.replace("블로그 내님이", "내 블로그에");
    })(),
    "",
    "분석할 것: 제목 짓는 방식, 말투·문체, 글 시작(도입) 방식, 본문 구성(소제목 순서와 각 부분에 쓰는 내용), 마무리 방식, 자주 쓰는 표현·이모지·줄바꿈·강조 습관.",
    "글마다 조금씩 달라도, 여러 글에 공통으로 반복되는 뼈대를 뽑아줘. 특정 글의 주제 내용(상품명·장소 등)은 넣지 말고 '형식'만 일반화해.",
    "",
    "먼저 분석 결과를 사람이 읽기 좋게 짧게 설명해주고, 마지막에 아래 JSON 형식 그대로 코드블록 하나로 출력해. (프로그램에 저장할 거라 형식이 중요해)",
    FORMAT_SCHEMA,
    "",
    ...samples.map((s, i) => `\n[글 ${i + 1}] ${s.title}\n${s.text}`),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 글쓰기 요청문 (ChatGPT/Gemini/Claude 채팅용)
// ---------------------------------------------------------------------------
// 에디터에 옮길 때 소제목은 인용구(굵게), 섹션 사이는 구분선으로 꾸며지고,
// 본문의 **굵게** 는 굵은 글씨, "- " 줄은 • 목록 줄로 바뀐다 → AI가 그 표시를 쓰도록 안내
const READABILITY_RULES = [
  "- 본문(sections)은 모바일에서 읽기 좋게 1~2문장마다 줄바꿈(JSON 문자열 안에서는 \\n)해서 짧은 줄로 써줘",
  "- 섹션마다 가장 중요한 문장이나 단어 1~2곳은 **굵게** 표시(별표 두 개로 감싸기)",
  "- 나열할 게 있으면 줄 앞에 '- '를 붙여 목록으로 (예: \"- 롯데시네마: 아트카드\")",
];

const MOYAZIP_RULES = [
  "- introLines: 글 맨 위 3줄 요약, 각 5~15자",
  "- sectionHeadingLines: 섹션별 소제목 줄 수가 정해져 있음 → 1번 3줄, 2번 4줄, 3번 1줄, 4번 3줄, 5번 1줄 (각 5~15자)",
  "- sections 5개: 1 개요/스펙 소개, 2 어떤 사람·상황에 유용한지, 3 Before→After, 4 사용법·활용법, 5 총평·앞으로 계획 (각 2~5문장)",
];
const MOYAZIP_SCHEMA =
  '{"title": "블로그 제목", "introLines": ["줄1","줄2","줄3"], ' +
  '"sectionHeadingLines": [["1-1","1-2","1-3"], ["2-1","2-2","2-3","2-4"], ["3-1"], ["4-1","4-2","4-3"], ["5-1"]], ' +
  '"sections": ["1번 섹션 본문","2번 섹션 본문","3번 섹션 본문","4번 섹션 본문","5번 섹션 본문"]}';

function formatRules(f) {
  const lines = [];
  if (f.titleStyle) lines.push(`- 제목: ${f.titleStyle}`);
  if (f.tone) lines.push(`- 말투·문체: ${f.tone}`);
  if (f.intro) lines.push(`- 도입: ${f.intro} (introLines에 도입부 문장들을 넣어줘)`);
  lines.push(`- 본문은 아래 ${f.sections.length}개 부분으로 구성 (sections 배열도 이 순서·개수 그대로):`);
  f.sections.forEach((s, i) => lines.push(`  ${i + 1}. ${s.heading || ""}${s.guide ? " — " + s.guide : ""}`));
  if (f.ending) lines.push(`- 마무리: ${f.ending} (마지막 섹션에 포함)`);
  (f.rules || []).forEach((r) => lines.push(`- ${r}`));
  return lines;
}

// 스타일 가이드 파일이 처음 받은 빈 틀 그대로면(제목·안내문·빈 칸만 있으면) 요청문에 넣지 않는다 — AI만 헷갈린다
function meaningfulStyleGuide(text) {
  const body = (text || "")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l)) // 제목 줄
    .filter((l) => !/이 파일 내용은|프롬프트에 그대로|톤\/문체 설명을 적거나|통째로 붙여넣어|더 정확하게 따라합니다/.test(l)) // 안내문
    .map((l) => l.replace(/^\s*[-*]\s*$/, "").trim())
    .filter(Boolean)
    .join("\n");
  return body.length >= 20 ? text.trim() : "";
}

// 최종 JSON에 "각 소제목(챕터) 바로 아래에 넣을 이미지"의 검색어와 블로그 키워드 태그를 함께 받는다.
// 프로그램이 그 검색어로 크롬에서 이미지 검색을 열어주고, 사용자가 이미지를 클릭하면 자동으로 복사해 준다 (링크·img 태그는 필요 없다).
const IMAGE_TAG_RULES = [
  "이미지 검색어도 JSON에 같이 넣어줘. 각 소제목(챕터) 바로 아래에 넣을 이미지를 sections 순서대로 하나씩, 아래 3개 배열에 넣어줘 (개수는 sections와 같게).",
  "- sectionImageKeywords: 그 챕터 내용과 글 주제 키워드를 함께 담은 한국어 이미지 검색어 (2~4단어). 네이버·구글 이미지 검색에 그대로 넣으면 어울리는 사진이 나오게 구체적으로. 예: 제주 흑돼지 맛집 한상차림",
  "- sectionImageTags: 같은 이미지를 무료 사진 사이트에서 찾을 영어 검색 태그 (2~3단어). 예: jeju black pork, korean bbq",
  "- sectionImageNotes: 그 자리에 어떤 이미지가 들어가면 좋은지 한국어 한 줄 설명. 예: 지글지글 구워지는 흑돼지 고기 클로즈업",
  "- 각 이미지는 그 챕터의 내용과 글 주제, 글 형식을 함께 고려해서, 사람들이 좋아할 만한 사진이 나오도록 검색어를 잡아줘. 챕터마다 서로 다른 사진이 나오게 해줘. (이미지 링크나 img 태그는 필요 없어. 내가 검색어로 직접 고를 거야)",
  "- tags: 이 글에 달 블로그 키워드 태그 5~10개 (# 없이 단어만).",
  "- JSON 문자열 안에서 줄을 바꿀 때는 \\n 을 한 번만 써 (\\\\n 처럼 두 번 이스케이프하지 마). 본문에 \\n 글자가 그대로 보이면 안 돼.",
  "- placeName: 글의 중심이 카페·식당·매장·관광지 같은 특정 장소라면 그 장소 이름(지점명 포함, 예: 카페인24 강남점). 장소가 중심이 아니면 빈 문자열.",
  "[장소 글 규칙] placeName이 있으면: (1) 첫 번째 섹션은 반드시 위치 정보(주소, 찾아가는 방법·가까운 역, 영업시간, 주차)로 맨 위에 둬. 확실하지 않은 정보는 지어내지 말고 [여기에 직접 입력]으로 남겨. (2) sectionImageKeywords는 모두 '장소 이름 + 그 챕터 소제목의 핵심 단어' 형식으로 써줘. 예: 카페인24 강남점 외관, 카페인24 강남점 메뉴, 카페인24 강남점 주차.",
];
function withExtras(schemaStr) {
  try {
    const o = JSON.parse(schemaStr);
    const n = Array.isArray(o.sections) ? o.sections.length : 3;
    o.sectionImageKeywords = Array.from({ length: n }, (_, i) => `${i + 1}번 챕터 한국어 이미지 검색어, 예: 성수 브런치 카페 디저트`);
    o.sectionImageTags = Array.from({ length: n }, (_, i) => `${i + 1}번 챕터 영어 검색 태그, 예: brunch cafe dessert`);
    o.sectionImageNotes = Array.from({ length: n }, (_, i) => `${i + 1}번 챕터에 들어갈 이미지 설명 한 줄`);
    o.tags = ["키워드1", "키워드2", "키워드3"];
    o.placeName = "특정 장소(카페·식당 등)가 글의 중심이면 그 이름, 아니면 빈 문자열";
    return JSON.stringify(o);
  } catch {
    return schemaStr;
  }
}

function buildPostPrompt(data, opts = {}) {
  // 내 템플릿 요청(내 블로그 글 형식 칸의 AI 버튼)이고 이 컴퓨터에서 켜져 있을 때만 내 템플릿 구조로 쓴다. 그 밖(AI와 대화하면서 글쓰기 등)은 원래 형식 그대로
  const d = opts.myTemplate && myTemplateOn() ? { kind: "mytpl", name: "내 템플릿 (앞으로 쓸 템플릿)", format: null, useTemplate: true } : describe();
  let rules, schema;
  if (d.kind === "mytpl") {
    rules = [
      "- 원문 문장을 베끼지 말고 새로 쓸 것", ...READABILITY_RULES,
      "- 내 네이버 블로그 템플릿(앞으로 쓸 템플릿)의 자리에 그대로 채워 넣을 거라서, 아래 JSON 구조와 글자 수를 정확히 지켜줘.",
      "- title: 블로그 제목 (한 줄)",
      "- intro: 인트로 글 (3~5문장. 줄을 바꾸려면 \\n 한 번만 써서 문단을 나눠)",
      "- shortHeading: 짧은 소제목 (인트로 아래에 들어갈 한 줄, 15자 안팎)",
      "- topicLine: 이번 주제에 대한 한 줄 (목차 표 맨 위 \"주제\" 칸에 들어감)",
      "- sections: 정확히 6개 (본문 블록 ①~⑥). 각각 title(본문 제목, 짧게) / short(짧은 본문, 한 줄) / keyword(소제목: 핵심 키워드 딱 1개) / explain(소제목에 대한 설명, 3~5문장).",
      "- 표(도표)가 필요하면 explain 안에 마크다운 표로 써줘 (| 칸 | 칸 | 한 줄씩, 둘째 줄은 |---|---|). 표 앞뒤는 빈 줄로 띄워. 표는 에디터에 진짜 표로 들어가.",
      "- tocLines: 정확히 5개 — 목차 표 ①~⑤ 칸에 들어갈 본문 내용 한 줄씩 (섹션 1~5에 해당)",
      "- summaryLines: 정확히 5개 — 요약 표 1~5 칸에 들어갈 한 줄 요약 (섹션 1~5에 해당)",
      "- reflection: 소중한 기록 \"소감\" (2~3문장, 솔직한 느낌)",
    ];
    schema = JSON.stringify({
      title: "블로그 제목",
      intro: "인트로 글",
      shortHeading: "짧은 소제목",
      topicLine: "이번 주제에 대한 한 줄",
      sections: Array.from({ length: 6 }, (_, i) => ({ title: `${i + 1}번 본문 제목`, short: "짧은 본문 한 줄", keyword: "소제목 키워드 1개", explain: "소제목에 대한 설명" })),
      tocLines: ["①번 내용 한 줄", "②번 내용 한 줄", "③번 내용 한 줄", "④번 내용 한 줄", "⑤번 내용 한 줄"],
      summaryLines: ["1번 한 줄 요약", "2번 한 줄 요약", "3번 한 줄 요약", "4번 한 줄 요약", "5번 한 줄 요약"],
      reflection: "소감",
    });
  } else if (d.kind === "saved") {
    const n = d.format.sections.length;
    rules = ["- 원문 문장을 베끼지 말고 새로 쓸 것", ...READABILITY_RULES, ...formatRules(d.format)];
    schema = JSON.stringify({
      title: "블로그 제목",
      introLines: ["도입 문장1", "도입 문장2"],
      sectionHeadingLines: Array.from({ length: n }, (_, i) => [`${i + 1}번 소제목`]),
      sections: Array.from({ length: n }, (_, i) => `${i + 1}번 섹션 본문`),
    });
  } else if (d.kind === "moyazip") {
    rules = ["- 원문 문장을 베끼지 말고 새로 쓸 것", ...READABILITY_RULES, ...MOYAZIP_RULES];
    schema = MOYAZIP_SCHEMA;
  } else {
    rules = [
      "- 원문 문장을 베끼지 말고 새로 쓸 것", ...READABILITY_RULES,
      "- introLines: 글 시작 도입 1~3문장",
      "- 본문은 내용에 맞게 3~6개 부분으로 나누고, 부분마다 소제목(sectionHeadingLines)과 본문(sections)을 써줘",
      "- 마지막 부분은 정리·마무리로",
    ];
    schema =
      '{"title": "블로그 제목", "introLines": ["도입 문장1","도입 문장2"], "sectionHeadingLines": [["1번 소제목"], ["2번 소제목"], ["3번 소제목"]], ' +
      '"sections": ["1번 섹션 본문","2번 섹션 본문","3번 섹션 본문"]}';
  }
  return [
    "너는 프로 블로거야. 좋은 정보를 올리고, 동시에 사람들이 궁금해할 만한 후기나 정보를 알차게 올려주는 역할이지.",
    // 블로그 이름을 아직 안 정했으면(기본값 "내 블로그") 이름 없이 "내 블로그 초안"으로 쓴다
    (() => {
      const nm = String(data.blogName || "").trim();
      const who = nm && nm !== "내 블로그" ? `"${nm}" 블로그` : "내 블로그";
      return data.items.length ? `아래 글감으로 ${who} 초안을 나와 같이 쓸 거야.` : `아래 키워드로 ${who} 초안을 나와 같이 쓸 거야. (참고할 글감이 없는 주제야)`;
    })(),
    "알차고 많은 정보를 잘 만들어 줘. 글 형식에 맞게 네가 알맞게 글을 배치해줘.",
    "",
    "★ 가장 중요한 규칙: 내가 정확히 \"완성\"이라고 보내기 전까지는 절대 JSON(완성본 코드블록)을 출력하지 마. 주제나 방향을 골랐다고 바로 JSON으로 바꾸지 말고, 초안을 보여준 뒤에도 내가 \"완성\"이라고 하기 전에는 계속 수정 요청을 기다려줘.",
    "",
    "진행 순서 (꼭 지켜줘):",
    ...(data.items.length
      ? ["1) 바로 쓰지 말고, 글감의 핵심을 2줄로 요약한 뒤 주제·방향·제목 후보 3개를 번호로 제안하고 내가 고를 때까지 기다려."]
      : [
          "1) 참고할 글감이 없어. 바로 쓰지 말고, 이 주제로 글을 쓰려면 필요한 정보를 내게 먼저 질문해줘 (최대 5개, 한 번에 보여줘): 대상(장소·제품·지점) 정보, 내가 직접 겪은 경험, 가격·시간 같은 숫자, 좋았던 점·아쉬웠던 점, 독자가 궁금해할 점.",
          "   내가 답한 사실만 쓰고, 모르는 정보는 지어내지 말고 [여기에 직접 입력] 빈칸으로 남겨. 그다음 주제·방향·제목 후보 3개를 번호로 제안하고 내가 고를 때까지 기다려.",
        ]),
    "2) 내가 고르면 초안을 읽기 좋게 (JSON이 아니라 일반 글로) 보여주고, 수정 요청을 반영해줘. 이 단계에서는 JSON을 만들지 마.",
    '3) 내가 "완성"이라고 하면 그때 처음으로, 최종본을 아래 JSON 형식 그대로 코드블록 하나로만 출력해. (프로그램에 붙여넣을 거라 형식이 중요해) 표(도표)가 필요한 곳은 본문 안에 마크다운 표(| 칸 | 칸 |, 둘째 줄 |---|---|)로 써줘 — 프로그램이 에디터에 진짜 표로 만들어 줘.',
    withExtras(schema),
    "",
    ...IMAGE_TAG_RULES,
    "",
    `글 형식 규칙 (${d.name}):`,
    ...rules,
    meaningfulStyleGuide(data.styleGuide) && d.kind !== "saved" ? `\n[이 블로그 말투·스타일 가이드]\n${data.styleGuide.trim()}` : "",
    "",
    `[검색 키워드] ${data.keyword}`,
    ...(data.context
      ? [
          `[글 주제 방향] ${data.context.title}`,
          ...(data.context.questions.length ? ["[이 글에서 꼭 답해줬으면 하는 질문]", ...data.context.questions.map((q) => `- ${q}`)] : []),
          ...(data.context.refs.length ? ["[참고: 이웃 블로거들이 최근 쓴 글 (내용은 베끼지 말고 어떤 주제가 인기인지 참고만)]", ...data.context.refs.map((r) => `- ${r.nick ? r.nick + " · " : ""}${r.title}`)] : []),
        ]
      : []),
    ...data.items.map(
      (it, i) => `\n[글감 ${i + 1}] ${it.title}\n링크: ${it.link}\n${(it.text || it.snippet || "(본문을 못 가져왔어요 — 링크 참고)").slice(0, 2500)}`
    ),
    "",
    '마지막으로, 위 진행 순서(방향 확인 → 초안 → "완성")를 거쳐 최종본이 되면 json 형식으로 만들어줘.',
  ].join("\n");
}

module.exports = { myTemplateOn, getSaved, save, clear, describe, isValidFormat, fetchOwnSamples, buildAnalyzePrompt, buildPostPrompt };
