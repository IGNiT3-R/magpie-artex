import { createHash } from "node:crypto";
import { desiredProfile } from "./config.mjs";

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sameID = (a, b) => a != null && b != null && String(a) === String(b);
const matches = (profile, target) => Object.entries(target).every(([key, value]) => (profile[key] ?? "") === value);
const publicTarget = ({ name, model, format, base_url }) => ({ name, model, format, base_url });

// A profile is what ARTEX's own chat/task/agent pickers list. No provider
// plugin or UI change in ARTEX is needed: use its existing profile API.
export function catalogTargets(bridge, config) {
  if (bridge.models === undefined) return [];
  if (!Array.isArray(bridge.models)) throw new Error("Magpie 的模型列表格式无效，请重新接入 ARTEX。");
  const prefix = config.profile_name === "Magpie (managed)" ? "Magpie" : config.profile_name;
  const seen = new Set();
  return bridge.models.map((item) => {
    if (!item || typeof item.id !== "string" || !item.id.includes("/") || /[\r\n]/.test(item.id) || seen.has(item.id)) {
      throw new Error("Magpie 的模型列表包含无效或重复的模型 ID，请重新接入 ARTEX。");
    }
    seen.add(item.id);
    const profile = desiredProfile({ ...bridge, model: item.id, format: item.format, context_window_k: item.context_window_k, max_tokens: item.max_tokens }, config);
    // Reasoning, retries, streaming and rate limits belong to the user in
    // ARTEX. Only the endpoint/key/model and catalog limits are managed.
    const { thinking_type, reasoning_effort, max_tokens_field, proxy, pool_exclude, ...target } = profile;
    return { name: `${prefix} · ${item.id}`, ...target };
  });
}

export async function syncCatalog({ targets, state, profiles, client, persist }) {
  if (state.catalog !== undefined && (!Array.isArray(state.catalog) || state.catalog.some((entry) => !entry || typeof entry.model !== "string" || typeof entry.profile_name !== "string"))) {
    throw new Error("模型目录的恢复记录无效，已停止写入 ARTEX。");
  }
  const records = state.catalog || [];
  const byModel = new Map(records.map((entry) => [entry.model, entry]));
  // Check every name before changing any profile. Existing profiles are
  // adopted only after a journaled create whose response may have been lost.
  const plans = targets.map((target) => {
    const record = byModel.get(target.model);
    let owned = record?.profile_id ? profiles.find((profile) => sameID(profile.id, record.profile_id)) : null;
    if (owned && owned.name !== record.profile_name) throw new Error(`模型配置“${record.profile_name}”已被重命名；请恢复名称后重试。`);
    if (record?.profile_id && !owned && !record.pending_delete) throw new Error(`模型配置“${record.profile_name}”已被删除；请保留恢复记录并检查 ARTEX。`);
    if (!owned) {
      const collisions = profiles.filter((profile) => profile.name === target.name);
      if (collisions.length) {
        if (collisions.length !== 1 || !record?.pending_create || !matches(collisions[0], record.pending_create)) {
          throw new Error(`ARTEX 已有同名配置“${target.name}”，插件不会接管它。`);
        }
        owned = collisions[0];
      }
    }
    return { target, record, owned };
  });
  state.catalog = records;
  for (const plan of plans) {
    const { target, owned } = plan;
    let record = plan.record;
    if (!record) {
      record = { model: target.model, profile_name: target.name, profile_id: null };
      records.push(record);
    }
    if (owned && !record.profile_id) {
      record.profile_id = String(owned.id);
      await persist();
    }
    const signature = fingerprint(target);
    if (owned && record.pending_delete) {
      delete record.pending_delete;
      delete record.retired_profile;
      await persist();
    }
    const { api_key, ...visible } = target;
    const drifted = owned && (!matches(owned, visible) || (owned.api_key_hint && owned.api_key_hint !== `…${api_key.slice(-4)}`));
    if (owned && record.applied === signature && !record.pending_create && !drifted) continue;
    if (!owned) {
      record.pending_create = publicTarget(target);
      await persist();
    }
    const { api_key_hint: ignored, is_default: ignoredDefault, ...existing } = owned || record.retired_profile || {};
    const id = await client.save({
      streaming: true, rate_per_second: 0, rate_per_minute: 0, priority: 0, pool_exclude: true,
      ...existing, ...target, id: owned ? Number(owned.id) : 0,
    });
    record.profile_id = id;
    record.applied = signature;
    delete record.pending_create;
    delete record.pending_delete;
    delete record.retired_profile;
    await persist();
  }
  const wanted = new Set(targets.map((target) => target.model));
  const stale = records.filter((record) => !wanted.has(record.model) && record.profile_id);
  let removed = 0, retained = 0;
  let references;
  let cleanupError;
  if (stale.length) {
    try { references = await client.profileReferences(); }
    catch (error) { cleanupError = error.message; }
  }
  for (const record of stale) {
    const profile = profiles.find((item) => sameID(item.id, record.profile_id));
    if (!profile) {
      // A successful DELETE may have lost its response, or ARTEX's user
      // already removed this unselected entry. Reselection recreates it.
      record.profile_id = null;
      delete record.applied;
      delete record.pending_delete;
      await persist();
      continue;
    }
    if (!references || references.has(String(profile.id)) || profile.is_default || profile.proxy || profile.name !== record.profile_name || profile.model !== record.model) {
      retained++;
      continue;
    }
    // Keep user tuning, but no key or key hint, for a later reselection.
    // Journal BEFORE deletion so interrupted cleanup is recoverable.
    record.retired_profile = Object.fromEntries([
      "streaming", "rate_per_second", "rate_per_minute", "priority", "pool_exclude", "thinking_type",
      "reasoning_effort", "max_tokens_field", "session_header_key", "retry",
    ].filter((key) => profile[key] !== undefined).map((key) => [key, profile[key]]));
    record.pending_delete = true;
    await persist();
    try { await client.remove(profile.id); }
    catch (error) { cleanupError = error.message; retained++; continue; }
    record.profile_id = null;
    delete record.applied;
    delete record.pending_delete;
    await persist();
    removed++;
  }
  return {
    catalog_models: targets.length,
    ...(removed ? { catalog_removed: removed } : {}),
    ...(retained ? { catalog_retained: retained, catalog_notice: cleanupError || `另有 ${retained} 个未勾选的旧配置仍为默认、被任务/Agent/会话绑定或已被手动修改，已保留。` } : {}),
  };
}
