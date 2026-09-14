import { getMetricsSnapshot } from "@m365-copilot/proxy-lib";
import { pool } from "../../server-pool";

export default defineEventHandler((event) => {
  const query = getQuery(event);
  const range = query.range as "1h" | "6h" | "24h" | undefined;
  return getMetricsSnapshot(pool, range);
});
