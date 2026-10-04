// 성과 통계 → 노션 블록 리포트 (주간 / 월간).
// 프로그램이 정리한 숫자·분석·추천·회고를 그대로 옮긴다.

const { computeProgress, bar, mondayOf } = require("./goalProgress");

// ---- 블록 헬퍼 (rich_text 한 덩어리는 2000자 제한) ----
function rt(text, ann = {}) {
  const s = String(text ?? "");
  const out = [];
  for (let i = 0; i < s.length; i += 2000) {
    out.push({ type: "text", text: { content: s.slice(i, i + 2000) }, annotations: ann });
  }
  return out;
}
const block = (type, rich, extra = {}) => ({ object: "block", type, [type]: { rich_text: rich, ...extra } });
const h2 = (t) => block("heading_2", rt(t));
const h3 = (t) => block("heading_3", rt(t));
const p = (t, ann) => block("paragraph", rt(t, ann));
const bullet = (t) => block("bulleted_list_item", rt(t));
const todo = (t) => block("to_do", rt(t), { checked: false });
const quote = (t) => block("quote", rt(t));
const callout = (t, emoji = "💡") => block("callout", rt(t), { icon: { type: "emoji", emoji } });
const divider = () => ({ object: "block", type: "divider", divider: {} });
function table(header, rows) {
  const width = header.length;
  const row = (cells) => ({ object: "block", type: "table_row", table_row: { cells: cells.map((c) => rt(c == null ? "-" : String(c))).slice(0, width) } });
  return {
    object: "block",
    type: "table",
    table: { table_width: width, has_column_header: true, has_row_header: false, children: [row(header), ...rows.map((r) => row(r))] },
  };
}

const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString("ko-KR"));
const pct = (a, b) => (a != null && b ? Math.round(((a - b) / b) * 1000) / 10 : null);
const signed = (v) => (v == null ? "-" : `${v >= 0 ? "+" : ""}${v}%`);
const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 저장한 날(오늘, 한국 시간) — 리포트 제목과 노션 날짜는 오늘로 쓰고, 어느 기간 데이터인지는 제목 끝에 "기준"으로 남긴다
const todayKst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const mdOf = (d) => d.slice(5).replace("-", "/");
const addDays = (s, n) => {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return ymd(d);
};

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];
const md = (s) => `${Number(s.slice(5, 7))}/${Number(s.slice(8, 10))}(${WEEKDAY[new Date(s + "T00:00:00").getDay()]})`;

/** 통계의 일별 데이터에서 from~to(양끝 포함) 합계 */
function sumDaily(d, from, to) {
  const rows = (d.daily || []).filter((x) => x.date >= from && x.date <= to);
  const sum = (k) => rows.reduce((a, x) => a + (x[k] || 0), 0);
  return { days: rows.length, cv: sum("cv"), like: sum("like"), comment: sum("comment") };
}
/** "오늘까지"인지 "10/03까지"인지 (통계가 어제 것이면 그 날짜로 정확히 적는다) */
const untilLabel = (upTo) => (upTo === todayKst() ? "오늘까지" : `${mdOf(upTo)}까지`);

/** 글 올린 날 정리: 날짜별로 묶는다 → [{date, titles}] (날짜 오름차순) */
function postDays(posts) {
  const by = {};
  for (const x of posts) (by[x.date] ||= []).push(x.title);
  return Object.keys(by).sort().map((date) => ({ date, titles: by[date] }));
}

/** 리포트 맨 위에 놓는 "글 올린 날" 칸. 날짜와 그날 올린 글을 함께 적는다 (withTitles: 월간은 길어서 날짜만) */
function postedDaysBlock(posts, totalDays, withTitles, label = "") {
  const days = postDays(posts);
  const head = `${label}글 올린 날 ${days.length}일 / ${totalDays}일 · 발행 ${posts.length}개`;
  if (!days.length) return callout(`${head}\n이 기간에 올린 글이 없어요`, "📅");
  const lines = withTitles ? days.map((d) => `${md(d.date)}  ${d.titles.join(" · ")}`) : [days.map((d) => md(d.date)).join("  ")];
  return callout([head, ...lines].join("\n"), "📅");
}

/**
 * 🎯 목표 진행 상황: 성과 통계 화면의 표(이번 주·이번 달 기준)를 그대로 옮기고,
 * 그 표를 보고 "앞으로 이렇게 해보세요"를 정리한다. 목표가 없으면 안내 문구만.
 */
