// 무료 체험 후기 설문 안내: 체험 3일째·7일째·마지막 날에 설문 창을 한 번씩 띄운다.
//  - 3일째: [설문 참여하기] [닫기]       (닫기 = 이 안내는 다시 안 보여줌)
//  - 7일째·마지막 날: [설문 참여하기] [나중에]  (나중에 = 이번 안내는 넘기고 다음 안내 때 다시)
//  - 설문 참여하기를 누르면 이후 안내는 더 띄우지 않는다
//  - 체험 키(기간 15일 이하)에만 보인다. 2주를 넘겨 쓰는 구매 키는 띄우지 않는다
const path = require("path");
const fs = require("fs");

const SURVEY_URL = process.env.NBH_SURVEY_URL || "https://docs.google.com/forms/d/e/1FAIpQLSdOCZH-GipsKW9yI26NgzvRUHfm-k4PWzKJGIXF2vI1m_JX3w/viewform";
const STATE_PATH = path.join(__dirname, "..", "data", "survey.json");
const MILESTONES = [3, 7, 14]; // 체험 N일째 (시작한 날 = 1일째). 14는 "마지막 날"로 본다
const TRIAL_MAX_DAYS = 15;

const dayDiff = (a, b) => Math.round((new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000);

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}
function writeState(s) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

/** 지금 띄울 안내가 있는지. st = license.status() 결과, today = 'YYYY-MM-DD' */
function pending(st, today, state = readState()) {
  if (!st || !st.ok || !st.start || !st.end) return { show: false };
  const length = dayDiff(st.start, st.end) + 1;
  if (length > TRIAL_MAX_DAYS) return { show: false }; // 2주를 넘기는 키(구매)
  if (state.done) return { show: false }; // 이미 설문에 참여함
  const dayNum = dayDiff(st.start, today) + 1;
  // 지나온 안내 중 가장 마지막 것 하나만. 마지막 날은 끝 날짜로 판단(체험 기간이 14일이 아닌 키도 맞춘다)
  const reached = MILESTONES.filter((m) => (m === 14 ? today >= st.end : dayNum >= m));
  const m = reached[reached.length - 1];
  if (!m) return { show: false };
  if ((state.handled || {})[m]) return { show: false };
  if (state.laterDate === today) return { show: false };
  return { show: true, milestone: m, day: dayNum, last: m === 14, canLater: m >= 7, url: SURVEY_URL, daysLeft: st.daysLeft };
}

/** action: open(참여하기) | close(닫기) | later(나중에) */
function record(st, today, action) {
  const state = readState();
  const p = pending(st, today, state);
  if (action === "open") state.done = true;
  else if (action === "close" && p.milestone) (state.handled ||= {})[p.milestone] = true;
  else if (action === "later") {
    // 나중에 = 이번 안내는 넘기고, 다음 안내(7일째 → 마지막 날)에 다시 묻는다
    state.laterDate = today;
    if (p.milestone) (state.handled ||= {})[p.milestone] = true;
  }
  else return state;
  writeState(state);
  return state;
}

module.exports = { pending, record, SURVEY_URL, MILESTONES };
