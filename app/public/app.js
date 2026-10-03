const $ = (sel) => document.querySelector(sel);

let selectedItems = [];
let selectedImagePaths = {}; // { query: path }
let currentPost = null; // 최근 /api/generate 결과 (introLines/sectionHeadings/sections 포함)

let loginPollTimer = null;

async function refreshLoginStatus() {
  const r = await fetch("/api/session-status").then((r) => r.json());
  const el = $("#login-status");

  if (r.loggedIn) {
    el.textContent = "로그인됨";
    el.className = "status-pill ok";
    stopLoginPolling();
    $("#login-btn").disabled = false;
  } else if (r.watching) {
    el.textContent = "크롬에서 로그인해주세요 (자동 감지 중...)";
    el.className = "status-pill no";
    $("#login-btn").disabled = true;
  } else {
    el.textContent = r.watchError ? "로그인 실패: " + r.watchError : "로그인 필요";
    el.className = "status-pill no";
    $("#login-btn").disabled = false;
    stopLoginPolling();
  }
  return r;
}

function startLoginPolling() {
  stopLoginPolling();
  loginPollTimer = setInterval(refreshLoginStatus, 2000);
}

function stopLoginPolling() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer);
    loginPollTimer = null;
  }
}

$("#login-btn").addEventListener("click", async () => {
  $("#login-btn").disabled = true;
  $("#login-status").textContent = "크롬 창을 여는 중...";
  try {
    const r = await fetch("/api/login", { method: "POST" }).then((r) => {
      if (!r.ok) return r.json().then((e) => Promise.reject(e));
      return r.json();
    });
    if (r.alreadyLoggedIn) {
      refreshLoginStatus();
      return;
    }
    // 크롬 창이 열렸으니, 사용자가 로그인만 하면 자동으로 감지되도록 폴링 시작
    startLoginPolling();
  } catch (e) {
    alert("로그인 시작 실패: " + (e.error || e.message));
    $("#login-btn").disabled = false;
  }
});

// ---- 글감 찾기: 인기글 / 나무위키 / 후기·리뷰 / 뉴스로 나눠서 보여주고, 🔄로 새 글감을 다시 찾는다 ----
const GROUPS = [
  { key: "neighbor", icon: "👥", name: "이웃 블로거 글", type: "이웃 글", cls: "neighbor", hint: "이 주제로 이웃들이 최근 쓴 글 — 어떤 점이 인기인지 참고용" },
  { key: "popular", icon: "🔥", name: "인기글", type: "블로그", cls: "blog", hint: "지금 많이 읽히는 글 — 주제 잡기·제목 참고용" },
  { key: "namu", icon: "📚", name: "나무위키", type: "나무위키", cls: "wiki", hint: "정확한 개념·배경을 확인할 수 있는 근거 자료" },
  { key: "review", icon: "⭐", name: "후기·리뷰", type: "후기", cls: "review", hint: "직접 써보고 쓴 글 — 경험담·장단점 참고용" },
  { key: "news", icon: "📰", name: "최신 뉴스", type: "뉴스", cls: "news", hint: "요즘 이슈·수치 확인용" },
];
let searchState = { keyword: "", round: 0, shown: new Set(), all: [] };
let searchCtx = null; // 이웃 소통·성과 통계에서 넘어온 주제 정보 {keyword,title,questions,refs}
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function itemHtml(item, i, checked) {
  return `
    <label class="item">
      <input type="checkbox" data-idx="${i}" class="pick"${checked ? " checked" : ""} />
      <div>
        <span class="tag ${item.cls}">${esc(item.type)}</span>
        <a href="${esc(item.link)}" target="_blank">${esc(item.title)}</a>
        <small>${esc(item.snippet || "")}</small>
      </div>
    </label>`;
}

