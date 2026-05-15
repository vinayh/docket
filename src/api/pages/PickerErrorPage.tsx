import { Layout } from "./Layout.tsx";
import { BrandMark } from "./BrandMark.tsx";

export type PickerErrorVariant = "not-signed-in" | "not-configured" | "token-error";

export interface PickerErrorPageProps {
  variant: PickerErrorVariant;
  /** Raw error string surfaced under a `<code>` block for `token-error`. */
  details?: string;
}

function titleFor(variant: PickerErrorVariant): string {
  switch (variant) {
    case "not-signed-in":
      return "Margin — Sign in first";
    case "not-configured":
      return "Margin — Picker not configured";
    case "token-error":
      return "Margin — Token error";
  }
}

export function PickerErrorPage(props: PickerErrorPageProps) {
  return (
    <Layout title={titleFor(props.variant)}>
      <BrandMark />
      {props.variant === "not-signed-in" ? (
        <p class="mt-4 text-ink-2">
          You need to sign in before picking a Doc. Open the Margin extension and click{" "}
          <em>Sign in with Google</em>, then re-launch the Picker.
        </p>
      ) : null}
      {props.variant === "not-configured" ? (
        <p class="mt-4 text-ink-2">
          The Drive Picker is not configured on this server. The operator needs to set{" "}
          <code class="font-mono text-sm">GOOGLE_CLIENT_ID</code>,{" "}
          <code class="font-mono text-sm">GOOGLE_API_KEY</code>, and{" "}
          <code class="font-mono text-sm">GOOGLE_PROJECT_NUMBER</code>.
        </p>
      ) : null}
      {props.variant === "token-error" ? (
        <>
          <p class="mt-4 text-ink-2">
            Could not mint a Drive access token. Try signing out from the extension's Options page
            and signing in again.
          </p>
          {props.details ? (
            <p class="mt-2">
              <code class="font-mono text-sm">{props.details}</code>
            </p>
          ) : null}
        </>
      ) : null}
    </Layout>
  );
}
