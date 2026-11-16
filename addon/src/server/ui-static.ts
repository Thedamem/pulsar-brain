/**
 * Static serving for the built web UI (addon/web/dist) with SPA fallback.
 *
 * When the UI has not been built yet the addon still starts and answers "/" with a
 * plain explanatory page instead of fake content, so /health and /api stay usable.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";

const UNBUILT_HTML = `<!doctype html>
<html lang="ru">
<head><meta charset="utf-8"><title>Pulsar Brain — UI не собран</title></head>
<body>
<h1>UI не собран</h1>
<p>Веб-интерфейс аддона ещё не собран. Соберите его командой <code>cd addon/web &amp;&amp; npm run build</code> и перезапустите аддон.</p>
<p>API доступен по <code>/api</code>, состояние сервиса — по <code>/health</code>.</p>
</body>
</html>
`;

export interface UiStaticOptions {
  /** Directory with the built SPA; defaults to PULSAR_BRAIN_WEB_DIR or <addon>/web/dist. */
  webDistDir?: string;
}

export interface UiStatic {
  readonly root: string;
  readonly hasUi: boolean;
  /** Sends index.html for SPA client-side routes. */
  sendIndex(reply: FastifyReply): FastifyReply;
}

export function defaultWebDistDir(): string {
  const fromEnv = process.env.PULSAR_BRAIN_WEB_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  return fileURLToPath(new URL("../../web/dist/", import.meta.url));
}

export async function registerUiStatic(
  app: FastifyInstance,
  options: UiStaticOptions = {},
): Promise<UiStatic> {
  const root = options.webDistDir === undefined ? defaultWebDistDir() : resolve(options.webDistDir);
  const hasUi = existsSync(resolve(root, "index.html"));

  if (hasUi) {
    await app.register(fastifyStatic, {
      root,
      prefix: "/",
      index: ["index.html"],
      wildcard: true,
      cacheControl: false,
      setHeaders(response, filePath) {
        // Hashed Vite assets are safe to cache; index.html must always be revalidated.
        response.setHeader(
          "Cache-Control",
          filePath.endsWith("index.html") ? "no-cache" : "public, max-age=3600",
        );
      },
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply.code(200).type("text/html; charset=utf-8").send(UNBUILT_HTML),
    );
  }

  return {
    root,
    hasUi,
    sendIndex(reply: FastifyReply): FastifyReply {
      return reply.type("text/html; charset=utf-8").sendFile("index.html");
    },
  };
}