function renderSearch(r, pinned) {
  // 이번에 새로 찾은 글 + 지난번에 체크해둔 글(맨 위에 고정)
  const all = [];
  const sections = [];
  if (pinned.length) {
    sections.push(`<h3 class="grp-title">✅ 선택해둔 글감 <small>(다시 찾아도 유지돼요)</small></h3>` + pinned.map((it) => (all.push(it), itemHtml(it, all.length - 1, true))).join(""));
  }
  for (const g of GROUPS) {
    const src = g.key === "neighbor" ? (searchCtx ? searchCtx.refs || [] : []).map((x) => ({ title: x.title, link: x.link, snippet: (x.nick ? x.nick + " 님의 글" : "") })) : r[g.key] || [];
    if (g.key === "neighbor" && !src.length) continue; // 이웃 글 정보가 없으면 이 묶음은 숨김
    const list = src.filter((x) => !pinned.some((p) => p.link === x.link)).map((x) => ({ ...x, type: g.type, cls: g.cls }));
    let body = list.map((it) => (all.push(it), itemHtml(it, all.length - 1, false))).join("");
    if (g.key === "namu" && !list.length) {
      body = `<div class="empty-state">이 키워드의 새 나무위키 문서가 없어요. <a href="${esc(r.namuSearchUrl)}" target="_blank">나무위키에서 직접 검색 ↗</a></div>`;
    } else if (!list.length) {
      body = `<div class="empty-state">새로 찾은 글이 없어요.</div>`;
    }
    sections.push(`<h3 class="grp-title">${g.icon} ${g.name} <small>${esc(g.hint)}</small></h3>` + body);
  }
  searchState.all = all;

  const box = $("#search-results");
  box.classList.remove("empty-state");
  box.innerHTML =
    sections.join("") +
    `<div class="reload-row"><button id="reload-btn" class="btn btn-outline">🔄 다른 글감 새로 찾기</button>
       <small>${searchState.round + 1}번째 결과 · 누를 때마다 새로운 글·다른 검색어로 다시 찾아요 (체크한 글감은 그대로 남아요)</small></div>`;

  box.querySelectorAll(".pick").forEach((cb) => {
    cb.addEventListener("change", () => {
      const item = all[Number(cb.dataset.idx)];
      if (cb.checked) selectedItems.push(item);
      else selectedItems = selectedItems.filter((x) => x.link !== item.link);
    });
  });
  // 제목 링크는 체크박스(label) 안에 있어서 target="_blank"가 브라우저에 따라 새 탭 대신
  // 현재 화면을 바꿔버리는 경우가 있다. 확실하게 새 창으로 열리도록 직접 처리한다.
  box.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.open(a.href, "_blank", "noopener,noreferrer");
    });
  });
  $("#reload-btn").addEventListener("click", () => runSearch(searchState.keyword, searchState.round + 1));
}

async function runSearch(keyword, round) {
  const pinned = selectedItems.slice(); // 체크해둔 글감은 다시 찾아도 유지
  $("#search-btn").disabled = true;
  if ($("#reload-btn")) $("#reload-btn").disabled = true;
  $("#search-results").classList.add("empty-state");
  if (!round) $("#search-results").textContent = "검색 중... (인기글·나무위키·후기를 찾는 중이라 10~20초 걸려요)";
  else $("#reload-btn").textContent = "찾는 중...";

  const exclude = round ? [...searchState.shown] : [];
  const r = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword, round, exclude, ctx: searchCtx ? { titles: [searchCtx.title, ...(searchCtx.refs || []).map((x) => x.title)] } : undefined }),
  })
    .then((r) => r.json())
    .catch((e) => ({ error: e.message }));
  $("#search-btn").disabled = false;

  if (r.error) {
    $("#search-results").textContent = "오류: " + r.error;
    return;
  }
  if (!round) searchState = { keyword, round: 0, shown: new Set(), all: [] };
  searchState.round = round;
  for (const g of GROUPS) for (const x of r[g.key] || []) searchState.shown.add(x.link);
  if (r.richKeyword && r.richKeyword !== keyword) $("#ctx-rich") && ($("#ctx-rich").textContent = r.richKeyword);
  if (!round) selectedItems = [];
  renderSearch(r, round ? pinned : []);
  if (r.exhausted) $("#reload-btn").insertAdjacentHTML("afterend", `<p class="hint">더 이상 새로 보여줄 글이 없어요. 다른 키워드를 넣어보세요.</p>`);

  $("#step-generate").hidden = false;
  setActiveStep(2);
}

