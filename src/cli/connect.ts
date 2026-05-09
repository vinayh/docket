import { buildAuthUrl, DRIVE_SCOPES, IDENTITY_SCOPES } from "../google/oauth.ts";
import { completeOAuth } from "../auth/connect.ts";
import { config } from "../config.ts";

export async function run(_args: string[]): Promise<void> {
  const state = crypto.randomUUID();
  const authUrl = buildAuthUrl({
    scopes: [...IDENTITY_SCOPES, DRIVE_SCOPES.drive_file],
    state,
    prompt: "consent",
  });

  const redirect = new URL(config.google.redirectUri);
  const port = Number(redirect.port) || 8787;

  console.log(`\nopen this URL in your browser to consent:\n\n${authUrl}\n`);
  console.log(`waiting for callback at ${redirect.origin}${redirect.pathname}...\n`);

  await new Promise<void>((resolve, reject) => {
    let server: ReturnType<typeof Bun.serve>;

    // Schedules teardown after the response flushes, then settles the outer
    // promise. `error` propagates through the CLI dispatcher's catch so the
    // process exits non-zero — silent success on OAuth failure is the worst
    // possible outcome here.
    const finish = (response: Response, error?: Error): Response => {
      setTimeout(() => {
        server.stop();
        if (error) reject(error);
        else resolve();
      }, 100);
      return response;
    };

    server = Bun.serve({
      port,
      async fetch(req) {
        const u = new URL(req.url);
        if (u.pathname !== redirect.pathname) {
          return new Response("not found", { status: 404 });
        }
        const code = u.searchParams.get("code");
        const returnedState = u.searchParams.get("state");
        const error = u.searchParams.get("error");

        if (error) {
          return finish(
            new Response(`oauth error: ${error}`, { status: 400 }),
            new Error(`oauth error: ${error}`),
          );
        }
        if (!code || returnedState !== state) {
          return finish(
            new Response("invalid callback (missing code or state mismatch)", {
              status: 400,
            }),
            new Error("invalid callback (missing code or state mismatch)"),
          );
        }
        try {
          const { userId, email, isNewUser } = await completeOAuth(code);
          console.log(
            `✓ connected ${email} as ${isNewUser ? "new" : "existing"} user (id=${userId})`,
          );
          return finish(new Response(`Connected ${email}. You can close this tab.`));
        } catch (err) {
          const e = err instanceof Error ? err : new Error(String(err));
          return finish(new Response(`error: ${e.message}`, { status: 500 }), e);
        }
      },
    });
  });
}
