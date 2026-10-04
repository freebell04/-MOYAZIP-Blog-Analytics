// 목표(KPI) 진행 상황: "이번 주(월~) · 이번 달" 기준으로 목표 대비 얼마나 왔는지, 지금쯤 와 있어야 할 위치(속도)는 어디인지 계산하고
// 남은 기간에 무엇을 하면 좋을지 제안한다. (성과 통계 화면의 🎯 목표 진행 상황과 같은 계산 — 노션 리포트에서 쓴다)

const GOAL_FIELDS = [
  { k: "weeklyViews", label: "주간 조회수", unit: "회", scope: "week" },
  { k: "monthlyViews", label: "월간 조회수", unit: "회", scope: "month" },
  { k: "postsPerWeek", label: "주간 발행", unit: "개", scope: "week" },
  { k: "weeklyLikes", label: "주간 공감", unit: "개", scope: "week" },
  { k: "weeklyComments", label: "주간 댓글", unit: "개", scope: "week" },
];

const fmt = (n) => (n == null ? "-" : Number(n).toLocaleString("ko-KR"));
const sumOf = (a, k) => a.reduce((s, x) => s + (x[k] || 0), 0);

/** 이번 주 월요일 (YYYY-MM-DD) — today도 YYYY-MM-DD */
function mondayOf(today) {
  const d = new Date(today + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // 월=0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/**
 * @param d     성과 통계 캐시 (d.daily, d.posts, d.today, d.analysis.summary.projectedMonth)
 * @param goals 저장된 목표 {weeklyViews, monthlyViews, postsPerWeek, weeklyLikes, weeklyComments}
 * @param now   기준 시각 (한국 시간으로 계산). 시험용으로 바꿀 수 있다
 * @returns {null | {asOf, rows, onTrackCount, total, advice}}
 */
function computeProgress(d, goals, now = new Date()) {
  if (!d || !d.daily || !goals) return null;
  const kst = new Date(now.getTime() + 9 * 3600000);
  const today = d.today || kst.toISOString().slice(0, 10);
  const realToday = kst.toISOString().slice(0, 10);
  // 오늘은 아직 진행 중이라 하루의 일부만 친다 (통계가 어제 이전 것이면 그날은 하루가 다 지난 것으로 본다)
  const dayFrac = today < realToday ? 1 : (kst.getUTCHours() * 60 + kst.getUTCMinutes()) / 1440;
  const mon = mondayOf(today);
  const wk = d.daily.filter((x) => x.date >= mon && x.date <= today);
  const mo = d.daily.filter((x) => x.date.startsWith(today.slice(0, 7)) && x.date <= today);
  const [y, m] = today.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const weekElapsed = (wk.length - 1 + dayFrac) / 7;
  const monthElapsed = (mo.length - 1 + dayFrac) / daysInMonth;
  const weekDaysLeft = Math.max(0.5, 7 - weekElapsed * 7); // 오늘 남은 시간 포함
  const monthDaysLeft = Math.max(0.5, daysInMonth - monthElapsed * daysInMonth);
  const cur = {
    weeklyViews: sumOf(wk, "cv"),
    monthlyViews: sumOf(mo, "cv"),
    postsPerWeek: (d.posts || []).filter((p) => p.date >= mon && p.date <= today).length,
    weeklyLikes: sumOf(wk, "like"),
    weeklyComments: sumOf(wk, "comment"),
  };
  const projected = d.analysis && d.analysis.summary ? d.analysis.summary.projectedMonth : null;

  const rows = [];
  for (const g of GOAL_FIELDS) {
    const target = goals[g.k];
    if (!target) continue;
    const now_ = cur[g.k];
    const pace = g.scope === "month" ? monthElapsed : weekElapsed;
    const expected = Math.round(target * pace);
    const onTrack = now_ >= expected; // 성과 통계 화면과 같은 기준 (지금쯤 와 있어야 할 위치 이상이면 순조로움)
    rows.push({
      key: g.k, label: g.label, unit: g.unit, scope: g.scope,
      target, now: now_, ratio: now_ / target, pct: Math.round((now_ / target) * 100),
      expected, onTrack, projected: g.k === "monthlyViews" ? projected : null,
      avgPerDay: now_ / Math.max(0.5, pace * (g.scope === "month" ? daysInMonth : 7)), // 지금까지 하루 평균
      daysLeft: g.scope === "month" ? monthDaysLeft : weekDaysLeft,
    });
  }
  const onTrackCount = rows.filter((r) => r.onTrack).length;
  return { asOf: today, rows, onTrackCount, total: rows.length, advice: rows.map(adviceFor).filter(Boolean) };
}

const days1 = (n) => (n < 1 ? "오늘 남은 시간" : `남은 ${Math.ceil(n)}일`);

/** 목표 하나에 대한 "앞으로 이렇게" 한 문장 (달성했으면 칭찬, 뒤처졌으면 하루에 얼마씩 더 필요한지) */
function adviceFor(r) {
  const left = Math.max(0, r.target - r.now);
  const perDay = (n) => Math.max(1, Math.ceil(n / Math.max(1, Math.ceil(r.daysLeft))));
  if (left === 0) return { label: r.label, tone: "good", text: `${r.label}: 목표를 이미 달성했어요 🎉 (${fmt(r.now)}/${fmt(r.target)}${r.unit}). 이제 다음 목표를 조금 높여봐도 좋아요.` };
  switch (r.key) {
    case "weeklyViews": {
      const need = perDay(left);
      const hard = r.avgPerDay && need > r.avgPerDay * 1.6; // 지금 페이스의 1.6배 넘게 필요하면 이번 주는 빠듯함
      return r.onTrack
        ? { label: r.label, tone: "good", text: `주간 조회수: 순조로워요. 이 페이스로 ${days1(r.daysLeft)} 동안 이어가면 목표(${fmt(r.target)}회)에 닿아요.` }
        : { label: r.label, tone: "warn", text: `주간 조회수: 목표까지 ${fmt(left)}회 남았고 ${days1(r.daysLeft)}이라 하루 평균 약 ${fmt(need)}회가 필요해요 (지금까지 하루 평균 ${fmt(Math.round(r.avgPerDay))}회). ${hard ? "이번 주 목표는 빠듯하니, 다음 주를 위해 " : ""}조회수 상위 글의 후속편·업데이트 글을 올리거나, 검색어를 제목 앞쪽에 넣은 글로 검색 유입을 끌어보세요.` };
    }
    case "monthlyViews": {
      const need = perDay(left);
      if (r.projected && r.projected >= r.target) return { label: r.label, tone: "good", text: `월간 조회수: 지금 속도면 이번 달 약 ${fmt(r.projected)}회로 목표(${fmt(r.target)}회)를 넘겨요. 지금 흐름을 유지하세요.` };
      const gap = r.projected ? r.target - r.projected : null;
      return { label: r.label, tone: r.onTrack ? "good" : "warn", text: `월간 조회수: ${r.projected ? `이 속도면 약 ${fmt(r.projected)}회(목표보다 ${fmt(gap)}회 부족)예요. ` : ""}목표까지 ${fmt(left)}회 남았고 ${days1(r.daysLeft)}이라 하루 평균 약 ${fmt(need)}회가 필요해요. 잘 읽히는 글 주제로 글을 1~2개 더 올려보세요.` };
    }
    case "postsPerWeek": {
      const more = left;
      const dl = Math.max(1, Math.ceil(r.daysLeft));
      if (r.onTrack) return { label: r.label, tone: "good", text: `주간 발행: 순조로워요. ${days1(r.daysLeft)} 안에 ${more}개만 더 올리면 목표(${r.target}개)를 채워요.` };
      const how = more > dl
        ? `${days1(r.daysLeft)} 안에 ${more}개를 올려야 해서 하루에 1개 넘게 올려야 해요. 이번 주가 빠듯하면 다음 주에는 월·수·금처럼 요일을 정해서 올려보세요.`
        : `${days1(r.daysLeft)} 안에 ${more}개 — ${Math.max(1, Math.floor(dl / more))}일에 1개꼴로 올리면 맞출 수 있어요.`;
      return { label: r.label, tone: "warn", text: `주간 발행: ${more}개를 더 올려야 목표(${r.target}개)예요. ${how} 짧은 글(후기·정리)부터 가볍게 올려보세요.` };
    }
    case "weeklyLikes":
    case "weeklyComments": {
      const what = r.key === "weeklyLikes" ? "공감" : "댓글";
      const need = perDay(left);
      return r.onTrack
        ? { label: r.label, tone: "good", text: `주간 ${what}: 순조로워요. 지금처럼 이웃 글에 ${what}해주면 서로 찾아와요.` }
        : { label: r.label, tone: "warn", text: `주간 ${what}: ${fmt(left)}개 남았어요. 하루 평균 약 ${fmt(need)}개가 필요해요. 이웃 소통에서 새 글을 올린 이웃에게 먼저 ${what}·답방을 남겨보세요.` };
    }
  }
  return null;
}

/** 10칸짜리 글자 막대 (노션 표 안에서 진행 정도가 한눈에 보이게) */
function bar(ratio) {
  const n = Math.max(0, Math.min(10, Math.round(ratio * 10)));
  return "█".repeat(n) + "░".repeat(10 - n);
}

module.exports = { computeProgress, adviceFor, bar, GOAL_FIELDS, mondayOf };
