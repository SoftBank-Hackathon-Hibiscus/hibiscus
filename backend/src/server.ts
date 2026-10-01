import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildService } from "./build.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const service = buildService(config);
const app = createApp(service);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[backend] http://localhost:${info.port}`);
  console.log(`[backend] WORK_DIR=${config.workDir} REPO_ROOT=${config.repoRoot}`);
  console.log(`[backend] SIGNER_MODE=${config.signerMode} DEPLOY_MODE=${config.deployMode} execution_mode=skeleton`);
});
