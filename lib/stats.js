// 내 블로그 성과 통계: 네이버 "내 블로그 통계"(blog.stat.naver.com)와 같은 데이터를 가져와서
// 조회수 추이, 유입 경로, 검색어, 인기 글, 시간대, 성별·연령을 정리하고
// 규칙 기반 분석 + 다음 콘텐츠 추천까지 만든다. (AI 분석은 suggest와 같은 Claude CLI를 쓰는 별도 단계)
//
// 통계 API는 로그인이 필요해서, 디버그 크롬의 blog.stat.naver.com 페이지 안에서 fetch 한다.
const path = require("path");
const fs = require("fs");
const session = require("./session");

const BLOG_ID = require("./config").blogId();
const STATS_PATH = path.join(__dirname, "..", "data", "stats.json");

const AGE = { "01": "0-12", "02": "13-18", "03": "19-24", "04": "25-29", "05": "30-34", "06": "35-39", "07": "40-44", "08": "45-49", "09": "50-54", 10: "55-59", 11: "60-" };
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
const sum = (a) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 1000) / 10 : null);

/** statDataList의 한 dataId를 [{col: value}] 행 배열로 바꾼다 */
function rowsOf(json, dataId) {
  const list = (json && json.result && json.result.statDataList) || [];
  const item = list.find((x) => x.dataId === dataId);
  if (!item || !item.data || !item.data.rows) return [];
  const rows = item.data.rows;
  const cols = Object.keys(rows);
  const n = Math.max(0, ...cols.map((c) => (Array.isArray(rows[c]) ? rows[c].length : 0)));
  return Array.from({ length: n }, (_, i) => Object.fromEntries(cols.map((c) => [c, rows[c][i]])));
}

let state = { running: false, progress: "", error: null, needLogin: false };
const getState = () => state;

