import { Layout } from "./Layout.tsx";
import { BrandMark } from "./BrandMark.tsx";
import { buildPickerScript, type PickerScriptInputs } from "./PickerPage.script.ts";

export interface PickerPageProps extends PickerScriptInputs {
  nonce: string;
}

export function PickerPage(props: PickerPageProps) {
  const script = buildPickerScript({
    apiKey: props.apiKey,
    projectNumber: props.projectNumber,
    accessToken: props.accessToken,
  });
  return (
    <Layout
      title="Margin — Pick a Doc"
      externalScripts={["https://apis.google.com/js/api.js"]}
      inlineScript={script}
      nonce={props.nonce}
    >
      <BrandMark />
      <p id="status" class="mt-4 text-ink-2">Loading Picker…</p>
    </Layout>
  );
}
