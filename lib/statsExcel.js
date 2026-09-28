// 성과 통계를 엑셀(.xlsx)로 만든다. 시트: 요약 / 일별 / 주별 / 월별 / 유입경로 / 검색어 / 인기글 / 시간대 / 성별·연령
const ExcelJS = require("exceljs");

const GREEN = "FF03C75A";
const HEAD_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE6F9EE" } };

function sheet(wb, name, columns, rows) {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width || 14, style: c.style || {} }));
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).fill = HEAD_FILL;
  for (const r of rows) ws.addRow(r);
  return ws;
}

async function buildWorkbook(d, { goals, history } = {}) {
  const wb = new ExcelJS.Workbook();
  wb.creator = `${require("./config").blogName()} 블로그 자동화`;
  wb.created = new Date();
  const a = d.analysis;
  const s = a.summary;

  // ---- 요약 ----
  const ws = wb.addWorksheet("요약");
  ws.columns = [{ width: 26 }, { width: 90 }];
  const title = ws.addRow([`블로그 성과 리포트 (${d.today} 기준)`]);
  title.font = { bold: true, size: 14, color: { argb: GREEN } };
  ws.addRow([]);
  const kv = [
    ["지난주 조회수", s.lastWeekCv],
    ["그 전 주 조회수", s.prevWeekCv],
    ["주간 증감(%)", s.weekChange],
    ["최근 4주 평균(주)", s.avg4Weeks],
    ["이번 달 누적 조회수", s.monthToDate],
    ["이번 달 예상 조회수", s.projectedMonth],
    ["지난달 조회수", s.lastMonthCv],
    ["검색 유입 비율(%)", s.searchShare],
    ["최근 30일 발행 글 수", s.posts30],
    ["조회수 높은 요일", s.bestDow ? `${s.bestDow}요일` : "-"],
    ["많이 읽히는 시간", (s.topHours || []).map((h) => `${h}시`).join(", ")],
  ];
  for (const [k, v] of kv) {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { bold: true };
  }
  const section = (label, lines) => {
    ws.addRow([]);
    const h = ws.addRow([label]);
    h.font = { bold: true, size: 12 };
    for (const line of lines) ws.addRow(["", line]).getCell(2).alignment = { wrapText: true, vertical: "top" };
  };
  section("한눈에 보기", a.insights.map((i) => `${i.icon} ${i.text}`));
  section("앞으로 이렇게 올려보세요", a.tips.map((t) => `• ${t}`));
  section("다음 콘텐츠 추천", a.ideas.map((i) => `• ${i.title} — ${i.reason}`));

  // ---- 데이터 시트 ----
  const postsByDate = {};
  for (const p of d.posts) (postsByDate[p.date] ||= []).push(p.title);
  // ---- 기록 (주간 성과 + 목표 + 회고) ----
  if (history && history.weeks) {
    sheet(wb, "주간 기록", [
      { header: "주 시작(월)", key: "week", width: 12 },
      { header: "조회수", key: "cv", width: 9 },
      { header: "목표", key: "goalViews", width: 9 },
      { header: "달성률(%)", key: "rate", width: 10 },
      { header: "순방문자", key: "uv", width: 9 },
      { header: "공감", key: "like", width: 7 },
      { header: "댓글", key: "comment", width: 7 },
      { header: "이웃 증감", key: "relation", width: 9 },
      { header: "발행 수", key: "posts", width: 8 },
      { header: "이번 주 한 일", key: "did", width: 40 },
      { header: "잘 된 점", key: "good", width: 40 },
      { header: "다음 주 할 일", key: "next", width: 40 },
    ], Object.values(history.weeks).sort((a, b) => b.week.localeCompare(a.week)).map((w) => ({
      ...w,
      week: w.week + (w.inProgress ? " (진행 중)" : ""),
      rate: w.goalViews ? Math.round((w.cv / w.goalViews) * 100) : null,
      did: w.memo && w.memo.did, good: w.memo && w.memo.good, next: w.memo && w.memo.next,
    })));
  }
  if (goals) {
    sheet(wb, "목표", [
      { header: "항목", key: "k", width: 22 },
      { header: "목표", key: "v", width: 12 },
    ], [
      { k: "주간 조회수", v: goals.weeklyViews },
      { k: "월간 조회수", v: goals.monthlyViews },
      { k: "주간 발행 수", v: goals.postsPerWeek },
      { k: "주간 공감", v: goals.weeklyLikes },
      { k: "주간 댓글", v: goals.weeklyComments },
      { k: "설정일", v: goals.updatedAt ? goals.updatedAt.slice(0, 10) : "" },
    ]);
  }

  if (d.early && d.early.posts.length) {
    sheet(wb, "글별 초반 성과", [
      { header: "발행일", key: "date", width: 12 },
      { header: "제목", key: "title", width: 50 },
      { header: "발행일 조회", key: "d0", width: 10 },
      { header: "+1일", key: "d1", width: 7 },
      { header: "+2일", key: "d2", width: 7 },
      { header: "+3일", key: "d3", width: 7 },
      { header: "3일 조회수", key: "early3", width: 10 },
      { header: "평균 대비(%)", key: "vsAvg", width: 11 },
      { header: "3일 공감", key: "earlyLike", width: 9 },
      { header: "3일 댓글", key: "earlyComment", width: 9 },
      { header: "누적 조회수", key: "totalCv", width: 10 },
      { header: "누적 공감", key: "totalLike", width: 9 },
      { header: "누적 댓글", key: "totalComment", width: 9 },
      { header: "3일 비중(%)", key: "earlyShare", width: 10 },
    ], d.early.posts.map((e) => ({ ...e, d0: e.days[0], d1: e.days[1], d2: e.days[2], d3: e.days[3], title: e.title + (e.complete ? "" : " (3일 안 지남)") })));
  }

  sheet(wb, "일별(30일)", [
    { header: "날짜", key: "date", width: 12 },
    { header: "요일", key: "dow", width: 6 },
    { header: "조회수", key: "cv", width: 9 },
    { header: "공감", key: "like", width: 7 },
    { header: "댓글", key: "comment", width: 7 },
    { header: "이웃 증감", key: "relation", width: 9 },
    { header: "그날 올린 글", key: "posts", width: 70 },
  ], d.daily.map((x) => ({ ...x, posts: (postsByDate[x.date] || []).join(" / ") })));

  sheet(wb, "주별", [
    { header: "주 시작(월)", key: "week", width: 12 },
    { header: "조회수", key: "cv", width: 10 },
    { header: "순방문자", key: "uv", width: 10 },
    { header: "서로이웃 조회", key: "friend", width: 13 },
    { header: "이웃 조회", key: "follow", width: 10 },
    { header: "그 외 조회", key: "etc", width: 10 },
  ], d.weekly);

  sheet(wb, "월별", [
    { header: "월", key: "month", width: 10 },
    { header: "조회수", key: "cv", width: 10 },
    { header: "서로이웃 조회", key: "friend", width: 13 },
    { header: "이웃 조회", key: "follow", width: 10 },
    { header: "그 외 조회", key: "etc", width: 10 },
  ], d.monthly);

  const refRows = [
    ...d.week.referers.map((r) => ({ period: `지난주(${d.lastWeek}~)`, ...r, isSearch: r.isSearch ? "검색" : "", share: Math.round(r.share * 10) / 10 })),
    ...d.month.referers.map((r) => ({ period: `지난달(${d.lastMonth})`, ...r, isSearch: r.isSearch ? "검색" : "", share: Math.round(r.share * 10) / 10 })),
  ];
  sheet(wb, "유입경로", [
    { header: "기간", key: "period", width: 20 },
    { header: "유입 경로", key: "name", width: 30 },
    { header: "검색 여부", key: "isSearch", width: 10 },
    { header: "조회수", key: "cv", width: 10 },
    { header: "비율(%)", key: "share", width: 10 },
  ], refRows);

  sheet(wb, "검색어", [
    { header: "기간", key: "period", width: 20 },
    { header: "검색어", key: "query", width: 34 },
    { header: "조회수", key: "cv", width: 10 },
    { header: "비율(%)", key: "share", width: 10 },
  ], [
    ...d.week.queries.map((q) => ({ period: `지난주(${d.lastWeek}~)`, ...q, share: Math.round(q.share * 10) / 10 })),
    ...d.month.queries.map((q) => ({ period: `지난달(${d.lastMonth})`, ...q, share: Math.round(q.share * 10) / 10 })),
  ]);

  sheet(wb, "인기글", [
    { header: "기간", key: "period", width: 20 },
    { header: "순위", key: "rank", width: 6 },
    { header: "제목", key: "title", width: 70 },
    { header: "조회수", key: "cv", width: 10 },
    { header: "작성일", key: "createDate", width: 14 },
  ], [
    ...d.week.topPosts.map((p) => ({ period: `지난주(${d.lastWeek}~)`, ...p })),
    ...d.month.topPosts.map((p) => ({ period: `지난달(${d.lastMonth})`, ...p })),
  ]);

  sheet(wb, "시간대(지난주)", [
    { header: "시", key: "hour", width: 6 },
    { header: "조회수", key: "cv", width: 10 },
  ], d.hour);

  sheet(wb, "성별·연령(지난주)", [
    { header: "나이대", key: "age", width: 10 },
    { header: "남성 조회수", key: "m", width: 12 },
    { header: "여성 조회수", key: "f", width: 12 },
  ], d.demo);

  return wb;
}

module.exports = { buildWorkbook };