async function refresh() {
  if (state.running) return;
  state = { running: true, progress: "통계 화면 여는 중...", error: null, needLogin: false };
  let browser, page;
  try {
    const ctx = await session.openVisibleContext();
    browser = ctx.browser;
    page = await ctx.context.newPage();
    await page.goto(`https://blog.stat.naver.com/blog/daily/daily/cv?blogId=${BLOG_ID}`, { waitUntil: "domcontentloaded" });
    if (!/blog\.stat\.naver\.com/.test(page.url())) {
      state = { running: false, progress: "", error: "네이버에 로그인되어 있지 않아요. [네이버 로그인] 후 다시 불러와주세요.", needLogin: true };
      return;
    }
    const api = async (p) => {
      state.progress = `통계 가져오는 중: ${p.split("?")[0]}`;
      const json = await page.evaluate(async (u) => (await fetch(u, { credentials: "include" })).json(), `/api/${p}`);
      if (!json || json.statusCode !== 200) throw new Error(`통계 API 오류 (${p.split("?")[0]}): ${(json && json.message) || "응답 없음"}`);
      await new Promise((r) => setTimeout(r, 300));
      return json;
    };

    const now = new Date();
    const today = ymd(now);
    const lastWeek = ymd(addDays(mondayOf(now), -7));
    const thisMonth1 = ymd(new Date(now.getFullYear(), now.getMonth(), 1));
    const lastMonth1 = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1));

    // 일별 조회수: 한 번에 15일씩 → 30일
    const d1 = rowsOf(await api(`blog/daily/cv?timeDimension=DATE&startDate=${today}`), "cv");
    const d2 = rowsOf(await api(`blog/daily/cv?timeDimension=DATE&startDate=${ymd(addDays(now, -15))}`), "cv");
    const dailyMap = {};
    for (const r of [...d1, ...d2]) dailyMap[r.date] = Number(r.cv) || 0;
    const daily = Object.keys(dailyMap).sort().map((date) => ({ date, cv: dailyMap[date], dow: DOW[new Date(date + "T00:00:00").getDay()] }));

    // 날짜별 공감·댓글·이웃 증감 (통계 '일간 현황' 카드와 같은 값, 하루씩 조회)
    for (const [i, x] of daily.entries()) {
      state.progress = `날짜별 공감·댓글 가져오는 중 (${i + 1}/${daily.length})`;
      const json = await page.evaluate(async (u) => (await fetch(u, { credentials: "include" })).json(), `/api/blog/daily/cv?timeDimension=DATE&startDate=${x.date}`);
      const dash = ((json.result.statDataList.find((s) => s.dataId === "dashboard") || {}).data || {}).value || {};
      x.like = Number(dash.dailyLike) || 0;
      x.comment = Number(dash.dailyComment) || 0;
      x.relation = Number(dash.dailyRelationDelta) || 0;
      await new Promise((r) => setTimeout(r, 250));
    }

    const weeklyCv = rowsOf(await api(`blog/visit/cv?timeDimension=WEEK&startDate=${today}`), "cv");
    const weeklyUv = rowsOf(await api(`blog/visit/uv?timeDimension=WEEK&startDate=${today}`), "uv");
    const uvByWeek = Object.fromEntries(weeklyUv.map((r) => [r.date, r.total]));
    const weekly = weeklyCv
      .map((r) => ({ week: r.date, cv: r.total, uv: uvByWeek[r.date] ?? null, friend: r.friend, follow: r.follow, etc: r.etc }))
      .sort((a, b) => a.week.localeCompare(b.week));

    const monthly = rowsOf(await api(`blog/visit/cv?timeDimension=MONTH&startDate=${thisMonth1}`), "cv")
      .map((r) => ({ month: r.date.slice(0, 7), cv: r.total, friend: r.friend, follow: r.follow, etc: r.etc }))
      .filter((r) => r.cv > 0)
      .sort((a, b) => a.month.localeCompare(b.month));

    const periodData = async (dim, start) => ({
      start,
      referers: rowsOf(await api(`blog/user/referer/total?timeDimension=${dim}&startDate=${start}`), "refererTotal")
        .filter((r) => r.referrerDomain)
        .map((r) => ({ name: r.referrerDomain, isSearch: r.referrerSearchEngine === "1", cv: r.cv, share: r.cv_p })),
      queries: rowsOf(await api(`blog/user/referer/search?timeDimension=${dim}&startDate=${start}`), "refererSearch")
        .filter((r) => r.searchQuery)
        .map((r) => ({ query: r.searchQuery, cv: r.cv, share: r.cv_p })),
      topPosts: rowsOf(await api(`blog/rank/cvContentPc?timeDimension=${dim}&startDate=${start}`), "rankCv")
        .filter((r) => r.title)
        .map((r) => ({ rank: r.rank, title: r.title, cv: r.cv, logNo: String(r.uri || "").split("/").pop(), createDate: r.createDate })),
    });
    const week = await periodData("WEEK", lastWeek);
    const month = await periodData("MONTH", lastMonth1);

    const hour = rowsOf(await api(`blog/user/hour?timeDimension=WEEK&startDate=${lastWeek}`), "hour").map((r) => ({ hour: Number(r.date), cv: r.cv }));
    const demo = rowsOf(await api(`blog/user/demoCv?timeDimension=WEEK&startDate=${lastWeek}`), "demo").map((r) => ({
      age: r.age === "total" ? "전체" : AGE[r.age] || r.age,
      m: r.m,
      f: r.f,
    }));

    state.progress = "내 글 목록 가져오는 중...";
    const posts = await fetchMyPosts();
    const early = await fetchEarlyPerformance(page, posts, now);

    const data = { updatedAt: new Date().toISOString(), today, lastWeek, lastMonth: lastMonth1.slice(0, 7), daily, weekly, monthly, week, month, hour, demo, posts, early };
    data.analysis = analyze(data);
    fs.writeFileSync(STATS_PATH, JSON.stringify(data, null, 2));
    saveHistory(data);
    state = { running: false, progress: "완료", error: null, needLogin: false };
  } catch (e) {
    state = { running: false, progress: "", error: e.message, needLogin: false };
  } finally {
    if (page) await page.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

/** 내 글 제목·발행일 (RSS) */
async function fetchMyPosts() {
  const xml = await (await fetch(`https://rss.blog.naver.com/${BLOG_ID}.xml`)).text();
  const tag = (s, k) => {
    const m = s.match(new RegExp(`<${k}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${k}>`));
    return m ? m[1].trim() : "";
  };
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const link = tag(m[1], "link").replace(/\?.*$/, "");
    const pub = new Date(tag(m[1], "pubDate"));
    return { title: tag(m[1], "title"), link, logNo: link.split("/").pop(), date: ymd(pub), time: pub.toISOString() };
  });
}

const EARLY_DAYS = 3; // "발행 후 3일" = 발행일(D0) ~ D+2, 공감·댓글은 발행 시각부터 72시간

