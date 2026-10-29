/** Auth + account modal helpers shared by CAD and 3D. */
import * as Models from "./models-client.js";

export function ensureAuthModalDom() {
  if (document.getElementById("authModal")) return;
  const el = document.createElement("div");
  el.id = "authModal";
  el.className = "modal hidden";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `
    <div class="modal-backdrop" data-auth-dismiss></div>
    <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="authTitle">
      <h2 id="authTitle">Sign in</h2>
      <div class="modal-body">
        <p class="modal-msg" id="authHint">Save models to your account. Share links stay public.</p>
        <label>Email<input id="authEmail" type="email" autocomplete="username" /></label>
        <label>Password<input id="authPassword" type="password" autocomplete="current-password" /></label>
        <label id="authNameRow" hidden>Name<input id="authName" type="text" autocomplete="name" /></label>
        <p class="modal-msg" id="authError" style="color:#f0c0c0" hidden></p>
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost" id="authToggleMode">Create account</button>
        <button type="button" class="ghost" data-auth-dismiss>Cancel</button>
        <button type="button" class="primary" id="authSubmit">Sign in</button>
      </div>
    </div>`;
  document.body.appendChild(el);
}

export function openAuthModal({ mode = "login", toast } = {}) {
  ensureAuthModalDom();
  return new Promise((resolve) => {
    const modal = document.getElementById("authModal");
    const title = document.getElementById("authTitle");
    const hint = document.getElementById("authHint");
    const errEl = document.getElementById("authError");
    const nameRow = document.getElementById("authNameRow");
    const submit = document.getElementById("authSubmit");
    const toggle = document.getElementById("authToggleMode");
    let register = mode === "register";

    function syncMode() {
      title.textContent = register ? "Create account" : "Sign in";
      submit.textContent = register ? "Register" : "Sign in";
      toggle.textContent = register ? "Have an account? Sign in" : "Create account";
      nameRow.hidden = !register;
      hint.textContent = register
        ? "Email + password (8+ characters)."
        : "Sign in to save and publish models.";
      errEl.hidden = true;
    }
    syncMode();
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.getElementById("authEmail")?.focus();

    function close(result) {
      modal.classList.add("hidden");
      modal.setAttribute("aria-hidden", "true");
      modal.removeEventListener("click", onClick);
      toggle.onclick = null;
      submit.onclick = null;
      resolve(result);
    }
    function onClick(e) {
      if (e.target.closest("[data-auth-dismiss]")) close(null);
    }
    toggle.onclick = () => {
      register = !register;
      syncMode();
    };
    submit.onclick = async () => {
      const email = document.getElementById("authEmail")?.value?.trim();
      const password = document.getElementById("authPassword")?.value || "";
      const name = document.getElementById("authName")?.value?.trim();
      errEl.hidden = true;
      try {
        const data = register
          ? await Models.register({ email, password, name })
          : await Models.login({ email, password });
        toast?.(`Signed in · ${data.user?.email || email}`);
        close(data);
      } catch (err) {
        errEl.textContent = err.message || "Auth failed";
        errEl.hidden = false;
      }
    };
    modal.addEventListener("click", onClick);
  });
}

export async function ensureAuthed({ toast, force = false } = {}) {
  if (!force && Models.getToken()) {
    try {
      await Models.me();
      return true;
    } catch {
      Models.setToken("");
    }
  }
  const data = await openAuthModal({ toast });
  return !!data?.token;
}
