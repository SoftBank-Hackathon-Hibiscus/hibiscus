import { defineConfig } from 'drizzle-kit';
import { backendConfig } from './src/config/configs/backend.config.js';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/database/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: backendConfig().databaseFile,
  },
});