/**
 * 최근 30일 안에 발행한 글(최대 10개)의 초반 성과: 발행 후 3일 조회수(일별) · 공감 · 댓글 + 지금까지 누적.
 * 조회수는 통계 API(게시글별), 공감·댓글 시각은 이웃 소통에서 쓰는 API로 센다.
 */
async function fetchEarlyPerformance(page, posts, now) {
  const neighbors = require("./neighbors");
  const targets = posts.filter((p) => new Date(p.time) >= addDays(now, -30)).slice(0, 10);
  const out = [];
  for (const [i, p] of targets.entries()) {
    state.progress = `글별 초반 성과 (${i + 1}/${targets.length}) 조회수: ${p.title.slice(0, 20)}`;
    const d0 = new Date(p.date + "T00:00:00");
    const end = addDays(d0, EARLY_DAYS);
    const endStr = ymd(end > now ? now : end);
    const json = await page.evaluate(async (u) => (await fetch(u, { credentials: "include" })).json(), `/api/blog/article/cv?timeDimension=DATE&startDate=${endStr}&contentId=${p.logNo}`);
    const byDate = Object.fromEntries(rowsOf(json, "cv").map((r) => [r.date, Number(r.cv) || 0]));
    // summary는 조회한 날 하루치라서, 누적은 dashboard(cvTotal 등)를 쓴다
    const dash = ((json.result.statDataList.find((s) => s.dataId === "dashboard") || {}).data || {}).value || {};
    const days = Array.from({ length: EARLY_DAYS + 1 }, (_, k) => {
      const dd = addDays(d0, k);
      return dd > now ? null : byDate[ymd(dd)] ?? 0;
    });
    out.push({
      logNo: p.logNo,
      title: p.title,
      link: p.link,
      date: p.date,
      time: p.time,
      days, // [D0, D+1, D+2, D+3] 조회수 (아직 안 온 날은 null)
      complete: now - new Date(p.time) >= EARLY_DAYS * 86400000,
      totalCv: Number(dash.cvTotal) || 0,
      totalLike: Number(dash.likeTotal) || 0,
      totalComment: Number(dash.commentTotal) || 0,
    });
    await new Promise((r) => setTimeout(r, 300));
  }

  // 공감·댓글이 발행 후 72시간 안에 몇 개 달렸는지 (m.blog 페이지에서 공감 목록 조회)
  if (out.length) {
    await page.goto(`https://m.blog.naver.com/${BLOG_ID}`, { waitUntil: "domcontentloaded" });
    const blogNo = await neighbors.fetchBlogNo(BLOG_ID, out[0].logNo);
    for (const [i, e] of out.entries()) {
      state.progress = `글별 초반 성과 (${i + 1}/${out.length}) 공감·댓글: ${e.title.slice(0, 20)}`;
      const start = new Date(e.time).getTime();
      const within = (d) => d && new Date(d).getTime() - start <= EARLY_DAYS * 86400000;
      const likes = await neighbors.fetchSympathies(page, e.logNo).catch(() => []);
      const comments = (await neighbors.fetchComments(blogNo, e.logNo).catch(() => [])).filter((c) => c.blogId !== BLOG_ID);
      e.earlyLike = likes.filter((u) => within(u.date)).length;
      e.earlyComment = comments.filter((c) => within(c.date)).length;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (const e of out) {
    const d = e.days.slice(0, EARLY_DAYS).map((v) => v || 0);
    e.early3 = sum(d); // 발행일 포함 3일 조회수
    e.earlyShare = e.totalCv ? Math.round((e.early3 / e.totalCv) * 100) : null;
  }
  const done = out.filter((e) => e.complete);
  const avg = done.length ? Math.round(sum(done.map((e) => e.early3)) / done.length) : null;
  for (const e of out) e.vsAvg = avg && e.complete ? Math.round(((e.early3 - avg) / avg) * 100) : null;
  return { windowDays: EARLY_DAYS, avgEarly3: avg, posts: out };
}

// ---------------- 목표(KPI) · 기록 ----------------

const GOALS_PATH = path.join(__dirname, "..", "data", "stats-goals.json");
const HISTORY_PATH = path.join(__dirname, "..", "data", "stats-history.json");
const readJson = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return fb;
  }
};

