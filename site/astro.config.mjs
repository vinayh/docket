import { defineConfig, fontProviders } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import preact from '@astrojs/preact';

export default defineConfig({
  site: 'https://margin.vinayh.com',
  integrations: [preact()],
  vite: {
    plugins: [tailwindcss()],
  },
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Bagel Fat One',
      cssVariable: '--font-display',
      weights: [400],
      styles: ['normal'],
      fallbacks: ['Recoleta', 'Fraunces', 'ui-serif', 'serif'],
    },
    {
      provider: fontProviders.google(),
      name: 'Inter',
      cssVariable: '--font-sans',
      weights: ['100 900'],
      fallbacks: [
        'ui-sans-serif',
        'system-ui',
        '-apple-system',
        'Segoe UI',
        'sans-serif',
      ],
    },
    {
      provider: fontProviders.google(),
      name: 'JetBrains Mono',
      cssVariable: '--font-mono',
      weights: ['100 800'],
      fallbacks: ['ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
    },
  ],
});
