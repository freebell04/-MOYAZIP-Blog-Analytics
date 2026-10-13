// 📐 내 블로그 글 형식 아래: [🤖 AI가 자동으로 만드는 템플릿] + [👤 사용자가 할 일]
//  - AI 버튼: 내 인기글로 네이버 '앞으로 쓸 템플릿'을 만들고, 새 글쓰기에 불러와 둔다 (원래 글은 저장하지 않음)
//  - 사용자가 할 일: 템플릿이 만들어진 뒤에만. 자리 글자로 고치는 방법(예시 이미지) + [다 고쳤어요 → 템플릿으로 저장]
(function () {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const box = document.getElementById("tpl-maker");
  if (!box) return;
  let st = {};

  box.innerHTML = `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:2px 0 4px">
      <button type="button" id="tm-ai" class="tm-btn tm-purple">🤖 AI가 자동으로 만드는 템플릿</button>
      <button type="button" id="tm-user" class="tm-btn tm-gray" aria-disabled="true">👤 사용자가 할 일</button>
      <span style="font-size:12px;color:#6b7280">바탕 글: <select id="tm-post" style="font-size:12px;max-width:260px"></select></span>
    </div>
    <div id="tm-msg" class="status-line" style="font-size:12.5px"></div>`;

  const style = document.createElement("style");
  style.textContent = `
    .tm-btn { font-size: 12.5px; font-weight: 700; padding: 6px 11px; border-radius: 10px; cursor: pointer; white-space: nowrap; border: 1.5px solid; }
    .tm-purple { background: #f5f3ff; color: #6d28d9; border-color: #a78bfa; }
    .tm-purple:hover { background: #ede9fe; }
    .tm-gray { background: #f3f4f6; color: #9ca3af; border-color: #d1d5db; }
    .tm-gray.ready { background: #fff; color: #374151; border-color: #9ca3af; }
    .tm-veil { position: fixed; inset: 0; z-index: 99995; background: rgba(15,23,42,.45); display: flex; align-items: center; justify-content: center; padding: 16px; }
    .tm-card { background: #fff; border-radius: 16px; box-shadow: 0 14px 40px rgba(0,0,0,.25); font-family: 'Noto Sans KR', system-ui, sans-serif; }
    .tm-guide { width: min(720px, 100%); max-height: calc(100vh - 32px); display: flex; flex-direction: column; }
    .tm-guide-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid #e5e7eb; }
    .tm-guide-body { overflow-y: auto; padding: 16px 20px 22px; line-height: 1.7; font-size: 14px; }
    .tm-x { border: 0; background: #f3f4f6; width: 32px; height: 32px; border-radius: 50%; font-size: 18px; cursor: pointer; }
    .tm-step { border: 1px solid #e5e7eb; border-radius: 12px; padding: 12px 14px; margin: 12px 0; }
    .tm-step h4 { margin: 0 0 6px; font-size: 15px; }
    .tm-word { display: inline-block; background: #f5f3ff; color: #5b21b6; border-radius: 6px; padding: 0 6px; font-weight: 700; }
    .tm-guide table { border-collapse: collapse; width: 100%; font-size: 13px; }
    .tm-guide td, .tm-guide th { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
  `;
  document.head.appendChild(style);

  const msg = (t, err) => { $("#tm-msg").innerHTML = t ? (err ? `<span class="error">⚠ ${esc(t)}</span>` : esc(t)) : ""; };

  async function refresh() {
    st = await fetch("/api/template-maker").then((r) => r.json()).catch(() => ({}));
    const sel = $("#tm-post");
    const cur = sel.value;
    sel.innerHTML = (st.candidates || []).map((c, i) => `<option value="${esc(c.logNo)}">${i === 0 && c.cv ? "👑 " : ""}${esc(String(c.title).slice(0, 34))}${c.cv ? ` (조회 ${c.cv})` : ""}</option>`).join("") || `<option value="">(성과 통계를 한 번 불러와 주세요)</option>`;
    if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
    const u = $("#tm-user");
    u.classList.toggle("ready", !!st.made);
    u.setAttribute("aria-disabled", st.made ? "false" : "true");
    if (st.running) msg("⏳ " + (st.step || "템플릿을 만드는 중..."));
  }

  function popup(html, { onClose } = {}) {
    const v = document.createElement("div");
    v.className = "tm-veil";
    v.innerHTML = html;
    document.body.appendChild(v);
    const close = () => { v.remove(); onClose && onClose(); };
    return { el: v, close };
  }

  // 템플릿이 아직 없는데 [사용자가 할 일]을 누른 경우: 안내 카드 (누르면 닫힘)
  function notYet() {
    const p = popup(`<div class="tm-card" style="padding:22px 26px;max-width:340px;text-align:center;cursor:pointer">
      <div style="font-size:30px">🧩</div>
      <div style="font-weight:700;font-size:15px;margin:6px 0">여러분의 템플릿을 만들고 나면, 사용할 수 있어요.</div>
      <div style="font-size:12.5px;color:#6b7280">먼저 보라색 [🤖 AI가 자동으로 만드는 템플릿]을 눌러주세요.<br>(이 카드를 누르면 닫혀요)</div></div>`);
    p.el.addEventListener("click", p.close);
  }

  // 사용자가 할 일: 자리 글자로 고치는 방법 (오른쪽 위 X로 닫기)
  function guide() {
    const p = popup(`<div class="tm-card tm-guide">
      <div class="tm-guide-head"><b style="font-size:16px">👤 사용자가 할 일 — 템플릿을 "자리 글자"로 바꾸기</b><button class="tm-x" title="닫기">✕</button></div>
      <div class="tm-guide-body">
        <p>프로그램이 크롬의 <b>새 글쓰기 화면</b>에 '${esc(st.name || "앞으로 쓸 템플릿")}'을 불러와 뒀어요. 지금은 인기글 내용이 그대로 들어 있어요.
        앞으로 AI가 이 모양 그대로 글을 채울 수 있게, <b>내가 썼던 내용을 지우고 아래 "자리 글자"로 바꿔주세요.</b> (디자인·인용구·구분선·표 모양은 그대로 두세요)</p>

        <div class="tm-step"><h4>1. 제목 · 소개글(인트로)</h4>
          제목 칸 → <span class="tm-word">제목</span>, 소개글 문단 → <span class="tm-word">인트로 글</span> 로 바꿔요.</div>

        <div class="tm-step"><h4>2. 목차 표 (있다면)</h4>
          표의 칸마다 <span class="tm-word">ε①з 본문 내용</span>, <span class="tm-word">ε②з 본문 내용</span> … 처럼 번호와 함께 <b>"본문 내용"</b>을 적어요.</div>

        <div class="tm-step"><h4>3. 본문 (소제목마다 반복)</h4>
          <table>
            <tr><th>원래 있던 것</th><th>이렇게 바꾸기</th></tr>
            <tr><td>본문의 큰 제목</td><td><span class="tm-word">본문 제목</span></td></tr>
            <tr><td>그 아래 한 줄 설명</td><td><span class="tm-word">짧은 본문</span></td></tr>
            <tr><td>인용구 소제목</td><td><span class="tm-word">1. 소제목</span>, <span class="tm-word">2. 소제목</span> …</td></tr>
            <tr><td>소제목 아래 긴 설명</td><td><span class="tm-word">소제목에 대한 설명</span></td></tr>
          </table>
          <p style="margin:10px 0 4px"><b>예시</b> — 이렇게 바꾸면 돼요:</p>
          <img src="assets/template-guide-example.png" alt="템플릿 자리 글자 예시" style="width:100%;border:1px solid #e5e7eb;border-radius:10px">
        </div>

        <div class="tm-step"><h4>4. 다 고쳤으면 저장</h4>
          글쓰기 화면은 <b>발행하지 말고</b> 그대로 둔 채로 아래 버튼을 누르면, 고친 모양이 '${esc(st.name || "앞으로 쓸 템플릿")}'으로 저장돼요. (예전 것은 지우고 1개만 남겨요)<br>
          <button type="button" id="tm-save" class="tm-btn tm-purple" style="margin-top:8px">✅ 다 고쳤어요 → 템플릿으로 저장</button>
          <div id="tm-save-msg" class="status-line" style="font-size:13px"></div>
        </div>
        <p style="font-size:12.5px;color:#6b7280">💡 '${esc(st.name || "앞으로 쓸 템플릿")}'은 블로그에 1개만 만들 수 있어요. 저장한 뒤에는 글쓰기 화면을 닫아도 돼요 (나가시겠습니까? → 나가기).</p>
      </div></div>`);
    p.el.querySelector(".tm-x").addEventListener("click", p.close);
    p.el.addEventListener("click", (e) => { if (e.target === p.el) p.close(); });
    p.el.querySelector("#tm-save").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      p.el.querySelector("#tm-save-msg").textContent = "⏳ 저장하는 중... (크롬의 글쓰기 화면을 건드리지 말고 기다려주세요)";
      const r = await fetch("/api/template-maker/save", { method: "POST" }).then((x) => x.json()).catch((er) => ({ error: er.message }));
      b.disabled = false;
      p.el.querySelector("#tm-save-msg").innerHTML = r.error ? `<span class="error">⚠ ${esc(r.error)}</span>` : "🎉 저장했어요! 이제 이 템플릿 모양으로 글을 쓸 수 있게 준비됐어요.";
      refresh();
    });
  }

  async function create(replace) {
    const logNo = $("#tm-post").value;
    if (!logNo) return msg("바탕으로 쓸 글이 없어요. 성과 통계를 한 번 불러온 뒤 다시 눌러주세요.", true);
    $("#tm-ai").disabled = true;
    msg("⏳ 인기글로 템플릿을 만드는 중이에요 (1분쯤). 크롬 화면은 건드리지 말고 기다려주세요. 원래 글은 저장하지 않아요.");
    const poll = setInterval(refresh, 2500);
    const r = await fetch("/api/template-maker/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logNo, replace }) }).then((x) => x.json()).catch((er) => ({ error: er.message }));
    clearInterval(poll);
    $("#tm-ai").disabled = false;
    if (r.exists) {
      if (confirm(`'${st.name || "앞으로 쓸 템플릿"}'이 사용자님의 블로그에 이미 작성되어 있어요. 다시 작성하시겠습니까?\n\n(앞으로 쓸 템플릿은 1개만 만들 수 있어요 — 다시 만들면 예전 템플릿은 지워져요)`)) return create(true);
      return msg("기존 템플릿을 그대로 두었어요.");
    }
    if (r.error) return msg(r.error, true);
    await refresh();
    msg("✅ 템플릿을 만들고 새 글쓰기 화면에 불러왔어요. 이제 [👤 사용자가 할 일]을 눌러 자리 글자로 바꿔주세요.");
    guide();
  }

  $("#tm-ai").addEventListener("click", () => create(false));
  $("#tm-user").addEventListener("click", () => (st.made ? guide() : notYet()));
  refresh();
})();
