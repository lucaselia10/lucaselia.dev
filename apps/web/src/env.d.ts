/// <reference types="astro/client" />

interface ImportMetaEnv {
  readonly PUBLIC_ASK_API_URL?: string;
  readonly PUBLIC_ASK_STREAMING?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
