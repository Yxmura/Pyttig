// /api/proxy — capability probe + legacy query-string form.
// Main implementation: ./_proxy.js. Nested paths are handled by
// ./proxy/[...path].js (path form, preferred by the app).
export { default } from "./_proxy.js";
