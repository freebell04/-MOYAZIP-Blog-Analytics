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

const { askClaude, extractJson } = require("./lib/claude");
const session = require("./lib/session");
const { searchNaver, fetchArticleText } = require("./lib/scraper");
const { findAndJudgeImages } = require("./lib/images");
const { saveDraftToNaver, finalizeTocAndSummary, openTemplateEditor } = require("./lib/blogEditor");
const neighbors = require("./lib/neighbors");
const suggest = require("./lib/suggest");
const like = require("./lib/like");
const stats = require("./lib/stats");
const notion = require("./lib/notion");
const config = require("./lib/config");
const trendsFor = () => null;
const statsWithTrends = (d) => d;
const { buildWeekly, buildMonthly, buildMemoOnly, memoBlocks, MEMO_HEADING, memoHeading } = require("./lib/notionReport");

/**
 * 주간 회고를 노션에 반영한다.
 * - 그 주 리포트를 노션에 저장한 적이 있으면: 그 페이지의 "✍️ 회고" 부분만 새 내용으로 교체
 * - 없으면: 지난주면 전체 주간 리포트를, 더 예전 주면 숫자+회고만 담은 짧은 페이지를 새로 만든다
 */
async function syncMemoToNotion(rec) {
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
app.use(express.json({ limit: "10mb" }));

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
  if (config.isConfigured() || req.path === "/setup.html" || req.path.startsWith("/api/setup") || /\.(css|js|png|ico)$/.test(req.path)) return next();
  if (req.path.startsWith("/api/")) return res.status(400).json({ error: "먼저 블로그 아이디를 설정해주세요." });
  res.redirect("/setup.html");
});

app.use(express.static(path.join(__dirname, "public")));
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
    const result = await searchNaver(keyword);
    res.json(result);
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
    res.status(500).json({ error: e.message });
  }
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
  // 노션 설정이 되어 있고 화면에서 "노션에도 반영"을 켰으면 같이 반영 (실패해도 회고 저장은 유지)
  if (req.body.notion === true && notion.isReady()) {
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
