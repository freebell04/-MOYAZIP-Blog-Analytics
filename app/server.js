const express = require("express");
const path = require("path");
const fs = require("fs");

// 백그라운드로 돌리는 작업(이웃 새로고침, 공감 감지 등)에서 미처 못 잡은 에러가 하나라도 있으면
// Node가 기본적으로 서버 프로세스 전체를 종료시킨다. 사용자 입장에서는 "로그인 버튼을 눌렀더니
// 서버가 통째로 죽었다"처럼 보이므로, 여기서 끝까지 잡아 로그만 남기고 서버는 계속 띄워둔다.
process.on("unhandledRejection", (err) => {
  console.error("[처리되지 않은 오류 — 서버는 계속 실행됩니다]", err);
});
process.on("uncaughtException", (err) => {
  console.error("[처리되지 않은 예외 — 서버는 계속 실행됩니다]", err);
});

const { askClaude, extractJson, openLoginWindow } = require("./lib/claude");
const session = require("./lib/session");
const { searchNaver, searchGrouped, fetchArticleText } = require("./lib/scraper");
const { findAndJudgeImages } = require("./lib/images");
const { saveDraftToNaver, finalizeTocAndSummary, openTemplateEditor } = require("./lib/blogEditor");
const neighbors = require("./lib/neighbors");
const suggest = require("./lib/suggest");
const like = require("./lib/like");
const stats = require("./lib/stats");
const notion = require("./lib/notion");
const config = require("./lib/config");
const aiChat = require("./lib/aiChat");
const blogFormat = require("./lib/blogFormat");
// 이웃들이 요즘 쓰는 글로 주제 추천 (이웃 소통 화면의 '주제 추천' 탭)
const trendsLib = require("./lib/trends");
// 성과 통계 + 이웃 트렌드 추천을 합친 데이터 (통계 화면·엑셀·노션 리포트에 쓴다)
const trendsFor = (d) => (d && trendsLib ? trendsLib.buildTrends(d, neighbors.getCached()) : null);
const statsWithTrends = (d) => (trendsLib ? trendsLib.withTrendIdeas(d, trendsFor(d)) : d);
const { buildWeekly, buildMonthly, buildMemoOnly, memoBlocks, MEMO_HEADING, memoHeading } = require("./lib/notionReport");

/**
 * 주간 회고를 노션에 반영한다.
 * - 그 주 리포트를 노션에 저장한 적이 있으면: 그 페이지의 "✍️ 회고" 부분만 새 내용으로 교체
 * - 없으면: 지난주면 전체 주간 리포트를, 더 예전 주면 숫자+회고만 담은 짧은 페이지를 새로 만든다
 */
async function syncMemoToNotion(rec) {
  // 이 메모는 바로 앞 주(지난주) 리포트에도 "이어지는 주 메모"로 보여준다 → 그 리포트가 노션에 있고 그 주 회고가 비어 있으면 같이 갱신
  const prevWeek = require("./lib/notionReport").addDays(rec.week, -7);
  const prevEntries = (notion.getLog()[`week:${prevWeek}`] || []).filter((e) => e.pageId);
  const prevLast = prevEntries[prevEntries.length - 1];
  if (prevLast) {
    try {
      await notion.replaceSection(prevLast.pageId, MEMO_HEADING, require("./lib/notionReport").memoSectionBlocks(stats.getHistory(), prevWeek), memoHeading());
    } catch {} // 지난주 리포트 갱신 실패는 이번 주 회고 저장에 영향 없음
  }
  const entries = (notion.getLog()[`week:${rec.week}`] || []).filter((e) => e.pageId);
  const last = entries[entries.length - 1];
  if (last) {
    try {
      const action = await notion.replaceSection(last.pageId, MEMO_HEADING, memoBlocks(rec.memo), memoHeading());
      return { action, url: last.url, title: last.title };
    } catch (e) {
      if (!e.pageGone) throw e; // 페이지가 지워졌으면 아래에서 새로 만든다
    }
  }
  const d = stats.getCached();
  const report = d && d.lastWeek === rec.week ? buildWeekly(statsWithTrends(d), { goals: stats.getGoals(), history: stats.getHistory() }) : buildMemoOnly(rec);
  const saved = await notion.saveReport(report);
  return { action: "created", url: saved.url, title: saved.title };
}
const { buildWorkbook } = require("./lib/statsExcel");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10mb" }));

