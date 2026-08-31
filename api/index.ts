import { handle } from "hono/vercel";

import app from "../src/index.js";

const handler = handle(app);

export {
  handler as DELETE,
  handler as GET,
  handler as HEAD,
  handler as OPTIONS,
  handler as PATCH,
  handler as POST,
  handler as PUT,
};
