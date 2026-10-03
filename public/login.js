// Sign-in page: sign in, choose a new password when one was set temporarily, or create the
// first administrator with the setup code from the server log.
(() => {
  "use strict";
  const $ = id => document.getElementById(id);
  const forms = { signin: $("signinForm"), change: $("changeForm"), setup: $("setupForm") };
  const show = name => { for (const [k, f] of Object.entries(forms)) f.hidden = k !== name; forms[name].querySelector("input")?.focus(); };
  const msg = (form, text) => { form.querySelector(".msg").textContent = text || ""; };
  async function post(url, body) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "That didn't work. Try again.");
    return data;
  }
  async function run(form, fn) {
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true; msg(form, "");
    try { await fn(); }
    catch (e) { msg(form, e.message || "Couldn't reach the ledger. Check your connection."); }
    finally { btn.disabled = false; }
  }
  const done = () => location.replace("./");
  let pending = null;

  forms.signin.addEventListener("submit", e => {
    e.preventDefault();
    run(forms.signin, async () => {
      const username = $("username").value, password = $("password").value;
      const r = await post("api/auth/login", { username, password });
      if (r.status === "change") { pending = { username, password }; return show("change"); }
      done();
    });
  });
  forms.change.addEventListener("submit", e => {
    e.preventDefault();
    run(forms.change, async () => {
      if ($("newPassword").value !== $("confirm").value) throw new Error("The two passwords don't match.");
      await post("api/auth/password", { username: pending.username, currentPassword: pending.password, newPassword: $("newPassword").value });
      done();
    });
  });
  forms.setup.addEventListener("submit", e => {
    e.preventDefault();
    run(forms.setup, async () => {
      await post("api/auth/setup", { setupCode: $("setupCode").value, name: $("sName").value, username: $("sUser").value, password: $("sPass").value });
      done();
    });
  });

  fetch("api/auth/me", { credentials: "same-origin" }).then(r => r.json()).then(me => {
    if (me.user) return done();
    show(me.setupRequired ? "setup" : "signin");
  }, () => show("signin"));
})();
