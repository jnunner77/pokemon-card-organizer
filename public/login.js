// Sign-in page: send the password, then open the ledger.
(() => {
  "use strict";
  const form = document.getElementById("signinForm"), msg = document.getElementById("msg"), go = document.getElementById("go");
  form.addEventListener("submit", async e => {
    e.preventDefault();
    go.disabled = true; msg.textContent = "";
    try {
      const r = await fetch("api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ password: form.password.value }), credentials: "same-origin" });
      if (r.ok) { location.replace("./"); return; }
      msg.textContent = (await r.json().catch(() => ({}))).error || "Couldn't sign in.";
    } catch (_) { msg.textContent = "Couldn't reach the ledger. Check your connection."; }
    go.disabled = false; form.password.select();
  });
})();