$("#search-btn").addEventListener("click", () => {
  const keyword = $("#keyword").value.trim();
  if (!keyword) return alert("키워드를 입력해주세요.");
  if (searchCtx && keyword !== searchCtx.keyword) { searchCtx = null; renderCtxBox(); } // 직접 다른 키워드를 검색하면 이어받은 주제 정보는 쓰지 않는다
  runSearch(keyword, 0);
});

$("#open-editor-btn").addEventListener("click", async () => {
  $("#open-editor-btn").disabled = true;
  $("#open-editor-status").textContent = "블로그 → 글쓰기 → 템플릿 적용 중입니다... (크롬 창을 확인하세요)";
  const r = await fetch("/api/open-editor", { method: "POST" }).then((r) => r.json());
  $("#open-editor-btn").disabled = false;
  $("#open-editor-status").textContent = r.error
    ? "오류: " + r.error
    : "완료! 크롬 창에서 템플릿이 적용된 에디터를 확인하고 직접 타이핑해주세요.";
});

function renderPostPreview(r) {
  const el = $("#post-preview");
  const intro = (r.introLines || []).join(" / ");
  const parts = [`<h4>INTRO</h4><p>${escapeHtml(intro)}</p>`];
  (r.sections || []).forEach((body, i) => {
    const headingLines = (r.sectionHeadingLines && r.sectionHeadingLines[i]) || [];
    const heading = headingLines.length ? headingLines.join(" / ") : `${i + 1}번`;
    parts.push(`<h4>${i + 1}. ${escapeHtml(heading)}</h4><p>${previewText(body)}</p>`);
  });
  el.innerHTML = parts.join("");
}

// 미리보기에서도 에디터에 들어갈 모양대로: **굵게** → 굵게, 줄바꿈 유지, "- " 줄 → • 목록
function previewText(s) {
  return escapeHtml(s || "")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n/g, "<br>");
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderImageCandidates(imgRes) {
  const container = $("#image-candidates");
  container.innerHTML = "";
  for (const [query, candidates] of Object.entries(imgRes)) {
    const group = document.createElement("div");
    group.className = "image-group";
    const thumbs = document.createElement("div");
    thumbs.className = "thumbs";
    group.innerHTML = `<strong>${query}</strong>`;
    candidates.forEach((c, idx) => {
      const img = document.createElement("img");
      img.src = c.webPath;
      img.title = `점수 ${c.score} - ${c.reason}`;
      if (idx === 0) {
        img.classList.add("selected");
        selectedImagePaths[query] = c.path;
      }
      img.addEventListener("click", () => {
        thumbs.querySelectorAll("img").forEach((i) => i.classList.remove("selected"));
        img.classList.add("selected");
        selectedImagePaths[query] = c.path;
      });
      thumbs.appendChild(img);
    });
    group.appendChild(thumbs);
    container.appendChild(group);
  }
}

function setActiveStep(n) {
  document.querySelectorAll(".step").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.step) === n);
  });
}

$("#save-draft-btn").addEventListener("click", async () => {
  if (!currentPost) return alert("먼저 글을 생성해주세요.");
  $("#save-draft-btn").disabled = true;
  $("#save-status").textContent = "네이버 블로그에 본문 임시저장 중입니다... (1~2분 소요)";
  const r = await fetch("/api/save-draft", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: $("#post-title").value,
      introLines: currentPost.introLines,
      sectionHeadingLines: currentPost.sectionHeadingLines,
      sections: currentPost.sections,
      imagePaths: Object.values(selectedImagePaths),
      useTemplate: $("#use-template-checkbox").checked,
      continueDraft: $("#continue-draft-checkbox").checked,
    }),
  }).then((r) => r.json());

  $("#save-draft-btn").disabled = false;
  $("#save-status").textContent = r.error
    ? "오류: " + r.error
    : "본문 임시저장 완료! 네이버 에디터에서 검토/수정 후, 아래 4단계에서 목차·요약을 채워주세요.";
  if (!r.error) {
    $("#step-finalize").hidden = false;
    setActiveStep(4);
  }
});

