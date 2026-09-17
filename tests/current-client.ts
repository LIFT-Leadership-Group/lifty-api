import { createApp } from "../src/app.js";
export type { AuthSession } from "../src/app.js";

/** Business-route fixtures act as the supported CLI. Contract/authentication
 * tests use createApp directly so missing/retired headers remain observable.
 * This facade never modifies the app: internal stage forwarding stays real. */
export function createCurrentClient(...args: Parameters<typeof createApp>) {
  const app = createApp(...args);
  return {
    fetch: app.fetch,
    request: (...[input, init, ...rest]: Parameters<typeof app.request>) => {
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      if (!headers.has("x-lifty-client-contract")) headers.set("x-lifty-client-contract", "lifty-cli-context.v5");
      return app.request(input, { ...init, headers }, ...rest);
    },
  };
}
