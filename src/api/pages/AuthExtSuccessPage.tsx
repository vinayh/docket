import { Layout } from "./Layout.tsx";
import { BrandMark } from "./BrandMark.tsx";
import { buildBridgeScript } from "./AuthExtSuccessPage.script.ts";

export interface AuthExtSuccessPageProps {
  extId: string;
  token: string;
  nonce: string;
}

export function AuthExtSuccessPage(props: AuthExtSuccessPageProps) {
  const script = buildBridgeScript(props.extId, props.token);
  return (
    <Layout title="Margin — Signed in" inlineScript={script} nonce={props.nonce}>
      <BrandMark />
      <p id="status" class="mt-4 text-ink-2">Finishing sign-in…</p>
    </Layout>
  );
}
