import { getDashboardHtml } from "@m365-copilot/proxy-lib";

export default defineEventHandler((event) => {
  setHeader(event, "Content-Type", "text/html; charset=utf-8");
  return getDashboardHtml();
});
