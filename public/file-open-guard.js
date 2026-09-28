// 이 화면은 file:// 로 직접 열면(더블클릭) 뒤에서 서버가 없어서 아무것도 동작하지 않는다.
// 그 상태를 조용히 실패시키는 대신, 바로 알아챌 수 있게 안내 배너를 띄운다.
(function () {
  if (location.protocol !== "file:") return;
  const box = document.createElement("div");
  box.style.cssText =
    "position:fixed;inset:0;z-index:99999;background:rgba(20,20,20,.55);" +
    "display:flex;align-items:center;justify-content:center;padding:20px;font-family:'Noto Sans KR',system-ui,sans-serif;";
  box.innerHTML = `
    <div style="background:#fff;border-radius:16px;max-width:420px;padding:28px 26px;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.2)">
      <div style="width:48px;height:48px;border-radius:14px;background:#03c75a;color:#fff;font-weight:800;font-size:22px;
                  display:flex;align-items:center;justify-content:center;margin:0 auto 14px">N</div>
      <h2 style="margin:0 0 10px;font-size:17px;color:#1a1a1a">이 파일은 이렇게 열어야 해요</h2>
      <p style="margin:0 0 16px;font-size:13.5px;color:#5b5b5b;line-height:1.7">
        지금은 파일을 <b>직접 더블클릭</b>해서 연 상태라, 뒤에서 데이터를 넣어줄 프로그램이 켜져 있지 않아요.<br><br>
        1. 폴더의 <b>실행하기.bat</b>을 더블클릭하세요<br>
        2. 자동으로 뜨는 브라우저 창(<b>localhost:3300</b>)에서 이 화면을 다시 열어주세요
      </p>
      <button id="__fileguard_close" style="border:0;background:#f4f5f7;color:#5b5b5b;padding:9px 18px;border-radius:999px;font:inherit;font-size:13px;cursor:pointer">
        알겠어요, 그래도 화면은 보고 싶어요
      </button>
    </div>`;
  const show = () => {
    document.body.appendChild(box);
    box.querySelector("#__fileguard_close").onclick = () => box.remove();
  };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", show) : show();
})();
