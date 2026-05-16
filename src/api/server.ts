import {
  handleAuthExtLaunchTab,
  handleAuthExtSuccess,
  handleAuthRequest,
} from "./auth-handler.tsx";
import { handleDocStatePost } from "./doc-state.ts";
import { handleDocSyncPost } from "./doc-sync.ts";
import { handleProjectDetailPost } from "./project-detail.ts";
import { handleProjectsListPost } from "./projects-list.ts";
import { handleProjectDeletePost } from "./project-delete.ts";
import { handleVersionCreatePost } from "./version-create.ts";
import { handleVersionDiffPost } from "./version-diff.ts";
import { handleVersionCommentsPost } from "./version-comments.ts";
import { handleCommentActionPost } from "./comment-action.ts";
import { handleSettingsPost } from "./settings.ts";
import { handleWhoamiPost } from "./whoami.ts";
import { handleReviewActionGet } from "./review-action.tsx";
import { handleReviewRequestPost } from "./review-request.ts";
import { handlePickerPage } from "./picker-page.tsx";
import { handleRegisterDocPost } from "./picker-register.ts";
import { handleDriveWebhook } from "./drive-webhook.ts";
import { handleFontRequest } from "./fonts.ts";
import { handleStaticAsset } from "./static.ts";
import { corsRoute, secured, setActiveServer } from "./route-wrappers.ts";
import { startBackgroundLoops } from "./background.ts";
import { config } from "../config.ts";

export interface ServeOptions {
  port?: number;
  hostname?: string;
}

/**
 * HTTP API host. Public routes: `/healthz`, the magic-link review
 * handler `/r/<token>`, the backend-hosted Drive Picker page
 * `/api/picker/page` (cookie-authenticated), and Better Auth's catch-all
 * `/api/auth/**` (sign-in, social-provider callback, session lookup,
 * sign-out). Webhooks: `/webhooks/drive` (Drive push notifications).
 * Bearer-authenticated API surface:
 * `/api/extension/{doc-state,doc-sync,project,projects,version/create,
 * version-diff,version-comments,comment-action,settings,review/request}`,
 * `/api/picker/register-doc`.
 * Method dispatch + 405-on-mismatch comes from Bun.serve's `routes:` option;
 * unknown paths fall through to `fetch`'s 404.
 *
 * `backgroundLoops` (default true) controls the in-process renew + poll
 * timers (SPEC §9.3). Tests pass `false` to keep the server quiet; in
 * prod the loops gate themselves on `MARGIN_PUBLIC_BASE_URL` being set.
 */
export interface StartServerResult {
  port: number | undefined;
  hostname: string | undefined;
  stop(): Promise<void>;
}

export function startServer(opts: ServeOptions & { backgroundLoops?: boolean } = {}): StartServerResult {
  const port = opts.port ?? config.port;

  const server = Bun.serve({
    port,
    hostname: opts.hostname,
    routes: {
      // Bun.serve treats a bare-function route as accept-any-method, so we
      // wrap GET-only routes in the method-keyed form to get automatic 405
      // on the wrong verb.
      "/healthz": { GET: secured(() => Response.json({ ok: true })) },
      "/api/auth/ext/launch-tab": { GET: secured(handleAuthExtLaunchTab) },
      // `secured` wraps the response with default-deny CSP + frame-deny
      // *unless* the handler set its own — `handleAuthExtSuccess` returns
      // a CSP with a sha256 script hash, so the global default-src 'none'
      // doesn't clobber it.
      "/api/auth/ext/success": { GET: secured(handleAuthExtSuccess) },
      "/api/auth/*": {
        GET: secured(handleAuthRequest),
        POST: secured(handleAuthRequest),
      },
      "/webhooks/drive": { POST: secured(handleDriveWebhook) },
      "/api/extension/doc-state": corsRoute({ POST: handleDocStatePost }),
      "/api/extension/doc-sync": corsRoute({ POST: handleDocSyncPost }),
      "/api/extension/project": corsRoute({ POST: handleProjectDetailPost }),
      "/api/extension/project-delete": corsRoute({ POST: handleProjectDeletePost }),
      "/api/extension/projects": corsRoute({ POST: handleProjectsListPost }),
      "/api/extension/version/create": corsRoute({ POST: handleVersionCreatePost }),
      "/api/extension/version-diff": corsRoute({ POST: handleVersionDiffPost }),
      "/api/extension/version-comments": corsRoute({ POST: handleVersionCommentsPost }),
      "/api/extension/comment-action": corsRoute({ POST: handleCommentActionPost }),
      "/api/extension/settings": corsRoute({ POST: handleSettingsPost }),
      "/api/extension/whoami": corsRoute({ POST: handleWhoamiPost }),
      "/api/extension/review/request": corsRoute({ POST: handleReviewRequestPost }),
      "/api/picker/page": { GET: secured(handlePickerPage) },
      "/api/picker/register-doc": corsRoute({ POST: handleRegisterDocPost }),
      "/r/:token": { GET: secured(handleReviewActionGet) },
      "/fonts/:filename": { GET: secured(handleFontRequest) },
      "/static/:filename": { GET: secured(handleStaticAsset) },
    },
    fetch() {
      return new Response("not found", { status: 404 });
    },
    error(err) {
      console.error("server error:", err);
      return new Response("internal error", { status: 500 });
    },
  });

  setActiveServer(server);

  const loops = opts.backgroundLoops === false ? null : startBackgroundLoops();

  return {
    port: server.port,
    hostname: server.hostname,
    async stop() {
      loops?.stop();
      await server.stop();
      setActiveServer(null);
    },
  };
}