$("#finalize-btn").addEventListener("click", async () => {
  $("#finalize-btn").disabled = true;
  $("#finalize-status").textContent = "지금 임시글을 열어서 목차·요약을 채우는 중입니다... (1~2분 소요)";
  const r = await fetch("/api/finalize-toc", { method: "POST" }).then((r) => r.json());
  $("#finalize-btn").disabled = false;
  $("#finalize-status").textContent = r.error ? "오류: " + r.error : "목차·요약까지 완료! 네이버 블로그에서 최종 확인 후 발행해주세요.";
});

// 프로그램을 처음 켰을 때는 저장된 세션이 있어도 무조건 "로그인 필요"로 시작한다.
// (버튼을 눌러야만 실제로 브라우저에서 로그인 상태를 눈으로 확인하고 갱신함)
$("#login-status").textContent = "로그인 필요";
$("#login-status").className = "status-pill no";

// --- 체크한 글감을 AI(Claude / ChatGPT / Gemini)에게 넘겨서 대화하며 쓰기 ---
const AI_SITES = {
  claude: { name: "Claude", url: "https://claude.ai/new" },
  chatgpt: { name: "ChatGPT", url: "https://chatgpt.com/" },
  gemini: { name: "Gemini", url: "https://gemini.google.com/app" },
};

// 버튼을 누르면: 로그인용 크롬에 그 AI 채팅 탭을 열고 요청문을 자동으로 보냄 → 사용자가 탭에서 대화 →
// "완성"이라고 해서 AI가 결과 JSON을 내놓으면 앱이 알아채서 네이버 글쓰기 창을 열어 채운다.
const AI_STATUS_TEXT = {
  opening: (n) => `${n} 탭을 여는 중이에요...`,
  needLogin: (n) => `열린 크롬 탭에서 ${n}에 로그인해주세요 (처음 한 번만). 로그인하면 요청문이 자동으로 들어가요.`,
  sending: (n) => `${n}에 요청문을 보내는 중이에요...`,
  chatting: (n) =>
    `✅ ${n}에 요청문을 보냈어요. 크롬 탭에서 ${n}이 제안하는 방향을 고르고 초안을 다듬은 뒤, "완성"이라고 보내세요. 결과가 나오면 자동으로 블로그 글쓰기 창이 열려요.`,
  closed: (n) => `${n} 탭이 닫혀서 연결을 끝냈어요. 다시 하려면 버튼을 눌러주세요.`,
  timeout: (n) => `${n} 대화를 기다리다 시간이 지났어요. 결과 JSON을 아래에 직접 붙여넣어도 돼요.`,
};
const FORMAT_CHATTING = (n) =>
  `✅ ${n}에 내 최근 글을 보내 분석을 맡겼어요. 크롬 탭에서 분석이 끝나고 JSON이 나오면 자동으로 저장돼요. (결과가 마음에 안 들면 탭에서 고쳐달라고 하세요)`;
let aiPollTimer = null;

// --- 내 블로그 글 형식 ---
let formatInfo = null;
async function loadFormat() {
  formatInfo = await fetch("/api/format").then((r) => r.json()).catch(() => null);
  if (!formatInfo) return;
  $("#format-name").textContent = formatInfo.name;
  $("#format-json").value = formatInfo.format ? JSON.stringify(formatInfo.format, null, 2) : "";
}
loadFormat();

document.querySelectorAll(".format-analyze-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    document.querySelectorAll(".format-analyze-btn").forEach((b) => (b.disabled = true));
    $("#format-status").textContent = "내 블로그 최근 글을 읽는 중이에요...";
    const r = await fetch("/api/format/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai: btn.dataset.ai }),
    })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));
    document.querySelectorAll(".format-analyze-btn").forEach((b) => (b.disabled = false));
    if (r.error) {
      $("#format-status").textContent = "오류: " + r.error;
      return;
    }
    $("#format-status").textContent = `최근 글 ${r.sampleTitles.length}개를 읽었어요 (${r.sampleTitles.join(", ")}). AI 탭을 여는 중...`;
    clearInterval(aiPollTimer);
    aiPollTimer = setInterval(pollAiChat, 2000);
  });
});

