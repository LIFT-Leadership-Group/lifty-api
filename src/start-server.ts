import { serve } from "@hono/node-server";

import type { ServiceConfig } from "./config.js";
import { createProductionApp } from "./service.js";

interface ServeOptions {
  fetch(request: Request, environment?: unknown): Promise<unknown> | unknown;
  hostname: string;
  port: number;
}

type ServeImplementation<Server> = (options: ServeOptions) => Server;

export function startService(config: ServiceConfig): ReturnType<typeof serve>;
export function startService<Server>(
  config: ServiceConfig,
  serveImplementation: ServeImplementation<Server>,
): Server;
export function startService<Server>(
  config: ServiceConfig,
  serveImplementation?: ServeImplementation<Server>,
): Server {
  const app = createProductionApp(config);
  const start = (serveImplementation ?? serve) as ServeImplementation<Server>;
  return start({
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  });
}
