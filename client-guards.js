/** Install global error guards — never leave a blank crashed page. */
export function installClientGuards({ toast } = {}) {
  const report = (msg, err) => {
    console.error(msg, err);
    try {
      toast?.(String(msg).slice(0, 160), "err");
    } catch { /* */ }
  };
  window.addEventListener("error", (e) => {
    report(e.message || "Unexpected error", e.error);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    const msg = reason?.message || String(reason || "Unhandled promise rejection");
    report(msg, reason);
    e.preventDefault?.();
  });
}