$("#format-save-btn").addEventListener("click", async () => {
  let f;
  try {
    const m = $("#format-json").value.match(/\{[\s\S]*\}/);
    f = JSON.parse(m ? m[0] : "");
  } catch {
    $("#format-status").textContent = "저장 실패: JSON 형식이 올바르지 않아요.";
    return;
  }
  const r = await fetch("/api/format", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) }).then((r) => r.json());
  $("#format-status").textContent = r.error ? "저장 실패: " + r.error : `✅ 저장했어요: "${r.name}"`;
  loadFormat();
});

$("#format-reset-btn").addEventListener("click", async () => {
  if (!confirm("저장된 내 블로그 형식을 지우고 기본 형식으로 돌아갈까요?")) return;
  await fetch("/api/format", { method: "DELETE" });
  $("#format-status").textContent = "기본 형식으로 돌아갔어요.";
  loadFormat();
});

async function pollAiChat() {
  const st = await fetch("/api/ai-chat/status").then((r) => r.json()).catch(() => null);
  if (!st || st.status === "idle" || st.status === "taken") return;
  const isFormat = st.kind === "format";
  const line = isFormat ? $("#format-status") : $("#handoff-status");
  if (st.status === "done") {
    clearInterval(aiPollTimer);
    await fetch("/api/ai-chat/taken", { method: "POST" }).catch(() => {});
    if (isFormat) {
      const r = await fetch("/api/format", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(st.result) })
        .then((r) => r.json())
        .catch((e) => ({ error: e.message }));
      line.textContent = r.error ? "저장 실패: " + r.error : `✅ ${st.name}가 분석한 형식을 저장했어요: "${r.name}". 이제 초안을 쓸 때 이 형식을 따라요.`;
      loadFormat();
    } else {
      line.textContent = `✅ ${st.name}의 완성본을 받아왔어요.`;
      loadPost(st.result);
    }
    return;
  }
  if (st.status === "error") {
    clearInterval(aiPollTimer);
    line.textContent = "오류: " + st.error + (isFormat ? "" : " — 아래 요청문을 복사해서 직접 붙여넣어도 돼요.");
    return;
  }
  const f = isFormat && st.status === "chatting" ? FORMAT_CHATTING : AI_STATUS_TEXT[st.status];
  if (f) line.textContent = f(st.name) + (st.note ? " " + st.note : "");
  if (["closed", "timeout"].includes(st.status)) clearInterval(aiPollTimer);
}

document.querySelectorAll(".handoff-btn").forEach((btn) => {
  btn.addEventListener("click", async () => {
    if (!selectedItems.length) return alert("글감을 하나 이상 선택해주세요.");
    const ai = btn.dataset.ai;
    document.querySelectorAll(".handoff-btn").forEach((b) => (b.disabled = true));
    $("#handoff-status").textContent = "글감 본문을 모으는 중이에요...";
    const r = await fetch("/api/ai-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ai, keyword: $("#keyword").value.trim(), selected: selectedItems, context: searchCtx ? { title: searchCtx.title, questions: searchCtx.questions, refs: searchCtx.refs } : undefined }),
    })
      .then((r) => r.json())
      .catch((e) => ({ error: e.message }));
    document.querySelectorAll(".handoff-btn").forEach((b) => (b.disabled = false));
    if (r.error) {
      $("#handoff-status").textContent = "오류: " + r.error;
      return;
    }
    // 자동 입력이 막히는 경우를 대비해 요청문과 [결과 붙여넣기]도 같이 보여준다
    $("#handoff-prompt").value = r.prompt;
    $("#handoff-prompt-box").hidden = false;
    clearInterval(aiPollTimer);
    aiPollTimer = setInterval(pollAiChat, 2000);
    pollAiChat();
  });
});

