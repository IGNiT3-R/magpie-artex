import { createHash } from "node:crypto";
import { ArtexClient } from "./client.mjs";
import { catalogTargets, syncCatalog } from "./catalog.mjs";
import { desiredProfile, MANAGED_BY, validateConfig } from "./config.mjs";
import { pathsFor, readJSON, withLock, writeJSON } from "./files.mjs";
import { ConnectionResolver } from "./wsl.mjs";

const sameID = (a, b) => a != null && b != null && String(a) === String(b);
const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const publicTarget = (p) => ({ name: p.name, model: p.model, format: p.format, base_url: p.base_url });
const matches = (a, b) => Object.entries(b).every(([key, value]) => (a[key] ?? "") === value);

export class Synchronizer {
  constructor({ paths = pathsFor(), bridgeFile = paths.agent, clientFactory = (config) => new ArtexClient(config), connectionResolver = new ConnectionResolver() } = {}) {
    this.paths = paths;
    this.bridgeFile = bridgeFile;
    this.clientFactory = clientFactory;
    this.clientKey = "";
    this.client = null;
    this.connectionResolver = connectionResolver;
  }

  async sync() {
    return withLock(this.paths, async () => {
      try {
        const result = await this.reconcile();
        await this.record(result);
        return result;
      } catch (error) {
        await this.record({ status: "error", message: error.message }).catch(() => {});
        throw error;
      }
    });
  }

  async disconnect() {
    return withLock(this.paths, async () => {
      const bridge = await readJSON(this.bridgeFile);
      if (bridge?.managed_by === MANAGED_BY) {
        const keep = { ...bridge };
        for (const key of ["managed_by", "model", "api_key", "base_url", "format", "context_window_k", "max_tokens", "models"]) delete keep[key];
        await writeJSON(this.bridgeFile, keep);
      }
      try {
        const result = await this.reconcile();
        await this.record(result);
        return result;
      } catch (error) {
        await this.record({ status: "error", message: error.message }).catch(() => {});
        throw error;
      }
    });
  }

  async record(result) {
    const previous = await readJSON(this.paths.status).catch(() => null);
    const { updated_at: ignored, ...last } = previous || {};
    if (JSON.stringify(last) !== JSON.stringify(result)) {
      await writeJSON(this.paths.status, { ...result, updated_at: new Date().toISOString() });
    }
  }