function goalProgressBlocks(d, goals) {
  const g = computeProgress(d, goals);
  if (!g || !g.rows.length) return [h2("🎯 목표 진행 상황"), p("(목표가 아직 없어요 — 통계 페이지의 🎯 목표(KPI) 설정에서 정할 수 있어요)", { italic: true, color: "gray" })];
  const behind = g.rows.filter((r) => !r.onTrack);
  const summary =
    g.onTrackCount === g.total
      ? `목표 ${g.total}개가 모두 순조로워요 🎉`
      : `목표 ${g.total}개 중 ${g.onTrackCount}개가 순조로워요. 조금 느린 것: ${behind.map((r) => r.label).join(", ")}`;
  const out = [
    h2(`🎯 목표 진행 상황 (${mdOf(g.asOf)} 기준 · 이번 주(월~)·이번 달)`),
    callout(`${summary}
'지금쯤(순조 기준)'은 이 시점에 와 있어야 하는 숫자예요. 그 숫자 이상이면 순조로운 거예요.${g.asOf < todayKst() ? `
※ 통계 기준일이 ${mdOf(g.asOf)}예요. 오늘 숫자까지 반영하려면 '통계 새로 불러오기' 후 다시 저장하세요.` : ""}`, g.onTrackCount === g.total ? "🎉" : "🎯"),
    table(
      ["항목", "목표", "지금까지", "달성률", "진행", "지금쯤(순조 기준)", "상태"],
      g.rows.map((r) => [
        r.label,
        `${fmt(r.target)}${r.unit}`,
        `${fmt(r.now)}${r.unit}`,
        `${r.pct}%`,
        bar(r.ratio),
        `${fmt(r.expected)}${r.unit}`,
        r.projected && r.key === "monthlyViews" ? `${r.onTrack ? "속도 👍" : "조금 느려요"} · 이 속도면 ${fmt(r.projected)}회` : r.onTrack ? "속도 👍" : "조금 느려요",
      ])
    ),
  ];
  out.push(h3("🧭 앞으로 이렇게 해보세요 (위 표 기준)"));
  for (const a of g.advice) out.push(a.tone === "warn" ? todo(a.text) : bullet(`✅ ${a.text}`));
  return out;
}

function memoBlocks(memo) {
  if (!memo || !(memo.did || memo.good || memo.next)) return [p("(아직 회고를 적지 않았어요 — 통계 페이지의 📒 주간 기록에서 적을 수 있어요)", { italic: true, color: "gray" })];
  return [
    memo.did && bullet(`이번 주 한 일: ${memo.did}`),
    memo.good && bullet(`잘 된 점: ${memo.good}`),
    memo.next && bullet(`다음 주 할 일: ${memo.next}`),
    memo.savedAt && p(`회고 저장: ${new Date(memo.savedAt).toLocaleString("ko-KR")}`, { color: "gray" }),
  ].filter(Boolean);
}

const hasMemo = (m) => !!(m && (m.did || m.good || m.next));

/**
 * 그 주 리포트의 "회고" 칸 내용. 그 주 회고가 비어 있는데 바로 다음 주(진행 중인 주)에 적어둔 메모가 있으면
 * 그걸 안내 문구와 함께 대신 보여준다 (주 회고를 이번 주 칸에 적는 경우가 많아서).
 */
function memoSectionBlocks(history, week) {
  const weeks = (history && history.weeks) || {};
  const own = weeks[week] && weeks[week].memo;
  if (hasMemo(own)) return memoBlocks(own);
  const nextWeek = addDays(week, 7);
  const next = weeks[nextWeek] && weeks[nextWeek].memo;
  if (hasMemo(next)) {
    return [p(`(이 주 칸은 비어 있어서, 이어지는 ${nextWeek.slice(5).replace("-", "/")}~ 주에 적은 메모를 보여줘요)`, { italic: true, color: "gray" }), ...memoBlocks(next)];
  }
  return memoBlocks(own);
}

function commonAnalysis(a) {
  return [
    h2("🧭 분석 (저장 시점의 최신 통계 기준)"),
    ...a.insights.map((i) => bullet(`${i.icon} ${i.text}`)),
    h2("📌 앞으로 이렇게 올려보세요"),
    ...a.tips.map((t) => bullet(t)),
    h2("💡 다음 콘텐츠 추천"),
    ...a.ideas.map((i) => todo(`${i.title} — ${i.reason}`)),
  ];
}

