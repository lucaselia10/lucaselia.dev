/**
 * The pinned AWS Lambda Web Adapter, shared by the fetch script (scripts/src/web-adapter.ts)
 * and the site app's deploy guard (site-app.ts). Pure constants: no imports.
 */
export const WEB_ADAPTER_VERSION = "1.1.0";
export const WEB_ADAPTER_REGISTRY = "https://public.ecr.aws";
export const WEB_ADAPTER_REPOSITORY = "awsguru/aws-lambda-adapter";
/** The linux/arm64 manifest that the 1.1.0 index pointed to on October 18, 2026. */
export const WEB_ADAPTER_ARM64_MANIFEST =
  "sha256:98d6d1dc9ad3f18c6af7baaa397fb033a57d82f5bffb58ff33bef1c2e1f4f0fe";
/** SHA-256 of /lambda-adapter inside that image. */
export const WEB_ADAPTER_BINARY_SHA256 =
  "317590a03cf57b695c2075c6f42c01cc22ce50d5eb21d6b7ca844cba0403dedc";

/**
 * The layer's /opt/bootstrap. It is AWS_LAMBDA_EXEC_WRAPPER: the runtime hands it its own
 * start command, and it starts the function's handler script instead, as the adapter's own
 * layer does. The adapter itself runs as the extension in /opt/extensions.
 */
export const WEB_ADAPTER_BOOTSTRAP = '#!/bin/bash\nexec -- "${LAMBDA_TASK_ROOT}/${_HANDLER}"\n';

/** Written in place of the binary for CI synthesis. Fails loudly if it ever runs. */
export const WEB_ADAPTER_STUB_MARKER = "STUB-NOT-DEPLOYABLE";
export const WEB_ADAPTER_STUB =
  "#!/bin/sh\n" +
  `# ${WEB_ADAPTER_STUB_MARKER}: a placeholder for CI synthesis, not the Lambda Web Adapter.\n` +
  "echo 'Stub Lambda Web Adapter layer. Run pnpm prepare:web-adapter before deploying.' >&2\n" +
  "exit 1\n";