/** 데이터로 계산한 추천 목표 (지금보다 10~20% 높게) */
function suggestGoals(d) {
  const a = d.analysis.summary;
  const last7 = d.daily.slice(-8, -1);
  const round = (v, unit) => Math.max(unit, Math.round(v / unit) * unit);
  return {
    weeklyViews: round((a.avg4Weeks || a.lastWeekCv || 100) * 1.15, 10),
    monthlyViews: round(Math.max(a.projectedMonth || 0, a.lastMonthCv || 0) * 1.1, 50),
    postsPerWeek: Math.max(3, Math.ceil((a.posts30 || 0) / 4) + 1),
    weeklyLikes: round(sum(last7.map((x) => x.like || 0)) * 1.2, 5),
    weeklyComments: round(sum(last7.map((x) => x.comment || 0)) * 1.2, 5),
  };
}

function getGoals() {
  return readJson(GOALS_PATH, null);
}

function setGoals(goals) {
  const clean = {};
  for (const k of ["weeklyViews", "monthlyViews", "postsPerWeek", "weeklyLikes", "weeklyComments"]) {
    const v = Number(goals[k]);
    if (Number.isFinite(v) && v >= 0) clean[k] = Math.round(v);
  }
  clean.updatedAt = new Date().toISOString();
  fs.writeFileSync(GOALS_PATH, JSON.stringify(clean, null, 2));
  // 진행 중인 주의 기록에도 바로 반영 (지난 주들은 그때 세운 목표를 그대로 둔다)
  const hist = getHistory();
  let touched = false;
  for (const rec of Object.values(hist.weeks)) {
    if (rec.inProgress && clean.weeklyViews != null) {
      rec.goalViews = clean.weeklyViews;
      touched = true;
    }
  }
  if (touched) fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist, null, 2));
  return clean;
}

function getHistory() {
  return readJson(HISTORY_PATH, { weeks: {} });
}

/**
 * 주 단위 성과 기록을 쌓는다 (같은 주는 숫자만 갱신, 적어둔 회고 메모는 유지).
 * 주별 조회수는 통계 API의 주간 값, 공감·댓글·발행 수는 일별 값을 주 단위로 합친 것.
 */
function saveHistory(d) {
  const hist = getHistory();
  const goals = getGoals() || {};
  const mondayStr = (date) => ymd(mondayOf(new Date(date + "T00:00:00")));
  const agg = {};
  for (const x of d.daily) {
    const w = (agg[mondayStr(x.date)] ||= { cv: 0, like: 0, comment: 0, relation: 0, days: 0 });
    w.cv += x.cv;
    w.like += x.like || 0;
    w.comment += x.comment || 0;
    w.relation += x.relation || 0;
    w.days += 1;
  }
  const postsByWeek = {};
  for (const p of d.posts) (postsByWeek[mondayStr(p.date)] ||= []).push(p.title);
  const thisWeek = mondayStr(d.today);
  const weeks = new Set([...d.weekly.slice(-8).map((w) => w.week), ...Object.keys(agg).filter((w) => agg[w].days === 7 || w === thisWeek)]);
  for (const week of weeks) {
    const api = d.weekly.find((w) => w.week === week);
    const a = agg[week];
    const full = a && a.days === 7;
    const rec = (hist.weeks[week] ||= {});
    Object.assign(rec, {
      week,
      inProgress: week === thisWeek,
      cv: api ? api.cv : a ? a.cv : rec.cv,
      uv: api ? api.uv : rec.uv ?? null,
      like: full || week === thisWeek ? a.like : rec.like ?? null,
      comment: full || week === thisWeek ? a.comment : rec.comment ?? null,
      relation: full || week === thisWeek ? a.relation : rec.relation ?? null,
      posts: (postsByWeek[week] || []).length,
      postTitles: postsByWeek[week] || [],
      goalViews: rec.goalViews ?? goals.weeklyViews ?? null, // 그 주에 세웠던 목표를 남긴다
      updatedAt: new Date().toISOString(),
    });
    if (rec.inProgress && goals.weeklyViews) rec.goalViews = goals.weeklyViews;
  }
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist, null, 2));
}

/** 주간 회고 메모 저장: {did, good, next} */
function setMemo(week, memo) {
  const hist = getHistory();
  const rec = (hist.weeks[week] ||= { week });
  rec.memo = { did: String(memo.did || ""), good: String(memo.good || ""), next: String(memo.next || ""), savedAt: new Date().toISOString() };
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(hist, null, 2));
  return rec;
}

// ---------------- 규칙 기반 분석 ----------------