function periodTables(pd, label) {
  const out = [];
  if (pd.referers.length) {
    out.push(h2(`🔎 유입 경로 TOP 5 (${label})`));
    out.push(table(["유입 경로", "조회수", "비율"], pd.referers.slice(0, 5).map((r) => [r.name + (r.isSearch ? " (검색)" : ""), fmt(r.cv), `${Math.round(r.share)}%`])));
  }
  const qs = pd.queries.filter((q) => q.query !== "기타");
  if (qs.length) {
    out.push(h2(`🔍 검색어 TOP 10 (${label})`));
    out.push(table(["검색어", "조회수"], qs.slice(0, 10).map((q) => [q.query, fmt(q.cv)])));
  }
  if (pd.topPosts.length) {
    out.push(h2(`🏆 인기 글 TOP 5 (${label})`));
    out.push(table(["순위", "제목", "조회수"], pd.topPosts.slice(0, 5).map((t) => [t.rank, t.title, fmt(t.cv)])));
  }
  return out;
}

function earlyTable(posts) {
  return table(
    ["발행일", "제목", "3일 조회", "평균 대비", "3일 ❤️", "3일 💬", "누적 조회"],
    posts.map((e) => [e.date, e.title + (e.complete ? "" : " (진행 중)"), fmt(e.early3), signed(e.vsAvg), e.earlyLike, e.earlyComment, fmt(e.totalCv)])
  );
}

/** 주간 리포트: 지난주(완료된 주) 기준 */
function buildWeekly(d, { goals, history }) {
  const week = d.lastWeek;
  const end = addDays(week, 6);
  const w = d.weekly.find((x) => x.week === week) || {};
  const prev = d.weekly.find((x) => x.week === addDays(week, -7)) || {};
  const h = (history && history.weeks[week]) || {};
  const goal = h.goalViews ?? (goals && goals.weeklyViews);
  const posts = d.posts.filter((x) => x.date >= week && x.date <= end);
  const earlyOfWeek = d.early ? d.early.posts.filter((e) => e.date >= week && e.date <= end) : [];
  // 이번 주(월요일~통계 기준일, 보통 오늘): 네이버는 주 합계를 끝난 주에만 줘서, 일별 숫자를 더해서 보여준다
  const upTo = d.today || todayKst();
  const mon = mondayOf(upTo);
  const cw = sumDaily(d, mon, upTo);
  const cwPosts = d.posts.filter((x) => x.date >= mon && x.date <= upTo);
  const cwLabel = `이번 주 ${mdOf(mon)}~${mdOf(upTo)} (${untilLabel(upTo)})`;

  const blocks = [
    callout(
      `${cwLabel} · 조회수 ${fmt(cw.cv)}회 · 공감 ${fmt(cw.like)} · 댓글 ${fmt(cw.comment)} · 발행 ${cwPosts.length}개\n` +
        `진행 중인 주라서 숫자가 계속 쌓여요 (${cw.days}일 집계${upTo === todayKst() ? ", 오늘은 아직 하루가 안 끝났어요" : ""}). 아래 \"지난주\"는 월~일이 끝나 확정된 주(${mdOf(week)}~${mdOf(end)})예요.`,
      "🗓️"
    ),
    postedDaysBlock(posts, 7, true, "지난주 "),
    callout(
      `지난주 ${mdOf(week)}~${mdOf(end)} 조회수 ${fmt(w.cv)}회 (전주 ${fmt(prev.cv)}회, ${signed(pct(w.cv, prev.cv))}) · 순방문자 ${fmt(w.uv)}명\n` +
        `공감 ${fmt(h.like)} · 댓글 ${fmt(h.comment)} · 이웃 증감 ${h.relation != null ? (h.relation >= 0 ? "+" : "") + h.relation : "-"} · 발행 ${posts.length}개` +
        (goal ? `\n목표 ${fmt(goal)}회 → 달성률 ${Math.round((w.cv / goal) * 100)}%${w.cv >= goal ? " 🎉" : ""}` : ""),
      "📊"
    ),
    ...goalProgressBlocks(d, goals),
    // 적어둔 주간 회고는 맨 위쪽에 바로 보이게 (저장 후에 회고를 고치면 이 부분만 노션에서 바뀐다)
    h2("✍️ 회고"),
    ...memoSectionBlocks(history, week),
    h2("🎯 지난주 목표 대비"),
    goals
      ? table(["항목", "목표", "실제", "달성률"], [
          ["주간 조회수", fmt(goal), fmt(w.cv), goal ? `${Math.round((w.cv / goal) * 100)}%` : "-"],
          ["주간 발행", fmt(goals.postsPerWeek), fmt(posts.length), goals.postsPerWeek ? `${Math.round((posts.length / goals.postsPerWeek) * 100)}%` : "-"],
          ["주간 공감", fmt(goals.weeklyLikes), fmt(h.like), goals.weeklyLikes && h.like != null ? `${Math.round((h.like / goals.weeklyLikes) * 100)}%` : "-"],
          ["주간 댓글", fmt(goals.weeklyComments), fmt(h.comment), goals.weeklyComments && h.comment != null ? `${Math.round((h.comment / goals.weeklyComments) * 100)}%` : "-"],
        ])
      : p("(목표가 아직 없어요 — 통계 페이지의 🎯 목표(KPI) 설정에서 정할 수 있어요)", { italic: true, color: "gray" }),
    h2(`📝 이번 주 발행한 글 (${mdOf(mon)}~${mdOf(upTo)} ${untilLabel(upTo)})`),
    ...(cwPosts.length ? cwPosts.map((x) => bullet(`${x.date} ${x.title}`)) : [p("(아직 발행한 글 없음)", { color: "gray" })]),
    h2(`📝 지난주 발행한 글 (${mdOf(week)}~${mdOf(end)})`),
    ...(posts.length ? posts.map((x) => bullet(`${x.date} ${x.title}`)) : [p("(발행한 글 없음)", { color: "gray" })]),
  ];
  if (earlyOfWeek.length) blocks.push(h3("🚀 발행 후 3일 성과"), earlyTable(earlyOfWeek));
  blocks.push(...periodTables(d.week, "지난주"));
  blocks.push(...commonAnalysis(d.analysis));
  blocks.push(divider(), p(`블로그 자동화 대시보드에서 ${new Date().toLocaleString("ko-KR")}에 저장`, { color: "gray" }));

  return {
    key: `week:${week}`,
    icon: "📊",
    title: `📊 ${mdOf(todayKst())} 주간 블로그 리포트 (${mdOf(mon)}~${mdOf(upTo)} ${untilLabel(upTo)})`,
    date: { start: todayKst() },
    blocks,
  };
}

