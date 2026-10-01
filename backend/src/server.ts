import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { buildService } from "./build.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const service = buildService(config);
const app = createApp(service);

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`[backend] http://${info.address}:${info.port} (HOST=${config.host}. webhook·인증이 붙기 전에는 외부 공개용이 아님)`);
  console.log(`[backend] WORK_DIR=${config.workDir} REPO_ROOT=${config.repoRoot}`);
  console.log(`[backend] SIGNER_MODE=${config.signerMode} DEPLOY_MODE=${config.deployMode} execution_mode=skeleton`);
});