const norm = (s) => String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

/** 검색어 토큰이 모두 들어간 내 글이 있는지 */
function coveringPost(query, posts) {
  const tokens = String(query).toLowerCase().split(/\s+/).map(norm).filter(Boolean);
  let best = null;
  for (const p of posts) {
    const t = norm(p.title);
    const hit = tokens.filter((k) => t.includes(k)).length;
    if (!best || hit > best.hit) best = { post: p, hit };
  }
  return { tokens, best, full: best && best.hit === tokens.length };
}

function analyze(d) {
  const insights = [];
  const tips = [];
  const ideas = [];

  // 1) 주간 비교
  const w = d.weekly;
  const lastW = w[w.length - 1];
  const prevW = w[w.length - 2];
  const weekChange = lastW && prevW ? pct(lastW.cv, prevW.cv) : null;
  if (lastW && prevW) {
    insights.push({
      icon: weekChange >= 0 ? "📈" : "📉",
      text: `지난주 조회수 ${lastW.cv.toLocaleString()}회 — 그 전 주(${prevW.cv.toLocaleString()}회)보다 ${weekChange >= 0 ? "+" : ""}${weekChange}%`,
    });
  }
  const recent4 = w.slice(-4);
  const avg4 = recent4.length ? Math.round(sum(recent4.map((x) => x.cv)) / recent4.length) : 0;

  // 2) 월간 + 이번 달 예상
  const now = new Date();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const monthPrefix = d.today.slice(0, 7);
  const mtdDays = d.daily.filter((x) => x.date.startsWith(monthPrefix));
  const mtd = sum(mtdDays.map((x) => x.cv));
  // 오늘은 아직 진행 중이라 예상치 계산에서 뺀다
  const fullDays = mtdDays.filter((x) => x.date !== d.today);
  const projected = fullDays.length ? Math.round((sum(fullDays.map((x) => x.cv)) / fullDays.length) * daysInMonth) : null;
  const lastMonth = d.monthly[d.monthly.length - 1];
  if (projected && lastMonth) {
    insights.push({
      icon: projected >= lastMonth.cv ? "🗓️" : "⚠️",
      text: `이번 달 지금까지 ${mtd.toLocaleString()}회, 이 속도면 약 ${projected.toLocaleString()}회 예상 (지난달 ${lastMonth.cv.toLocaleString()}회, ${pct(projected, lastMonth.cv) >= 0 ? "+" : ""}${pct(projected, lastMonth.cv)}%)`,
    });
  }

  // 3) 요일별 평균 (오늘 제외)
  const byDow = {};
  for (const x of d.daily.filter((x) => x.date !== d.today)) (byDow[x.dow] ||= []).push(x.cv);
  const dowAvg = Object.entries(byDow).map(([dow, a]) => ({ dow, avg: Math.round(sum(a) / a.length) })).sort((a, b) => b.avg - a.avg);

  // 4) 글 발행 효과: 글 올린 날/다음 날 vs 안 올린 날
  const postDays = new Set(d.posts.map((p) => p.date));
  const nextDays = new Set([...postDays].map((s) => ymd(addDays(new Date(s + "T00:00:00"), 1))));
  const withPost = d.daily.filter((x) => x.date !== d.today && (postDays.has(x.date) || nextDays.has(x.date)));
  const noPost = d.daily.filter((x) => x.date !== d.today && !postDays.has(x.date) && !nextDays.has(x.date));
  const avgWith = withPost.length ? Math.round(sum(withPost.map((x) => x.cv)) / withPost.length) : null;
  const avgNo = noPost.length ? Math.round(sum(noPost.map((x) => x.cv)) / noPost.length) : null;
  if (avgWith != null && avgNo != null && withPost.length >= 2 && noPost.length >= 2) {
    insights.push({ icon: "✍️", text: `글 올린 날·다음 날 평균 ${avgWith}회 vs 안 올린 날 ${avgNo}회 (${pct(avgWith, avgNo) >= 0 ? "+" : ""}${pct(avgWith, avgNo)}%)` });
  }
  const posts30 = d.posts.filter((p) => new Date(p.date) >= addDays(now, -30)).length;

  // 5) 유입 경로
  const refs = d.week.referers;
  const refTotal = sum(refs.map((r) => r.cv));
  const searchCv = sum(refs.filter((r) => r.isSearch).map((r) => r.cv));
  const searchShare = refTotal ? Math.round((searchCv / refTotal) * 100) : null;
  const naverSearch = sum(refs.filter((r) => /네이버 (통합검색|블로그검색|검색)/.test(r.name)).map((r) => r.cv));
  const mobile = sum(refs.filter((r) => /모바일/.test(r.name)).map((r) => r.cv));
  const homeFeed = sum(refs.filter((r) => /메인|홈판/.test(r.name)).map((r) => r.cv));
  if (refs[0]) insights.push({ icon: "🔎", text: `지난주 유입 1위는 '${refs[0].name}' (${Math.round(refs[0].share)}%) · 검색 유입 ${searchShare}% · 모바일 ${refTotal ? Math.round((mobile / refTotal) * 100) : 0}%` });

  // 6) 시간대
  const topHours = d.hour.slice().sort((a, b) => b.cv - a.cv).slice(0, 3).map((h) => h.hour).sort((a, b) => a - b);

  // 7) 독자층
  const total = d.demo.find((x) => x.age === "전체");
  const ages = d.demo.filter((x) => x.age !== "전체").map((x) => ({ age: x.age, v: (x.m || 0) + (x.f || 0) })).sort((a, b) => b.v - a.v);
  if (total && ages[0]) {
    const f = Math.round((total.f / ((total.f || 0) + (total.m || 0) || 1)) * 100);
    insights.push({ icon: "👥", text: `독자는 여성 ${f}% · 남성 ${100 - f}%, 가장 많은 나이대는 ${ages[0].age}세, 그다음 ${ages[1] ? ages[1].age + "세" : "-"}` });
  }

  // 8) 발행 후 3일 초반 성과
  const earlyDone = d.early ? d.early.posts.filter((e) => e.complete) : [];
  let earlyShareAvg = null;
  if (earlyDone.length >= 2) {
    const best = earlyDone.slice().sort((a, b) => b.early3 - a.early3)[0];
    insights.push({
      icon: "🚀",
      text: `발행 후 3일 조회수 평균 ${d.early.avgEarly3}회 — 가장 빨리 뜬 글은 '${best.title.slice(0, 25)}' (${best.early3}회, 공감 ${best.earlyLike ?? "-"} · 댓글 ${best.earlyComment ?? "-"})`,
    });
    const shares = earlyDone.filter((e) => e.earlyShare != null).map((e) => e.earlyShare);
    earlyShareAvg = shares.length ? Math.round(sum(shares) / shares.length) : null;
  }

  // ---- 앞으로 이렇게 올려보세요 (규칙 기반) ----
  if (earlyShareAvg != null) {
    tips.push(
      earlyShareAvg >= 50
        ? `글 조회수의 평균 ${earlyShareAvg}%가 발행 후 3일 안에 나와요. 발행 직후 3일 동안 이웃 답방·공유에 집중하면 효과가 가장 커요.`
        : `발행 후 3일 조회수는 전체의 평균 ${earlyShareAvg}%뿐이고 나머지는 나중에 검색으로 들어와요. 당장 반응보다 검색어를 제목에 정확히 넣는 게 더 중요한 블로그예요.`
    );
  }
  if (dowAvg.length >= 3) tips.push(`조회수가 가장 높은 요일은 ${dowAvg[0].dow}요일(평균 ${dowAvg[0].avg}회), 낮은 요일은 ${dowAvg[dowAvg.length - 1].dow}요일이에요. 공들인 글은 ${dowAvg[0].dow}요일 전날 밤이나 당일 오전에 올려보세요.`);
  if (topHours.length) tips.push(`지난주에는 ${topHours.map((h) => `${h}시`).join(", ")}에 가장 많이 읽혔어요. 그 1~2시간 전에 발행하면 검색 노출이 쌓이는 시간을 벌 수 있어요.`);
  if (searchShare != null && searchShare >= 50) tips.push(`유입의 ${searchShare}%가 검색이에요. 제목 앞부분에 사람들이 실제로 검색한 말(아래 검색어 표)을 그대로 넣는 게 가장 효과적이에요.`);
  if (homeFeed && refTotal && homeFeed / refTotal >= 0.05) tips.push(`네이버 메인·홈판 유입이 ${Math.round((homeFeed / refTotal) * 100)}% 있어요. 썸네일(첫 이미지)과 제목 후킹이 먹히고 있으니 계속 신경 써주세요.`);
  if (avgWith != null && avgNo != null && avgWith > avgNo) tips.push(`글을 올린 날·다음 날 조회수가 ${pct(avgWith, avgNo)}% 더 높아요. 최근 30일 ${posts30}개 발행 중 — 주 ${Math.max(3, Math.ceil(posts30 / 4) + 1)}회 이상으로 꾸준히 올리면 바닥 조회수가 올라가요.`);
  if (weekChange != null && weekChange < -10) tips.push(`지난주 조회수가 ${Math.abs(weekChange)}% 줄었어요. 조회수 상위 글(아래 인기 글)의 후속편이나 업데이트 글로 검색 유입을 다시 끌어오세요.`);
  const friendShare = lastW ? Math.round(((lastW.friend + lastW.follow) / (lastW.cv || 1)) * 100) : 0;
  if (lastW && friendShare < 10) tips.push(`이웃·팔로워 조회는 지난주 ${friendShare}%뿐이에요. 이웃 소통(답방)을 늘리면 새 글 초반 조회수가 받쳐줘요.`);

  // ---- 다음 콘텐츠 추천 ----
  const qMap = {};
  for (const q of [...d.week.queries, ...d.month.queries]) {
    if (!q.query || q.query === "기타") continue;
    qMap[q.query] = (qMap[q.query] || 0) + (Number(q.cv) || 0);
  }
  const queries = Object.entries(qMap).map(([query, cv]) => ({ query, cv })).sort((a, b) => b.cv - a.cv);

  // (a) 검색은 들어오는데 딱 맞는 글이 없는 키워드 → 새 글
  for (const q of queries) {
    const c = coveringPost(q.query, d.posts);
    if (!c.full && q.cv >= 2 && ideas.filter((i) => i.type === "gap").length < 5) {
      ideas.push({
        type: "gap",
        title: `"${q.query}" 딱 맞춘 글`,
        reason: `검색으로 ${q.cv}회 들어왔는데 이 키워드가 제목에 다 들어간 글이 없어요${c.best && c.best.hit ? ` (지금은 '${c.best.post.title.slice(0, 30)}…'로 유입)` : ""}.`,
        keyword: q.query,
      });
    }
  }
  // (b) 검색이 몰리는 글 → 후속편/시리즈
  const byPost = {};
  for (const q of queries) {
    const c = coveringPost(q.query, d.posts);
    if (c.best && c.best.hit) {
      const k = c.best.post.logNo;
      (byPost[k] ||= { post: c.best.post, cv: 0, queries: [] }).cv += q.cv;
      byPost[k].queries.push(q.query);
    }
  }
  for (const g of Object.values(byPost).sort((a, b) => b.cv - a.cv).slice(0, 3)) {
    ideas.push({
      type: "series",
      title: `'${g.post.title.slice(0, 28)}' 후속편`,
      reason: `이 글로 검색 유입 ${g.cv}회 (${g.queries.slice(0, 3).join(", ")}). 같은 검색 수요를 잡는 2편·비교편·업데이트편을 추천해요.`,
      keyword: g.queries[0],
    });
  }
  // (c) 인기 글 주제 확장
  const top = (d.month.topPosts[0] || d.week.topPosts[0]);
  if (top) ideas.push({ type: "top", title: `인기 1위 글 주제 확장`, reason: `'${top.title.slice(0, 30)}'이(가) 조회수 1위(${top.cv}회)예요. 같은 소재로 "초보용 정리", "자주 묻는 질문", "최신 업데이트" 글을 이어서 써보세요.` });

  return {
    summary: {
      lastWeekCv: lastW ? lastW.cv : null,
      prevWeekCv: prevW ? prevW.cv : null,
      weekChange,
      avg4Weeks: avg4,
      monthToDate: mtd,
      projectedMonth: projected,
      lastMonthCv: lastMonth ? lastMonth.cv : null,
      searchShare,
      naverSearchShare: refTotal ? Math.round((naverSearch / refTotal) * 100) : null,
      posts30,
      bestDow: dowAvg[0] ? dowAvg[0].dow : null,
      topHours,
    },
    dowAvg,
    insights,
    tips,
    ideas,
    queries: queries.slice(0, 30),
  };
}

function getCached() {
  try {
    return JSON.parse(fs.readFileSync(STATS_PATH, "utf-8"));
  } catch {
    return null;
  }
}

module.exports = { refresh, getState, getCached, analyze, suggestGoals, getGoals, setGoals, getHistory, setMemo };