/** 월간 리포트: 지난달(완료된 달) 기준 */
function buildMonthly(d, { goals, history }) {
  const month = d.lastMonth; // YYYY-MM
  const m = d.monthly.find((x) => x.month === month) || {};
  const prevMonth = (() => {
    const [y, mm] = month.split("-").map(Number);
    const dt = new Date(y, mm - 2, 1);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}`;
  })();
  const pm = d.monthly.find((x) => x.month === prevMonth) || {};
  const [y, mm] = month.split("-").map(Number);
  const start = `${month}-01`;
  const end = ymd(new Date(y, mm, 0));
  const posts = d.posts.filter((x) => x.date >= start && x.date <= end);
  const weeks = history ? Object.values(history.weeks).filter((w) => w.week >= addDays(start, -6) && w.week <= end).sort((a, b) => a.week.localeCompare(b.week)) : [];
  // 그 달이 끝나기 전에 세운 목표일 때만 달성률을 보여준다 (나중에 세운 목표를 소급 적용하지 않음)
  const goal = goals && goals.monthlyViews && goals.updatedAt && goals.updatedAt.slice(0, 10) <= end ? goals.monthlyViews : null;

  // 이번 달(1일~통계 기준일, 보통 오늘): 네이버는 월 합계를 끝난 달에만 줘서, 일별 숫자를 더해서 보여준다
  const upTo = d.today || todayKst();
  const curMonth = upTo.slice(0, 7);
  const cm = curMonth !== month ? sumDaily(d, `${curMonth}-01`, upTo) : null;
  const cmPosts = curMonth !== month ? d.posts.filter((x) => x.date >= `${curMonth}-01` && x.date <= upTo) : [];

  const blocks = [
    ...(cm
      ? [callout(`이번 달 ${Number(curMonth.slice(5))}월 ${mdOf(`${curMonth}-01`)}~${mdOf(upTo)} (${untilLabel(upTo)}) · 조회수 ${fmt(cm.cv)}회 · 공감 ${fmt(cm.like)} · 댓글 ${fmt(cm.comment)} · 발행 ${cmPosts.length}개\n진행 중인 달이라 숫자가 계속 쌓여요. 아래는 월이 끝나 확정된 ${Number(month.slice(5))}월 결과예요.`, "🗓️")]
      : []),
    postedDaysBlock(posts, end.slice(8, 10) * 1, false, `${Number(month.slice(5))}월 `),
    callout(
      `${month} 조회수 ${fmt(m.cv)}회 (전월 ${fmt(pm.cv)}회, ${signed(pct(m.cv, pm.cv))})\n` +
        `서로이웃 ${fmt(m.friend)} · 이웃 ${fmt(m.follow)} · 그 외 ${fmt(m.etc)} · 발행 ${posts.length}개` +
        (goal ? `\n월간 목표 ${fmt(goal)}회 → 달성률 ${Math.round(((m.cv || 0) / goal) * 100)}%` : ""),
      "🗓️"
    ),
    ...goalProgressBlocks(d, goals),
  ];
  if (weeks.length) {
    blocks.push(h2("📅 주별 흐름"));
    blocks.push(table(["주 시작", "조회수", "목표", "공감", "댓글", "발행"], weeks.map((w) => [w.week, fmt(w.cv), fmt(w.goalViews), w.like ?? "-", w.comment ?? "-", w.posts ?? "-"])));
  }
  blocks.push(h2("📝 이번 달 발행한 글"), ...(posts.length ? posts.map((x) => bullet(`${x.date} ${x.title}`)) : [p("(RSS에 남아 있는 글 중 이 달 발행 글이 없어요)", { color: "gray" })]));
  blocks.push(...periodTables(d.month, month));
  blocks.push(...commonAnalysis(d.analysis));
  const memos = weeks.filter((w) => w.memo && (w.memo.did || w.memo.good || w.memo.next));
  blocks.push(h2("✍️ 주간 회고 모음"));
  if (memos.length) for (const w of memos) blocks.push(h3(`${w.week} 주`), ...memoBlocks(w.memo));
  else blocks.push(p("(이 달에 적은 주간 회고가 없어요)", { italic: true, color: "gray" }));
  blocks.push(h2("🪞 이번 달 돌아보기"), quote("이번 달 가장 잘 된 것 / 아쉬운 것 / 다음 달 집중할 것을 여기에 적어보세요."));
  blocks.push(divider(), p(`블로그 자동화 대시보드에서 ${new Date().toLocaleString("ko-KR")}에 저장`, { color: "gray" }));

  return { key: `month:${month}`, icon: "🗓️", title: `🗓️ ${mdOf(todayKst())} 월간 블로그 리포트 (${Number(month.slice(5))}월 결과${cm ? ` · ${Number(curMonth.slice(5))}월은 ${mdOf(upTo)}${upTo === todayKst() ? "(오늘)" : ""}까지` : ""})`, date: { start: todayKst() }, blocks };
}

/** 회고만 담은 짧은 페이지 (지난주가 아닌 예전 주에 회고를 적었는데 그 주 리포트가 노션에 없을 때) */
function buildMemoOnly(rec) {
  const week = rec.week;
  const end = addDays(week, 6);
  return {
    key: `week:${week}`,
    icon: "✍️",
    title: `✍️ ${mdOf(todayKst())} 주간 회고 (${mdOf(week)}~${mdOf(end)} 기준)`,
    date: { start: todayKst() },
    blocks: [
      callout(
        `조회수 ${fmt(rec.cv)}회${rec.goalViews ? ` (목표 ${fmt(rec.goalViews)}회, ${Math.round((rec.cv / rec.goalViews) * 100)}%)` : ""} · 공감 ${fmt(rec.like)} · 댓글 ${fmt(rec.comment)} · 발행 ${fmt(rec.posts)}개`,
        "📊"
      ),
      ...(rec.postTitles && rec.postTitles.length ? [h3("이번 주 발행한 글"), ...rec.postTitles.map((t) => bullet(t))] : []),
      h2("✍️ 회고"),
      ...memoBlocks(rec.memo),
      divider(),
      p(`블로그 자동화 대시보드에서 ${new Date().toLocaleString("ko-KR")}에 저장`, { color: "gray" }),
    ],
  };
}

const MEMO_HEADING = "✍️ 회고";

module.exports = { buildWeekly, buildMonthly, buildMemoOnly, memoBlocks, memoSectionBlocks, addDays, MEMO_HEADING, memoHeading: () => h2(MEMO_HEADING) };
