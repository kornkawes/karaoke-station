import { copyFile, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { cloneJson } from "./compat.js";
import { defaultSecrets, defaultState, storedSecretsSchema, storedStateSchema } from "./schemas.js";

async function readValidated(filePath, backupPath, schema, fallback) {
  let mainError = null;
  for (const [candidate, source] of [[filePath, "main"], [backupPath, "backup"]]) {
    try {
      const raw = await readFile(candidate, "utf8");
      const parsedJson = JSON.parse(raw);
      const value = schema.parse(parsedJson);
      return {
        value,
        source,
        needsWrite: parsedJson?.schemaVersion !== value?.schemaVersion
      };
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      if (source === "main") {
        mainError = error;
        continue;
      }
      throw error;
    }
  }
  if (mainError) throw mainError;
  return { value: fallback(), source: "fallback", needsWrite: true };
}

async function atomicWrite(filePath, value, { backupCurrent = true } = {}) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${filePath}.bak`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  if (backupCurrent) {
    try {
      await copyFile(filePath, backupPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

export class JsonRepository {
  constructor({ dataDir, envApiKey = "" }) {
    this.dataDir = path.resolve(dataDir);
    this.statePath = path.join(this.dataDir, "state.json");
    this.secretsPath = path.join(this.dataDir, "secrets.json");
    this.state = defaultState();
    this.secrets = defaultSecrets(envApiKey);
    this.writeChain = Promise.resolve();
    this.envApiKey = envApiKey;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    const loadedState = await readValidated(
      this.statePath,
      `${this.statePath}.bak`,
      storedStateSchema,
      defaultState
    );
    const loadedSecrets = await readValidated(
      this.secretsPath,
      `${this.secretsPath}.bak`,
      storedSecretsSchema,
      () => defaultSecrets(this.envApiKey)
    );
    this.state = loadedState.value;
    this.secrets = loadedSecrets.value;
    if (this.envApiKey) this.secrets.youtubeApiKey = this.envApiKey;
    await Promise.all([
      this.#repairOrInitialize(
        this.statePath,
        this.state,
        loadedState.source,
        loadedState.needsWrite
      ),
      this.#repairOrInitialize(
        this.secretsPath,
        this.secrets,
        loadedSecrets.source,
        loadedSecrets.needsWrite
      )
    ]);
    return this;
  }

  snapshot() {
    return cloneJson(this.state);
  }

  secretStatus() {
    return {
      youtubeConfigured: Boolean(this.envApiKey || this.secrets.youtubeApiKey),
      partyPinExpiresAt: this.secrets.partyPinExpiresAt
    };
  }

  getYoutubeApiKey() {
    return this.envApiKey || this.secrets.youtubeApiKey;
  }

  getPartyPin() {
    return this.secrets.partyPin;
  }

  isPartyPinValid(pin) {
    return (
      this.isPartySessionActive() &&
      pin === this.secrets.partyPin
    );
  }

  isPartySessionActive() {
    return (
      this.state.settings.partyEnabled &&
      Date.parse(this.secrets.partyPinExpiresAt) > Date.now()
    );
  }

  mutate(mutator) {
    return this.#serialize(async () => {
      const draft = cloneJson(this.state);
      const result = await mutator(draft);
      draft.revision += 1;
      const validated = storedStateSchema.parse(draft);
      await atomicWrite(this.statePath, validated);
      this.state = validated;
      return { state: this.snapshot(), result };
    });
  }

  mutateSecrets(mutator) {
    return this.#serialize(async () => {
      const draft = cloneJson(this.secrets);
      const result = await mutator(draft);
      const validated = storedSecretsSchema.parse(draft);
      await atomicWrite(this.secretsPath, validated);
      this.secrets = validated;
      return { status: this.secretStatus(), result };
    });
  }

  #serialize(operation) {
    const run = this.writeChain.then(operation, operation);
    this.writeChain = run.catch(() => {});
    return run;
  }

  async #repairOrInitialize(filePath, value, source, needsWrite = false) {
    if (source === "main" && !needsWrite) return;
    await atomicWrite(filePath, value, { backupCurrent: source === "main" });
    if (source === "fallback") {
      await copyFile(filePath, `${filePath}.bak`);
    }
  }
}