$("#handoff-copy-btn").addEventListener("click", async () => {
  const ta = $("#handoff-prompt");
  try {
    await navigator.clipboard.writeText(ta.value);
  } catch {
    ta.select();
    document.execCommand("copy");
  }
  $("#handoff-copy-btn").textContent = "복사됨 ✓";
  setTimeout(() => ($("#handoff-copy-btn").textContent = "복사"), 1500);
});

// AI가 준 최종 JSON을 붙여넣으면 3단계 미리보기로 넘어간다 (이후 임시저장은 기존 버튼 그대로)
$("#paste-result-btn").addEventListener("click", () => {
  const raw = $("#paste-result").value;
  let post;
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("JSON을 찾지 못했어요");
    post = JSON.parse(m[0]);
  } catch (e) {
    $("#paste-status").textContent = "불러오기 실패: AI가 준 JSON 코드블록을 통째로 붙여넣어 주세요. (" + e.message + ")";
    return;
  }
  if (!post.title || !Array.isArray(post.sections) || !post.sections.length) {
    $("#paste-status").textContent = "불러오기 실패: title과 sections가 있어야 해요. AI에게 \"정해진 JSON 형식으로 다시 줘\"라고 해보세요.";
    return;
  }
  loadPost(post);
});

// 완성된 글(JSON)을 3단계 미리보기에 넣고, 바로 네이버 글쓰기 창을 열어 채운다 (기존 임시저장 흐름 재사용)
function loadPost(post) {
  // 내 형식을 저장해 쓰는 경우엔 모야ZIP 전용 네이버 템플릿을 적용하지 않는다
  if (formatInfo) $("#use-template-checkbox").checked = !!formatInfo.useTemplate;
  post.introLines = post.introLines || [];
  post.sectionHeadingLines = post.sectionHeadingLines || [];
  currentPost = post;
  selectedImagePaths = {};
  $("#post-title").value = post.title;
  renderPostPreview(post);
  $("#image-candidates").textContent = "AI 대화로 만든 글은 이미지를 네이버 에디터에서 직접 넣어주세요.";
  $("#step-preview").hidden = false;
  setActiveStep(3);
  $("#paste-status").textContent = `✅ 불러왔어요 (섹션 ${post.sections.length}개). 네이버 블로그 글쓰기 창을 여는 중이에요... (크롬 창을 확인하세요)`;
  $("#step-preview").scrollIntoView({ behavior: "smooth" });
  $("#save-draft-btn").click();
}

function renderCtxBox() {
  const box = $("#ctx-box");
  if (!searchCtx) { box.hidden = true; box.innerHTML = ""; return; }
  const qs = (searchCtx.questions || []).map((q) => `<li>${esc(q)}</li>`).join("");
  box.hidden = false;
  box.innerHTML = `<b>💡 이 주제로 쓸 글: ${esc(searchCtx.title)}</b>
    <p class="hint" style="margin:4px 0">이웃 글 제목에서 뽑은 단어를 붙여 더 구체적으로 찾고 있어요: <b id="ctx-rich">${esc(searchCtx.keyword)}</b></p>
    ${qs ? `<p style="margin:6px 0 2px"><b>이 글에서 답해주면 좋은 질문</b></p><ul>${qs}</ul>` : ""}
    <p class="hint" style="margin:4px 0 0">이 방향과 질문은 AI에게 글을 부탁할 때 요청문에 같이 들어가요.</p>`;
}

// 이웃 소통 '주제 추천'에서 [이 주제로 글감 찾기]로 넘어온 경우: 키워드를 넣고 바로 검색
(() => {
  const kw = new URLSearchParams(location.search).get("keyword");
  if (!kw) return;
  // 아이디어 카드의 제목·질문·참고한 이웃 글을 같이 받아서 글감 찾기에 활용한다
  try {
    const c = JSON.parse(localStorage.getItem("nbh.ctx") || "null");
    localStorage.removeItem("nbh.ctx");
    if (c && c.keyword === kw) searchCtx = c;
  } catch {}
  renderCtxBox();
  $("#keyword").value = kw;
  history.replaceState(null, "", location.pathname); // 새로고침해도 다시 검색하지 않게 주소에서 지운다
  $("#search-btn").click();
})();