// --- 사용 키 (체험단·구매자용). 키는 별도의 체험단 관리자 프로그램이 만든다 ---
const license = require("./lib/license");
app.get("/api/license", (req, res) => res.json({ ...license.status(), trial: license.trialAvailable(), trialUrl: license.TRIAL_URL }));
app.post("/api/license/trial", async (req, res) => {
  const r = await license.startTrial(req.body || {});
  res.status(r.ok ? 200 : 400).json(r);
});
app.post("/api/license", (req, res) => {
  const r = license.activate((req.body || {}).key);
  res.status(r.ok ? 200 : 400).json(r);
});
// 키가 없거나 기간이 끝났으면 모든 화면을 키 입력 화면으로 보낸다
app.use((req, res, next) => {
  if (req.path === "/license.html" || req.path.startsWith("/api/license") || /\.(css|js|png|ico|svg)$/.test(req.path)) return next();
  const st = license.status();
  if (st.ok) return next();
  if (req.path.startsWith("/api/")) return res.status(402).json({ error: st.reason, license: st });
  res.redirect("/license.html");
});

// --- 처음 실행: 블로그 아이디 설정 ---
app.get("/api/setup", (req, res) => {
  res.json({ configured: config.isConfigured(), blogId: config.blogId(), blogName: config.blogName() });
});
app.post("/api/setup", (req, res) => {
  try {
    const saved = config.save(req.body || {});
    res.json({ ok: true, ...saved, restarting: true });
    // 모든 모듈이 시작할 때 블로그 아이디를 읽어서, 저장 후 재시작한다 (실행하기.bat이 다시 켜줌: 종료 코드 3)
    setTimeout(() => process.exit(3), 300);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 아직 설정 전이면 모든 화면을 설정 화면으로 보낸다
app.use((req, res, next) => {
  // 키 입력 화면은 설정 전에도 열려야 한다 (새 설치: 키 → 설정 순서. 여기서 막으면 서로 리디렉션하며 무한 반복된다)
  if (config.isConfigured() || req.path === "/setup.html" || req.path === "/license.html" || req.path.startsWith("/api/setup") || req.path.startsWith("/api/license") || /\.(css|js|png|ico|svg)$/.test(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(400).json({ error: "먼저 블로그 아이디를 설정해주세요." });
  res.redirect("/setup.html");
});

// 업데이트해도 브라우저가 예전 html/js/css를 계속 쓰는 일이 없게, 매번 서버에 새로운지 확인하게 한다
// (완전히 캐시를 꺼버리진 않는다 — 안 바뀐 파일은 304로 빠르게 응답되니 느려지지 않는다)
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (res) => res.setHeader("Cache-Control", "no-cache") }));
app.use("/images", express.static(path.join(__dirname, "data", "images")));

// --- 로그인 세션 ---
app.get("/api/session-status", (req, res) => {
  const watch = session.getLoginWatchState();
  res.json({ loggedIn: session.hasSession(), watching: watch.watching, watchError: watch.error });
});

app.post("/api/login", async (req, res) => {
  try {
    const result = await session.startLoginWatch();
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/logout", (req, res) => {
  session.clearSession();
  res.json({ success: true });
});

// --- 글감 수집 ---
app.post("/api/search", async (req, res) => {
  const { keyword } = req.body;
  if (!keyword) return res.status(400).json({ error: "keyword가 필요합니다." });
  try {
    // round/exclude가 오면 "다시 찾기": 이미 보여준 글은 빼고 다음 글·다른 검색어로 새로 찾는다
    const round = Math.max(0, Math.min(50, Number(req.body.round) || 0));
    const exclude = Array.isArray(req.body.exclude) ? req.body.exclude.slice(0, 500).map(String) : [];
    const hints = req.body.ctx && Array.isArray(req.body.ctx.titles) ? { titles: req.body.ctx.titles.slice(0, 8) } : {};
    res.json(await searchGrouped(String(keyword).trim().slice(0, 100), round, exclude, hints));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 선택한 글감으로 재작성 ---
app.post("/api/generate", async (req, res) => {
  const { keyword, selected } = req.body; // selected: [{title, link}]
  if (!selected || !selected.length) return res.status(400).json({ error: "selected 글감이 필요합니다." });

  try {
    const sources = [];
    for (const item of selected) {
      const text = await fetchArticleText(item.link).catch(() => "");
      sources.push({ title: item.title, url: item.link, text });
    }

    const styleGuidePath = path.join(__dirname, "style-guide.md");
    const styleGuide = fs.existsSync(styleGuidePath) ? fs.readFileSync(styleGuidePath, "utf-8").trim() : "";

    const prompt =
      `아래는 "${keyword}" 관련 뉴스/블로그 원문 발췌야.\n\n` +
      sources.map((s, i) => `[자료 ${i + 1}] ${s.title}\n${s.text}`).join("\n\n---\n\n") +
      `\n\n위 자료들을 참고해서(표절/복사 금지, 문장은 새로 써서) 네이버 블로그 글을 작성해줘.\n` +
      (styleGuide
        ? `\n다음은 이 블로그(${require("./lib/config").blogName()})의 글쓰기 스타일 가이드야. 말투/문장 습관을 최대한 이 스타일에 맞춰줘:\n"""\n${styleGuide}\n"""\n`
        : "\n- 친근한 구어체 톤으로 써줘\n") +
      `\n이 블로그는 항상 아래와 같은 고정 틀(템플릿)을 쓰고 있어. 그 틀의 "내용"에 해당하는 부분만 이번 주제("${keyword}")에 맞게 채워줘:\n` +
      `- 제목\n` +
      `- INTRO 3줄 요약 (글 맨 위에 짧게 3줄로 핵심 요약, 각 줄 5~15자 정도)\n` +
      `- 본문은 5개 섹션으로 나뉘어 있고, 각 섹션은 이미 정해진 주제 틀을 갖고 있어:\n` +
      `  1번 섹션 = 개요/스펙 소개\n` +
      `  2번 섹션 = 어떤 사람/상황에 유용한지\n` +
      `  3번 섹션 = Before -> After (사용 전후 비교)\n` +
      `  4번 섹션 = 사용법/활용법\n` +
      `  5번 섹션 = 총평/앞으로 계획\n` +
      `  각 섹션 본문은 2~5문장 정도로 써줘.\n` +
      `- sectionHeadingLines: 각 섹션 번호 바로 아래에 있는 짧은 소제목 영역인데, 섹션마다 줄 수가 이미 정해져 있어.\n` +
      `  1번 섹션 = 3줄, 2번 섹션 = 4줄, 3번 섹션 = 1줄, 4번 섹션 = 3줄, 5번 섹션 = 1줄.\n` +
      `  각 줄은 5~15자 정도의 짧은 문구로, 위에서 아래로 자연스럽게 읽히면서 그 섹션 내용을 압축해서 보여줘야 해\n` +
      `  (예: 1번째 줄은 핵심 키워드, 다음 줄들은 그걸 좀 더 풀어주는 짧은 문구 — 이번 주제 "${keyword}"에 맞게).\n` +
      `- 글 중간에 삽입하면 좋을 이미지 검색어(imageQueries) 3개도 함께 제안\n` +
      `(목차/전체요약 표는 이번 단계에서 만들지 않아 — 본문을 사용자가 검토/수정한 뒤 별도로 채운다.)\n` +
      `다음 JSON 형식으로만 답해:\n` +
      `{"title": "블로그 제목", "introLines": ["줄1","줄2","줄3"], "sectionHeadingLines": [["1번-줄1","1번-줄2","1번-줄3"], ["2번-줄1","2번-줄2","2번-줄3","2번-줄4"], ["3번-줄1"], ["4번-줄1","4번-줄2","4번-줄3"], ["5번-줄1"]], "sections": ["1번 섹션 본문","2번 섹션 본문","3번 섹션 본문","4번 섹션 본문","5번 섹션 본문"], "imageQueries": ["검색어1","검색어2","검색어3"]}`;

    const raw = await askClaude(prompt, { timeoutMs: 240000 });
    const parsed = extractJson(raw);
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message, code: e.code });
  }
});

// --- AI 글쓰기용 Claude(CLI) 로그인 창 열기 (로그인은 사용자가 직접) ---
app.post("/api/claude-login", (req, res) => {
  try {
    openLoginWindow();
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 체크한 글감을 Claude(대화창)에게 넘기기 ---
// 앱 안에서 바로 쓰는 대신, Claude Code 대화창에서 "글감으로 초안 써줘"라고 하면
// Claude가 GET /api/handoff 로 이걸 읽고 → 방향을 물어본 뒤 → 초안을 보여주고 → /api/save-draft 로 임시저장한다.
const HANDOFF_PATH = path.join(__dirname, "data", "handoff.json");
const HANDOFF_GUIDE = [
  "이 파일은 네이버 블로그 도우미에서 사용자가 체크한 글감이다. 이걸로 블로그 초안을 쓰는 순서:",
  "1) 글감(items)의 제목·본문을 읽고, 어떤 주제·방향·제목으로 쓸지 2~3개 안을 짧게 제안해서 사용자에게 먼저 물어본다.",
  "2) 고른 방향으로 초안을 쓴다. styleGuide(이 블로그 말투)를 따르고, 원문 문장을 베끼지 말고 새로 쓴다.",
  "   형식: title, introLines(3줄, 각 5~15자), sectionHeadingLines(섹션별 줄 수 3/4/1/3/1, 각 5~15자),",
  "   sections(5개: 1 개요/스펙, 2 어떤 사람·상황에 유용한지, 3 Before→After, 4 사용법·활용법, 5 총평·앞으로 계획, 각 2~5문장).",
  "3) 초안을 대화창에 먼저 보여주고, 사용자가 OK하면 POST http://localhost:<port>/api/save-draft 에",
  "   {title, introLines, sectionHeadingLines, sections} JSON을 보내 네이버 에디터를 열고 임시저장한다 (같은 글을 고쳐 다시 저장할 땐 continueDraft:true).",
].join("\n");

// 체크한 글감의 본문을 모아 handoff.json으로 저장하고 그 내용을 돌려준다
async function makeHandoff(keyword, selected, context) {
    const items = [];
    for (const it of selected) {
      const text = await fetchArticleText(it.link).catch(() => "");
      items.push({ title: it.title, link: it.link, snippet: it.snippet || "", text: (text || "").slice(0, 4000) });
    }
    const styleGuidePath = path.join(__dirname, "style-guide.md");
    const data = {
      guide: HANDOFF_GUIDE,
      keyword: keyword || "",
      context: context && context.title ? { title: String(context.title).slice(0, 200), questions: (context.questions || []).slice(0, 6).map(String), refs: (context.refs || []).slice(0, 5).map((r) => ({ nick: String(r.nick || ""), title: String(r.title || "") })) } : null,
      savedAt: new Date().toISOString(),
      blogName: config.blogName(),
      styleGuide: fs.existsSync(styleGuidePath) ? fs.readFileSync(styleGuidePath, "utf-8").trim() : "",
      items,
    };
    fs.mkdirSync(path.dirname(HANDOFF_PATH), { recursive: true });
    fs.writeFileSync(HANDOFF_PATH, JSON.stringify(data, null, 2));
    return data;
}

app.post("/api/handoff", async (req, res) => {
  const { keyword, selected, context } = req.body; // selected: [{title, link, snippet}]
  if (!selected || !selected.length) return res.status(400).json({ error: "글감을 하나 이상 체크해주세요." });
  try {
    const data = await makeHandoff(keyword, selected, context);
    res.json({ success: true, count: data.items.length, withText: data.items.filter((x) => x.text).length, prompt: blogFormat.buildPostPrompt(data) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AI 채팅(ChatGPT/Gemini/Claude) 연결: 로그인용 크롬에 채팅 탭을 열고 요청문을 보낸 뒤, 결과 JSON을 자동으로 받아온다 ---
app.post("/api/ai-chat", async (req, res) => {
  const { ai, keyword, selected, context } = req.body;
  if (!aiChat.SITES[ai]) return res.status(400).json({ error: "지원하지 않는 AI예요." });
  if (!selected || !selected.length) return res.status(400).json({ error: "글감을 하나 이상 체크해주세요." });
  try {
    const data = await makeHandoff(keyword, selected, context);
    const prompt = blogFormat.buildPostPrompt(data);
    const st = await aiChat.start(ai, prompt);
    res.json({ success: true, ...st, count: data.items.length, prompt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/ai-chat/status", (req, res) => res.json(aiChat.getState()));

// --- 내 블로그 글 형식: 최근 글로 AI에게 분석받아 저장하고, 초안 요청문에 반영 ---
app.get("/api/format", (req, res) => res.json(blogFormat.describe()));
app.post("/api/format", (req, res) => {
  try {
    const saved = blogFormat.save(req.body);
    res.json({ success: true, ...blogFormat.describe(), savedAt: saved.savedAt });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
app.delete("/api/format", (req, res) => {
  blogFormat.clear();
  res.json({ success: true, ...blogFormat.describe() });
});
app.post("/api/format/analyze", async (req, res) => {
  const { ai } = req.body;
  if (!aiChat.SITES[ai]) return res.status(400).json({ error: "지원하지 않는 AI예요." });
  try {
    const samples = await blogFormat.fetchOwnSamples(3);
    const prompt = blogFormat.buildAnalyzePrompt(samples);
    const st = await aiChat.start(ai, prompt, "format");
    res.json({ success: true, ...st, sampleTitles: samples.map((x) => x.title), prompt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/ai-chat/taken", (req, res) => {
  aiChat.markTaken();
  res.json({ success: true });
});

app.get("/api/handoff", (req, res) => {
  if (!fs.existsSync(HANDOFF_PATH)) return res.status(404).json({ error: "넘겨받은 글감이 없어요. 앱에서 글감을 체크하고 [Claude에게 넘기기]를 눌러주세요." });
  res.type("application/json").send(fs.readFileSync(HANDOFF_PATH, "utf-8"));
});

// --- 이미지 검색 + 적합성 판단 ---
app.post("/api/images", async (req, res) => {
  const { imageQueries, topic } = req.body;
  if (!imageQueries || !imageQueries.length) return res.status(400).json({ error: "imageQueries가 필요합니다." });

  try {
    const results = {};
    for (const q of imageQueries) {
      results[q] = await findAndJudgeImages(q, topic || q);
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 네이버 블로그 임시저장 ---
// title + introLines(3) + sections(5)가 오면 템플릿의 정확한 자리에 채워 넣고,
// 그게 없으면(구버전 호출 호환) title + body를 그냥 통짜로 입력한다.
app.post("/api/save-draft", async (req, res) => {
  const { title, body, introLines, sectionHeadingLines, sections, imagePaths, useTemplate, continueDraft } = req.body;
  if (!title) return res.status(400).json({ error: "title이 필요합니다." });
  if (!body && !sections) return res.status(400).json({ error: "body 또는 sections가 필요합니다." });

  try {
    const result = await saveDraftToNaver({
      title,
      bodyHtml: body,
      introLines,
      sectionHeadingLines,
      sections,
      imagePaths: imagePaths || [],
      useTemplate: useTemplate !== false,
      continueDraft: continueDraft === true,
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- AI 글 생성 없이, 블로그 → 글쓰기 → 템플릿 적용까지만 하고 열어두기 (직접 타이핑용) ---
app.post("/api/open-editor", async (req, res) => {
  try {
    const result = await openTemplateEditor();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 2단계: 저장된(또는 사용자가 직접 고친) 임시글을 열어서 목차+전체요약 채우기 ---
app.post("/api/finalize-toc", async (req, res) => {
  try {
    const result = await finalizeTocAndSummary();
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 이웃 소통: 내 글에 공감/댓글 남긴 사람 모아보기 (답방은 사용자가 직접) ---
// 이웃 소통 화면의 '주제 추천': 이웃들의 최근 글에서 여러 명이 같이 쓰는 주제·키워드
// (성과 통계를 아직 안 불러왔어도 동작한다 — 그땐 '내가 이미 쓴 주제' 비교만 빠진다)
app.get("/api/neighbor-trends", (req, res) => {
  try {
    res.json({ trends: trendsLib.buildTrends(stats.getCached() || { posts: [] }, neighbors.getCached()) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/neighbors", (req, res) => {
  res.json({
    blogId: neighbors.BLOG_ID,
    data: neighbors.getCached(),
    visited: neighbors.getVisited(),
    state: neighbors.getRefreshState(),
    suggestions: suggest.readSuggestions(),
    suggestState: suggest.getState(),
    liked: like.getLiked(),
    // 공감 지켜보기 상태 (page 객체는 빼고 상태만)
    likeWatch: Object.fromEntries(Object.entries(like.getWatches()).map(([k, w]) => [k, { status: w.status, error: w.error }])),
  });
});

app.post("/api/neighbors/refresh", (req, res) => {
  const days = Math.min(Math.max(parseInt(req.body.days, 10) || 7, 1), 30);
  neighbors.refresh({ days }); // 백그라운드 실행, 진행 상황은 GET /api/neighbors의 state로 확인
  res.json({ started: true });
});

app.post("/api/neighbors/visited", (req, res) => {
  const { blogId, logNo, done } = req.body;
  if (!blogId) return res.status(400).json({ error: "blogId가 필요합니다." });
  res.json({ visited: neighbors.setVisited(blogId, logNo || "", done !== false) });
});

// 이웃 글을 새 창으로 열고, 사용자가 직접 공감을 누르는지 지켜본다 (진행은 GET /api/neighbors의 likeWatch)
app.post("/api/neighbors/like", async (req, res) => {
  const { blogId, logNo } = req.body;
  if (!/^[\w-]+$/.test(blogId || "") || !/^\d+$/.test(String(logNo || ""))) return res.status(400).json({ error: "blogId/logNo가 올바르지 않습니다." });
  like.openAndWatch(blogId, String(logNo)); // 오류는 likeWatch의 status: "error"로 전달됨
  res.json({ started: true });
});

// 추천 댓글/답글 예시 만들기 (백그라운드, 진행 상황은 GET /api/neighbors의 suggestState)
app.post("/api/neighbors/suggest", async (req, res) => {
  const { keys, force } = req.body;
  if (!Array.isArray(keys) || !keys.length) return res.status(400).json({ error: "keys가 필요합니다." });
  try {
    await suggest.generate(keys, { force: force === true });
    res.json({ started: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// --- 성과 통계 ---
app.get("/api/stats", (req, res) => {
  const data = stats.getCached();
  res.json({
    data,
    state: stats.getState(),
    goals: stats.getGoals(),
    suggestedGoals: data && data.analysis ? stats.suggestGoals(data) : null,
    history: stats.getHistory(),
    trends: trendsFor(data),
  });
});

app.post("/api/stats/refresh", (req, res) => {
  stats.refresh(); // 백그라운드, 진행 상황은 GET /api/stats의 state
  res.json({ started: true });
});

// 목표(KPI) 저장
app.post("/api/stats/goals", (req, res) => {
  res.json({ goals: stats.setGoals(req.body || {}) });
});

// 주간 회고 메모 저장
app.post("/api/stats/memo", async (req, res) => {
  const { week, did, good, next } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week || "")) return res.status(400).json({ error: "week(YYYY-MM-DD)가 필요합니다." });
  const record = stats.setMemo(week, { did, good, next });
  // 노션 설정이 되어 있으면 회고를 바로 노션에도 반영 (화면에서 "노션에도 반영"을 끈 경우만 제외, 실패해도 회고 저장은 유지)
  if (req.body.notion !== false && notion.isReady()) {
    try {
      return res.json({ record, notion: await syncMemoToNotion(record) });
    } catch (e) {
      return res.json({ record, notionError: e.message });
    }
  }
  res.json({ record });
});

// --- 노션 기록 (사람마다 자기 토큰/저장 위치를 설정) ---
app.get("/api/notion/config", (req, res) => {
  res.json({ config: notion.getPublicConfig(), log: notion.getLog() });
});

app.post("/api/notion/config", async (req, res) => {
  try {
    res.json({ config: await notion.saveConfig(req.body || {}) });
  } catch (e) {
    res.status(400).json({ error: e.message, accessible: e.accessible || null });
  }
});

// period: "week"(지난주) | "month"(지난달). 같은 기간을 이미 저장했으면 force 없이는 알려만 준다.
app.post("/api/notion/save", async (req, res) => {
  const { period, force } = req.body || {};
  const d = stats.getCached();
  if (!d) return res.status(400).json({ error: "먼저 통계를 불러와주세요." });
  const opts = { goals: stats.getGoals(), history: stats.getHistory() };
  const dd = statsWithTrends(d);
  const report = period === "month" ? buildMonthly(dd, opts) : buildWeekly(dd, opts);
  const prev = notion.getLog()[report.key];
  if (prev && prev.length && force !== true) return res.json({ exists: prev, title: report.title });
  try {
    res.json({ saved: await notion.saveReport(report) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/stats/excel", async (req, res) => {
  const d = stats.getCached();
  if (!d) return res.status(400).send("먼저 통계를 불러와주세요.");
  try {
    const wb = await buildWorkbook(statsWithTrends(d), { goals: stats.getGoals(), history: stats.getHistory() });
    const name = `블로그성과_${d.today}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="blog-stats-${d.today}.xlsx"; filename*=UTF-8''${encodeURIComponent(name)}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).send(e.message);
  }
});

const PORT = process.env.PORT || 3300;
app.listen(PORT, () => {
  console.log(`네이버 블로그 자동화 대시보드: http://localhost:${PORT}`);
});
