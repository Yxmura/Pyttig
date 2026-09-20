// Turns worker load/exec failures into an actionable message.
//
// Real-world cases this handles:
//  1. Stale tab: the worker chunk was deleted by a redeploy → 404.
//  2. Broken deployment: the worker exists but the server sends a non-JS MIME
//     type (raw ".ts", or an SPA fallback returning HTML) → browser refuses to
//     execute it with an unhelpful empty error.
//  3. Anything else: a generic hard-refresh hint.

import { notify } from "./toast";

let reported = false;

/**
 * Module workers are only allowed to load with a JavaScript MIME type. Some
 * hosts (or a stale build shipping raw .ts) break that rule, and the browser's
 * error is an empty "script failed to load". This checks the type up front and
 * transparently rebuilds the worker from a same-origin blob when needed.
 */
export async function resolveWorkerSource(url: string): Promise<{ url: string; revoke: () => void }> {
  try {
    const head = await fetch(url, { method: "HEAD", cache: "no-store" });
    const type = head.headers.get("content-type") ?? "";
    if (head.ok && type && !JS_MIME.test(type)) {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const code = await res.text();
        const blobUrl = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        console.warn(`Worker served as "${type}"; loading it via a blob instead (${url}).`);
        return { url: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
      }
    }
  } catch {
    /* fall back to the plain URL */
  }
  return { url, revoke: () => {} };
}

const JS_MIME = /javascript|ecmascript/i;

export function handleWorkerError(label: string, workerUrl: string | URL, detail: string): void {
  console.error(`${label} worker error: ${detail}`, workerUrl);

  void (async () => {
    let status = 0;
    let contentType = "";
    let reachable = false;
    try {
      const res = await fetch(workerUrl, { method: "HEAD", cache: "no-store" });
      status = res.status;
      contentType = res.headers.get("content-type") ?? "";
      reachable = true;
      if (res.ok && !contentType) {
        // Some servers omit content-type on HEAD — confirm with a tiny GET.
        const get = await fetch(workerUrl, { cache: "no-store" });
        contentType = get.headers.get("content-type") ?? contentType;
      }
    } catch {
      /* network error — leave reachable=false */
    }

    if (reported) return;

    if (reachable && status === 404) {
      reported = true;
      notify.error("Pyttig was updated while this tab was open, so this feature can't start. Reload to continue.", {
        timeout: 60000,
        actions: [{ label: "Reload", primary: true, run: () => location.reload() }],
      });
      return;
    }

    if (reachable && status === 200 && contentType && !JS_MIME.test(contentType)) {
      reported = true;
      notify.error(
        `${label} could not start: the server served its worker script as "${contentType}" instead of JavaScript. ` +
          "This deployment is out of date. Redeploy the current build, then hard-refresh.",
        { timeout: 60000, actions: [{ label: "Reload", primary: true, run: () => location.reload() }] },
      );
      return;
    }

    notify.error(`${label} failed to start (${detail}). A hard refresh (Ctrl+Shift+R) usually fixes it.`, {
      timeout: 15000,
    });
  })();
}
