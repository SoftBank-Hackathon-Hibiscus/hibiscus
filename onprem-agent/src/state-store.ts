import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentState } from "./types.js";

const emptyState = (): AgentState => ({
  schema_version: 1,
  serving_container: null,
  containers: {},
  completed_jobs: {},
});

export class StateStore {
  private state?: AgentState;

  constructor(private readonly path: string) {}

  async read(): Promise<AgentState> {
    if (!this.state) this.state = await this.load();
    return structuredClone(this.state);
  }

  async write(state: AgentState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.path);
    this.state = structuredClone(state);
  }

  private async load(): Promise<AgentState> {
    try {
      const parsed = JSON.parse(
        await readFile(this.path, "utf8"),
      ) as AgentState;
      if (parsed.schema_version !== 1) {
        throw new Error("Agent state schema version is unsupported");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyState();
      throw error;
    }
  }
}
