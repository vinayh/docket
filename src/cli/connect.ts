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

  await new Promise<void>((resolve) => {
    let server: ReturnType<typeof Bun.serve>;

    // Schedules teardown after the response flushes, then returns it.
    const finish = (response: Response): Response => {
      setTimeout(() => {
        server.stop();
        resolve();
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
          console.error(`oauth error: ${error}`);
          return finish(new Response(`oauth error: ${error}`, { status: 400 }));
        }
        if (!code || returnedState !== state) {
          return new Response("invalid callback (missing code or state mismatch)", {
            status: 400,
          });
        }
        try {
          const { userId, email, isNewUser } = await completeOAuth(code);
          console.log(
            `✓ connected ${email} as ${isNewUser ? "new" : "existing"} user (id=${userId})`,
          );
          return finish(new Response(`Connected ${email}. You can close this tab.`));
        } catch (err) {
          console.error("oauth completion failed:", err);
          return finish(new Response(`error: ${(err as Error).message}`, { status: 500 }));
        }
      },
    });
  });
}