  async reconcile() {
    const raw = await readJSON(this.paths.config);
    if (!raw) return { status: "waiting", message: "请先在此 ARTEX Agent 的详情 → 设置中保存连接。" };
    const config = validateConfig(raw);
    const bridge = await readJSON(this.bridgeFile);
    let desired = desiredProfile(bridge, config);
    let state = await readJSON(this.paths.state);
    if (state && (state.version !== 1 || state.artex_url !== config.url)) {
      throw new Error("state.json 与当前 ARTEX 实例不匹配；请先恢复旧实例，使用独立配置目录连接新实例。 ");
    }
    if (!desired && !state?.connected && state?.phase !== "connecting") {
      return { status: "disconnected", message: "请在 Magpie → Agents 接入 ARTEX，随后即可在 ARTEX 中选择 Magpie 的模型。" };
    }
    let connectionInfo = {};
    let targets = [];
    if (desired) {
      const resolved = await this.connectionResolver.resolve(bridge, config);
      desired = desiredProfile(resolved.bridge, resolved.config);
      targets = catalogTargets(resolved.bridge, resolved.config);
      connectionInfo = resolved.info;
    }
    const key = fingerprint(config);
    if (key !== this.clientKey) {
      this.client = this.clientFactory(config);
      this.clientKey = key;
    }
    const profiles = await this.client.profiles();
    const active = profiles.find((p) => p.is_default);
    let owned = state?.profile_id ? profiles.find((p) => sameID(p.id, state.profile_id)) : null;
    if (owned && owned.name !== state.profile_name) {
      throw new Error("插件专用 LLM 配置已被重命名；请恢复名称后同步，避免改动其他配置。 ");
    }
    if (state?.profile_id && !owned) {
      throw new Error("插件专用 LLM 配置已被删除；请保留 state.json 并检查 ARTEX 配置后重新初始化。 ");
    }
    // A create response may have been lost. Only recover a profile for which
    // the on-disk journal was written BEFORE that create was attempted.
    if (!owned) {
      const name = state?.profile_name || config.profile_name;
      const collisions = profiles.filter((p) => p.name === name);
      if (collisions.length) {
        if (collisions.length !== 1 || state?.phase !== "connecting" || !state.pending_create || !matches(collisions[0], state.pending_create)) {
          throw new Error(`ARTEX 已有同名配置“${name}”，插件不会接管它；请在连接管理的高级设置中指定新的专用配置名称。`);
        }
        owned = collisions[0];
        state.profile_id = String(owned.id);
        await writeJSON(this.paths.state, state);
      }
    }
    if (!desired) return this.restore(state, active, profiles);

    const signature = fingerprint(desired);
    const changed = !state?.connected || state.applied !== signature || state.phase === "connecting";
    // The ARTEX editor can also fetch /v1/models and change the managed
    // profile's model. Keep that choice until an explicit change in Magpie.
    if (!changed && owned?.model !== desired.model) {
      const picked = targets.find((target) => target.model === owned?.model);
      if (picked) {
        const { name, ...local } = picked;
        desired = { ...desired, ...local };
      }
    }
    const finish = async (result) => {
      const catalog = bridge.models === undefined ? {} : await syncCatalog({ targets, state, profiles, client: this.client, persist: () => writeJSON(this.paths.state, state) });
      return {
        ...result, ...catalog,
        ...(catalog.catalog_models !== undefined ? { message: `已将 ${catalog.catalog_models} 个可见的 Magpie 模型/路由组同步到 ARTEX，可在 ARTEX 中直接选择。${result.status === "inactive" ? "已保留 ARTEX 当前默认配置。" : ""}${catalog.catalog_notice || ""}` } : {}),
      };
    };
    // A person selecting another default in ARTEX takes precedence until the
    // next explicit model/configuration change in Magpie.
    if (!changed && !sameID(active?.id, owned?.id)) {
      return finish({ status: "inactive", model: desired.model, profile_id: String(owned.id), ...connectionInfo, message: "ARTEX 已手动切换到其他默认配置；再次更换 Magpie 模型可重新接入。" });
    }
    const { api_key, ...visibleFields } = desired;
    const drifted = owned && (!matches(owned, visibleFields) || (owned.api_key_hint && owned.api_key_hint !== `…${api_key.slice(-4)}`));
    const result = { status: "synced", model: desired.model, format: desired.format, profile_id: state?.profile_id, ...connectionInfo, message: "ARTEX 的 Magpie 专用配置已同步。" };
    if (!changed && !drifted) return finish(result);

    if (!state) {
      state = { version: 1, artex_url: config.url, profile_name: config.profile_name, profile_id: null, previous_profile_id: active ? String(active.id) : null, connected: false };
    }
    if (changed && state.phase !== "connecting") {
      if (!sameID(active?.id, owned?.id)) state.previous_profile_id = active ? String(active.id) : null;
      state.phase = "connecting";
      state.pending_create = publicTarget({ ...desired, name: state.profile_name });
      await writeJSON(this.paths.state, state);
    }
    if (!owned || changed || drifted) {
      // DTOs expose only api_key_hint; keep all other knobs from the managed
      // profile (streaming, rates, retries, session headers) on every update.
      const { api_key_hint: ignored, is_default: ignoredDefault, ...existing } = owned || {};
      const payload = { streaming: true, rate_per_second: 0, rate_per_minute: 0, priority: 0, ...existing, ...desired, name: state.profile_name, id: owned ? Number(owned.id) : 0 };
      const id = await this.client.save(payload);
      state.profile_id = id;
      owned = { ...payload, id };
      await writeJSON(this.paths.state, state);
    }
    if (changed && !sameID(active?.id, state.profile_id)) await this.client.activate(state.profile_id);
    state.phase = "synced";
    state.connected = true;
    state.applied = signature;
    delete state.pending_create;
    await writeJSON(this.paths.state, state);
    return finish({ ...result, profile_id: state.profile_id });
  }

  async restore(state, active, profiles) {
    if (sameID(active?.id, state.profile_id)) {
      const previous = profiles.find((p) => sameID(p.id, state.previous_profile_id));
      if (!previous) {
        throw new Error("无法恢复原默认配置（原本未设置或已删除）。请在 ARTEX 激活其他 LLM 配置，再运行 disconnect；专用配置已保留。 ");
      }
      await this.client.activate(previous.id);
    }
    state.connected = false;
    state.phase = "disconnected";
    delete state.applied;
    delete state.pending_create;
    await writeJSON(this.paths.state, state);
    return { status: "disconnected", profile_id: state.profile_id, message: "已断开；原默认配置已恢复，或保留了用户后来选择的默认配置。专用配置仍保留。" };
  }
}
