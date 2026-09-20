// /api/proxy/<host>/<path> — the CDN-safe form the app uses:
//   /api/proxy/github.com/user/repo.git/info/refs?service=git-upload-pack
// A full URL in the query string gets normalized/percent-encoded by edges
// (Vercel did), which is why the path form exists.
export { default } from "../_proxy.js";
