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

$("#search-btn").addEventListener("click", async () => {
  const keyword = $("#keyword").value.trim();
  if (!keyword) return alert("키워드를 입력해주세요.");
  $("#search-results").textContent = "검색 중...";

  const r = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword }),
  }).then((r) => r.json());

  if (r.error) {
    $("#search-results").textContent = "오류: " + r.error;
    return;
  }

  const all = [
    ...r.news.map((x) => ({ ...x, type: "뉴스" })),
    ...r.blogs.map((x) => ({ ...x, type: "블로그" })),
  ];

  $("#search-results").classList.remove("empty-state");
  $("#search-results").innerHTML = all.length
    ? all
        .map(
          (item, i) => `
    <label class="item">
      <input type="checkbox" data-idx="${i}" class="pick" />
      <div>
        <span class="tag ${item.type === "뉴스" ? "news" : "blog"}">${item.type}</span>
        <a href="${item.link}" target="_blank">${item.title}</a>
        <small>${item.snippet || ""}</small>
      </div>
    </label>`
        )
        .join("")
    : `<div class="empty-state">검색 결과가 없습니다. 다른 키워드로 시도해보세요.</div>`;

  document.querySelectorAll(".pick").forEach((cb) => {
    cb.addEventListener("change", () => {
      const idx = Number(cb.dataset.idx);
      const item = all[idx];
      if (cb.checked) selectedItems.push(item);
      else selectedItems = selectedItems.filter((x) => x !== item);
    });
  });

  // 제목 링크는 체크박스(label) 안에 있어서 target="_blank"가 브라우저에 따라 새 탭 대신
  // 현재 화면을 바꿔버리는 경우가 있다. 확실하게 새 창으로 열리도록 직접 처리한다.
  $("#search-results")
    .querySelectorAll("a")
    .forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(a.href, "_blank", "noopener,noreferrer");
      });
    });

  $("#step-generate").hidden = false;
  setActiveStep(2);
});

$("#generate-btn").addEventListener("click", async () => {
  if (!selectedItems.length) return alert("글감을 하나 이상 선택해주세요.");
  $("#generate-btn").disabled = true;
  $("#generate-status").textContent = "AI가 글을 작성 중입니다... (최대 몇 분 소요)";

  const keyword = $("#keyword").value.trim();
  const r = await fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword, selected: selectedItems }),
  }).then((r) => r.json());

  $("#generate-btn").disabled = false;

  if (r.error) {
    $("#generate-status").textContent = "오류: " + r.error;
    // 글쓰기용 Claude에 로그인이 안 된 경우: 로그인 창을 여는 버튼을 보여준다
    $("#claude-login-btn").hidden = r.code !== "CLAUDE_NOT_LOGGED_IN";
    return;
  }

  $("#claude-login-btn").hidden = true;
  $("#generate-status").textContent = "완료";
  currentPost = r;
  $("#post-title").value = r.title;
  renderPostPreview(r);
  $("#step-preview").hidden = false;
  $("#image-candidates").classList.remove("empty-state");
  setActiveStep(3);

  if (r.imageQueries && r.imageQueries.length) {
    $("#image-candidates").textContent = "이미지 검색 및 적합성 판단 중...";
    const imgRes = await fetch("/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageQueries: r.imageQueries, topic: r.title }),
    }).then((r) => r.json());

    renderImageCandidates(imgRes);
  }
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
    parts.push(`<h4>${i + 1}. ${escapeHtml(heading)}</h4><p>${escapeHtml(body)}</p>`);
  });
  el.innerHTML = parts.join("");
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

// --- 글쓰기용 Claude 로그인 창 열기 ---
$("#claude-login-btn").addEventListener("click", async () => {
  const r = await fetch("/api/claude-login", { method: "POST" }).then((r) => r.json());
  $("#generate-status").textContent = r.error
    ? "오류: " + r.error
    : "검은 창이 열렸어요. 로그인 방법을 고르고 브라우저에서 로그인한 뒤, [선택 항목으로 글 작성]을 다시 눌러주세요.";
});

// --- 체크한 글감을 Claude(대화창)에게 넘기기 ---
$("#handoff-btn").addEventListener("click", async () => {
  if (!selectedItems.length) return alert("글감을 하나 이상 선택해주세요.");
  $("#handoff-btn").disabled = true;
  $("#handoff-status").textContent = "글감 본문을 모으는 중이에요...";
  const r = await fetch("/api/handoff", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ keyword: $("#keyword").value.trim(), selected: selectedItems }),
  })
    .then((r) => r.json())
    .catch((e) => ({ error: e.message }));
  $("#handoff-btn").disabled = false;
  if (r.error) {
    $("#handoff-status").textContent = "오류: " + r.error;
    return;
  }
  const phrase = "글감으로 초안 써줘";
  navigator.clipboard?.writeText(phrase).catch(() => {});
  $("#handoff-status").textContent =
    `✅ 글감 ${r.count}개를 넘겼어요. 이제 Claude Code 대화창에 "${phrase}"라고 보내세요 (복사해뒀어요).`;
});
