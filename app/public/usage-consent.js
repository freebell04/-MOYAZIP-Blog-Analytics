// 처음 실행할 때 한 번: "사용 횟수만 익명으로 보내도 될까요?" 동의를 묻는다. 기본은 "보내지 않음".
// 동의/거부를 고르면 다시 묻지 않는다 (설정은 아래 작은 링크로 바꿀 수 있다).
(function () {
  if (location.protocol === "file:") return;
  fetch("/api/usage-consent")
    .then((r) => r.json())
    .then((p) => {
      if (!p || p.consent !== null) return; // 이미 고르셨음
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;left:18px;bottom:18px;z-index:99980;width:min(380px,calc(100vw - 36px));background:#fff;border:2px solid #03c75a;border-radius:16px;padding:16px 18px;box-shadow:0 12px 32px rgba(0,0,0,.2);font-family:'Noto Sans KR',system-ui,sans-serif;";
      box.innerHTML =
        '<div style="font-weight:700;font-size:15px;color:#065f46;margin-bottom:6px">📊 프로그램 개선에 도움을 주실래요?</div>' +
        '<div style="font-size:13px;line-height:1.7;color:#374151">하루에 한 번, <b>기능을 몇 번 썼는지(숫자)</b>만 익명으로 보내요.<br>' +
        '<span style="color:#6b7280">글 내용·제목·이웃·댓글·블로그 주소·이름은 <b>절대 보내지 않아요.</b> 동의하지 않아도 모든 기능을 똑같이 쓸 수 있고, 나중에 언제든 바꿀 수 있어요.</span></div>' +
        '<div style="display:flex;gap:8px;margin-top:12px"><button id="uc-yes" class="btn btn-primary" style="flex:1">동의해요</button><button id="uc-no" class="btn btn-outline" style="flex:1">보내지 않아요</button></div>';
      document.body.appendChild(box);
      const send = (value) => {
        fetch("/api/usage-consent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value }) }).catch(() => {});
        box.remove();
      };
      box.querySelector("#uc-yes").onclick = () => send(true);
      box.querySelector("#uc-no").onclick = () => send(false);
    })
    .catch(() => {});
})();
