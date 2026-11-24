// Native Stage Updates & Auto-Collapse for AGY Claude Style (modeled on agy-powertools).
// - Zero app.asar patching & zero redundant floating bars: hooks Antigravity's live global
//   segment renderer & CascadeConfig resolver by source fingerprint, with clean restore on disable/destroy.
// - Request side: uses Antigravity's native protobuf clone/create schemas (when available, with safe
//   $typeName fallback) to enable `noToolExplanation: false`, `noToolSummary: false`, and append
//   the concise `agy_cs_stage_updates` prompt section.
// - Render side (`transformStageSegmentResult`):
//   - While running: turns collapsible segments containing stage updates into `inline` so progress
//     updates and tool calls stream in chronological order (Codex style).
//   - On completion: moves leading stage updates into the collapsible's `content.groups` and sets
//     `defaultExpanded: false, isActive: false, triggerVisible: true` so Antigravity's native
//     collapsible folds all intermediate updates & tools automatically, leaving only `tailSteps`
//     (final answer) outside.
// - Header meta: enhances Antigravity's native collapsible trigger in-place with matching native
//   font/size/weight (`· K 条进度 · N 步工具 · M 次思考`).
// Registers on globalThis.__agCsFeatures.stageCollapse.
(function (root, factory) {
  const feature = factory();
  if (typeof module === 'object' && module.exports) module.exports = feature;
  else {
    root.__agCsFeatures = root.__agCsFeatures || {};
    root.__agCsFeatures.stageCollapse = feature;
  }
})(typeof globalThis !== 'undefined' ? globalThis : window, function () {
  const APPROVAL_TEXT_RE = /\b(allow|approve|accept|reject|deny|confirm|run command)\b|允许|批准|拒绝|确认执行|授权/i;
  const STAGE_PROMPT_TITLE = 'agy_cs_stage_updates';
  const STAGE_UPDATE_RULE =
    'During this task, communicate brief visible progress updates in the user-facing response alongside tool calls. ' +
    'Before the first substantial tool action, write one concise sentence explaining the immediate next action and its purpose. ' +
    'After a meaningful finding, change of direction, or a few execution steps, write one or two concise sentences stating the result and next action. ' +
    'These are intermediate updates, not final answers: continue executing the task after each update. ' +
    'Do not narrate every command. Do not put updates only in private thinking, tool summaries, task artifacts, or notify_user. ' +
    'Use the user language. Never invent progress or expose private reasoning.';

  function hasApprovalPrompt(respEl) {
    if (!respEl || typeof respEl.querySelectorAll !== 'function') return false;
    if (
      respEl.querySelector(
        '[data-testid*="approval"], [data-testid*="permission"], [data-testid*="confirm"], [data-testid="ask-user-question"]'
      )
    ) {
      return true;
    }
    const buttons = respEl.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.closest('[data-testid="worked-for-collapsible"], [data-testid="user-message-actions"], .ag-cs-turn-bar')) {
        continue;
      }
      const txt = String(btn.textContent || '').trim();
      if (txt && txt.length <= 40 && APPROVAL_TEXT_RE.test(txt)) {
        return true;
      }
    }
    return false;
  }

  function isElementVisible(el) {
    if (!el) return false;
    if (el.classList && el.classList.contains('hidden')) return false;
    try {
      if (typeof getComputedStyle === 'function') {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      }
      if (typeof el.getBoundingClientRect === 'function') {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return false;
      }
    } catch {}
    return true;
  }

  function shouldAutoCollapseTurn({
    turnIsRunning,
    workedVisible,
    expanded,
    userToggled,
    autoCollapsed,
    hasApproval,
    seenRunning,
    isLast,
    hasFinalAnswer,
  }) {
    if (turnIsRunning) return false;
    if (!workedVisible) return false;
    if (!expanded) return false;
    if (userToggled || autoCollapsed || hasApproval) return false;
    return Boolean(seenRunning || !isLast || hasFinalAnswer);
  }

  function isStageUpdateGroup(g) {
    return Boolean(
      g &&
        g.type === 'step' &&
        g.step?.step?.case === 'plannerResponse' &&
        typeof g.step.step.value?.response === 'string' &&
        g.step.step.value.response.trim().length > 0
    );
  }

  function flattenToolGroupCollapsibles(groups) {
    if (!Array.isArray(groups) || groups.length === 0) return groups;
    let changed = false;
    const out = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (g && g.type === 'toolGroupCollapsible' && Array.isArray(g.steps) && g.steps.length > 0) {
        changed = true;
        const baseKey = String(g.key || `tg-${i}`);
        for (let j = 0; j < g.steps.length; j++) {
          const s = g.steps[j];
          const sIdx = s?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
          const key = Number.isInteger(sIdx) && sIdx >= 0 ? `step-${sIdx}` : `${baseKey}-s${j}`;
          out.push({ type: 'step', key, step: s, debugMode: Boolean(g.debugMode) });
        }
      } else {
        out.push(g);
      }
    }
    return changed ? out : groups;
  }

  function transformStageSegmentResult(result, args0) {
    if (!result || result.body?.type !== 'collapsible') return result;
    const groups = Array.isArray(result.body.content?.groups) ? result.body.content.groups : [];
    const leading = Array.isArray(result.leadingSteps) ? result.leadingSteps : [];
    const updates = leading.filter(isStageUpdateGroup);
    const hasStageUpdates = updates.length > 0 || groups.some(isStageUpdateGroup);
    const hasNestedToolGroups = groups.some((g) => g && g.type === 'toolGroupCollapsible');

    if (!hasStageUpdates && !hasNestedToolGroups) return result;

    // While running, retain native text/tool chronological order without the outer fold.
    // On completion, move leading updates into the collapsible fold AND flatten nested
    // "Explored / 已探索" toolGroupCollapsible groups so clicking "Worked for / 已运行" ONCE
    // reveals all steps directly instead of requiring two clicks.
    const active = Boolean(
      result.body.isActive || (args0?.isRunning && args0?.isLastTurn && args0?.segment?.isLatest)
    );
    if (active) {
      if (!hasStageUpdates) return result;
      return {
        ...result,
        body: {
          type: 'inline',
          content: result.body.content,
        },
      };
    }

    const mergedGroups = hasStageUpdates ? [...updates, ...groups] : groups;
    const flatGroups = flattenToolGroupCollapsibles(mergedGroups);
    return {
      ...result,
      leadingSteps: hasStageUpdates ? leading.filter((g) => !isStageUpdateGroup(g)) : leading,
      body: {
        ...result.body,
        defaultExpanded: false,
        isActive: false,
        triggerVisible: true,
        content: {
          ...result.body.content,
          groups: flatGroups,
        },
      },
    };
  }

  function discoverNativeStageBindings(globalObj) {
    const g = globalObj || (typeof globalThis !== 'undefined' ? globalThis : null);
    if (!g) return null;
    const bindings = {
      segmentName: null,
      resolveName: null,
      schemas: null,
      createProto: null,
      cloneProto: null,
    };
    let resolveSrc = '';
    const fnMap = new Map();
    let descs;
    try {
      descs = Object.getOwnPropertyDescriptors(g);
    } catch {
      return bindings;
    }

    for (const [name, desc] of Object.entries(descs)) {
      if (!('value' in desc)) continue;
      const rawVal = desc.value;
      if (typeof rawVal === 'function') {
        const val = typeof rawVal.__agCsStageOrig === 'function' ? rawVal.__agCsStageOrig : rawVal;
        let src = '';
        try {
          src = Function.prototype.toString.call(val);
        } catch {
          continue;
        }
        fnMap.set(name, val);
        if (
          !bindings.segmentName &&
          desc.writable &&
          src.includes('getStepRendererConfig:') &&
          src.includes('hasBeenCollapsed:') &&
          src.includes('leadingSteps:')
        ) {
          bindings.segmentName = name;
        }
        if (
          !bindings.resolveName &&
          desc.writable &&
          src.includes('lookupCustomModelInfo') &&
          src.includes('customModelInfoOverride') &&
          src.includes('checkpointConfig=void 0') &&
          src.length < 900
        ) {
          bindings.resolveName = name;
          resolveSrc = src;
        }
        if (
          !bindings.createProto &&
          src.includes('.$typeName=') &&
          src.includes('.members') &&
          src.includes('oneof') &&
          src.includes('Object.create')
        ) {
          bindings.createProto = val;
        }
      } else if (!bindings.schemas && rawVal && typeof rawVal === 'object') {
        try {
          if (Object.getOwnPropertyDescriptor(rawVal, 'CascadeConfigSchema')?.value) {
            bindings.schemas = rawVal;
          }
        } catch {}
      }
    }

    if (resolveSrc) {
      const m = resolveSrc.match(/=([\w$]+)\([\w$]+\.CascadeConfigSchema,/);
      if (m && fnMap.has(m[1])) {
        bindings.cloneProto = fnMap.get(m[1]);
      }
    }
    return bindings;
  }

  function extractStageSummary(respEl) {
    if (!respEl || typeof respEl.querySelectorAll !== 'function') {
      return { updateCount: 0, toolCount: 0, thinkCount: 0, planCount: 0, lastLabel: '' };
    }
    const toolGroups = Array.from(respEl.querySelectorAll('[data-testid="tool-group-collapsible"]'));
    const thinkTriggers = Array.from(respEl.querySelectorAll('[data-testid="thinking-collapsible-trigger"]'));
    const planChips = Array.from(respEl.querySelectorAll('[data-testid="step-plan-chip"]'));
    return {
      updateCount: 0,
      toolCount: toolGroups.length,
      thinkCount: thinkTriggers.length,
      planCount: planChips.length,
      lastLabel: '',
    };
  }

  function formatStageBadge(stats, isZh = true) {
    if (!stats) return '';
    const parts = [];
    if (stats.updateCount > 0) {
      parts.push(
        isZh
          ? `${stats.updateCount} 条进度`
          : `${stats.updateCount} update${stats.updateCount > 1 ? 's' : ''}`
      );
    }
    if (stats.toolCount > 0) {
      parts.push(isZh ? `${stats.toolCount} 步工具` : `${stats.toolCount} tool${stats.toolCount > 1 ? 's' : ''}`);
    }
    if (stats.thinkCount > 0) {
      parts.push(isZh ? `${stats.thinkCount} 次思考` : `${stats.thinkCount} thought${stats.thinkCount > 1 ? 's' : ''}`);
    }
    return parts.join(' · ');
  }

  function applyStageUpdateConfig(cascadeConfig, enabled = true, bindings = null) {
    const schemas = bindings?.schemas || null;
    const createProto = typeof bindings?.createProto === 'function' ? bindings.createProto : null;
    const cloneProto = typeof bindings?.cloneProto === 'function' ? bindings.cloneProto : null;

    if (
      schemas?.CascadeConfigSchema &&
      schemas?.CascadePlannerConfigSchema &&
      schemas?.PromptSectionCustomizationConfigSchema &&
      schemas?.PromptSectionSchema &&
      createProto &&
      cloneProto
    ) {
      const cfg = cascadeConfig
        ? cloneProto(schemas.CascadeConfigSchema, cascadeConfig)
        : createProto(schemas.CascadeConfigSchema, {});
      if (!enabled) {
        const existingPrompts = cfg.plannerConfig?.promptSectionCustomizationConfig;
        if (existingPrompts && Array.isArray(existingPrompts.appendPromptSections)) {
          existingPrompts.appendPromptSections = existingPrompts.appendPromptSections.filter(
            (s) => s && s.title !== STAGE_PROMPT_TITLE
          );
        }
        return cfg;
      }
      if (!cfg.plannerConfig) {
        cfg.plannerConfig = createProto(schemas.CascadePlannerConfigSchema, {});
      }
      cfg.plannerConfig.noToolExplanation = false;
      cfg.plannerConfig.noToolSummary = false;
      const prompts =
        cfg.plannerConfig.promptSectionCustomizationConfig ||
        createProto(schemas.PromptSectionCustomizationConfigSchema, {});
      const prevSections = Array.isArray(prompts.appendPromptSections) ? prompts.appendPromptSections : [];
      prompts.appendPromptSections = [
        ...prevSections.filter((s) => s && s.title !== STAGE_PROMPT_TITLE),
        createProto(schemas.PromptSectionSchema, {
          title: STAGE_PROMPT_TITLE,
          content: STAGE_UPDATE_RULE,
        }),
      ];
      cfg.plannerConfig.promptSectionCustomizationConfig = prompts;
      return cfg;
    }

    // Fallback when native protobuf constructors aren't present (e.g. unit tests)
    if (!cascadeConfig || typeof cascadeConfig !== 'object') return cascadeConfig;
    const prevPlanner = cascadeConfig.plannerConfig;
    if (!prevPlanner || typeof prevPlanner !== 'object') return cascadeConfig;
    const prevPromptCfg =
      prevPlanner.promptSectionCustomizationConfig && typeof prevPlanner.promptSectionCustomizationConfig === 'object'
        ? prevPlanner.promptSectionCustomizationConfig
        : null;
    const prevSections = Array.isArray(prevPromptCfg?.appendPromptSections) ? prevPromptCfg.appendPromptSections : [];
    const filtered = prevSections.filter((s) => s && s.title !== STAGE_PROMPT_TITLE);
    if (!enabled) {
      if (!prevPromptCfg) return cascadeConfig;
      return {
        ...cascadeConfig,
        plannerConfig: {
          ...prevPlanner,
          promptSectionCustomizationConfig: {
            $typeName: 'exa.cortex_pb.PromptSectionCustomizationConfig',
            removePromptSections: [],
            addPromptSections: [],
            replacePromptSections: [],
            templateOverrides: {},
            ...prevPromptCfg,
            appendPromptSections: filtered,
          },
        },
      };
    }
    const stageSection = {
      $typeName: 'exa.cortex_pb.PromptSection',
      title: STAGE_PROMPT_TITLE,
      content: STAGE_UPDATE_RULE,
      tokenType: 0,
      tokenSource: 0,
      templatedContent: '',
      criteria: [],
      dynamicContent: '',
      templatedDynamicContent: '',
    };
    const nextPromptCfg = {
      $typeName: 'exa.cortex_pb.PromptSectionCustomizationConfig',
      removePromptSections: [],
      addPromptSections: [],
      replacePromptSections: [],
      templateOverrides: {},
      ...(prevPromptCfg || {}),
      appendPromptSections: [...filtered, stageSection],
    };
    return {
      ...cascadeConfig,
      plannerConfig: {
        ...prevPlanner,
        noToolExplanation: false,
        noToolSummary: false,
        promptSectionCustomizationConfig: nextPromptCfg,
      },
    };
  }

  function hasFinalAnswerText(respEl, workedBtn) {
    if (!respEl) return false;
    const paras = respEl.querySelectorAll('p, pre, ul, ol, h1, h2, h3, table');
    for (const p of paras) {
      if (workedBtn && workedBtn.contains(p)) continue;
      if (p.closest('[data-testid="tool-group-collapsible"], [data-testid="thinking-collapsible-trigger"]')) {
        continue;
      }
      if (String(p.textContent || '').trim().length > 0) return true;
    }
    return false;
  }

  function findConversationService() {
    const anchor =
      document.querySelector('[data-testid="agent-input-box"]') ||
      document.querySelector('[data-testid="conversation-view"]') ||
      document.querySelector('#root')?.firstElementChild;
    if (!anchor) return null;
    const fKey = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'));
    if (!fKey) return null;
    let cur = anchor[fKey];
    let hops = 0;
    while (cur && hops < 400) {
      const v = cur.memoizedProps?.value;
      if (v && typeof v.sendUserCascadeMessage === 'function') {
        return v;
      }
      cur = cur.return;
      hops++;
    }
    return null;
  }

  function readFiberTurnState() {
    const anchor =
      document.querySelector('[data-testid="agent-input-box"]') ||
      document.querySelector('[data-testid="conversation-view"]');
    if (!anchor) return { convoRunning: false, turnStats: [] };
    const fKey = Object.keys(anchor).find((k) => k.startsWith('__reactFiber$'));
    if (!fKey) return { convoRunning: false, turnStats: [] };
    let cur = anchor[fKey];
    let hops = 0;
    let state = null;
    while (cur && hops < 300) {
      const v = cur.memoizedProps?.value;
      if (v?.cascadeContext?.state?.agentStateProvider?.getState) {
        try {
          state = v.cascadeContext.state.agentStateProvider.getState();
        } catch {}
        break;
      }
      cur = cur.return;
      hops++;
    }
    if (!state) return { convoRunning: false, turnStats: [] };

    const statusNum = Number(state.status || 0);
    const convoRunning = statusNum === 2 || statusNum === 4;
    const slice = state.trajectorySlice;
    const steps = Array.isArray(slice?.stepsInSlice) ? slice.stepsInSlice : [];
    const baseIdx = Number(slice?.stepsSlice?.startIndex || 0);
    const turns = Array.isArray(state.turns) ? state.turns : [];
    if (!steps.length || !turns.length) return { convoRunning, turnStats: [] };

    const turnStats = turns.map((turn, idx) => {
      const start = Number(turn?.startStepIndex ?? 0);
      const nextStart = idx + 1 < turns.length ? Number(turns[idx + 1]?.startStepIndex ?? Infinity) : Infinity;
      let toolCount = 0;
      let thinkCount = 0;
      let plannerTextIndices = [];
      let lastToolAbsIdx = -1;

      for (let i = 0; i < steps.length; i++) {
        const absIdx = baseIdx + i;
        if (absIdx < start || absIdx >= nextStart) continue;
        const s = steps[i];
        const sc = String(s?.step?.case || '').toLowerCase();
        const toolName = String(s?.metadata?.toolCall?.name || s?.metadata?.toolSummary || '').trim();
        if (sc === 'plannerresponse') {
          if (s?.step?.value?.thinking || s?.step?.value?.thinkingDuration) thinkCount++;
          if (typeof s?.step?.value?.response === 'string' && s.step.value.response.trim().length > 0) {
            plannerTextIndices.push(absIdx);
          }
        } else if (
          toolName ||
          (sc &&
            sc !== 'userinput' &&
            sc !== 'checkpoint' &&
            sc !== 'errormessage' &&
            sc !== 'systemmessage' &&
            sc !== 'ephemeralmessage' &&
            sc !== 'conversationtitle')
        ) {
          toolCount++;
          lastToolAbsIdx = absIdx;
        }
      }
      // Intermediate planner responses that occurred before a tool call are stage updates (excluding final answer).
      const updateCount =
        lastToolAbsIdx >= 0 ? plannerTextIndices.filter((pos) => pos < lastToolAbsIdx).length : 0;
      return { updateCount, toolCount, thinkCount, lastLabel: '' };
    });

    return { convoRunning, turnStats };
  }

  function create(ctx) {
    const turnState = new WeakMap();
    let syncTimer = null;
    let nativeBindings = null;
    let origSegment = null;
    let wrappedSegment = null;
    let origResolve = null;
    let wrappedResolve = null;
    let hookedSvc = null;
    let origSend = null;
    let wrappedSend = null;

    function isEnabled() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      return cfg.stageCollapse !== false;
    }

    function isZhLang() {
      const cfg = ctx.getCfg ? ctx.getCfg() : {};
      return (cfg.language || 'zh-CN') !== 'en';
    }

    function getOrInitState(el) {
      let st = turnState.get(el);
      if (!st) {
        st = { seenRunning: false, autoCollapsed: false, userToggled: false, lastStats: null };
        turnState.set(el, st);
      }
      return st;
    }

    function ensureNativeHooks(enabled) {
      try {
        if (!nativeBindings || (!nativeBindings.segmentName && !nativeBindings.resolveName)) {
          nativeBindings = discoverNativeStageBindings(typeof globalThis !== 'undefined' ? globalThis : null);
        }

        // 1. Hook native segment renderer (running -> inline chronological stream; done -> native collapsible)
        if (nativeBindings?.segmentName && typeof globalThis !== 'undefined') {
          const segName = nativeBindings.segmentName;
          const curSeg = globalThis[segName];
          if (typeof curSeg === 'function') {
            if (!origSegment) {
              origSegment = typeof curSeg.__agCsStageOrig === 'function' ? curSeg.__agCsStageOrig : curSeg;
            }
            if (enabled) {
              if (!wrappedSegment) {
                wrappedSegment = function agCsStageSegmentRender(...args) {
                  const res = origSegment.apply(this, args);
                  if (ctx.isDestroyed?.() || !isEnabled()) return res;
                  try {
                    return transformStageSegmentResult(res, args[0]);
                  } catch {
                    return res;
                  }
                };
                wrappedSegment.__agCsStageOrig = origSegment;
              }
              if (globalThis[segName] !== wrappedSegment) {
                globalThis[segName] = wrappedSegment;
              }
            } else if (globalThis[segName] === wrappedSegment || globalThis[segName]?.__agCsStageOrig === origSegment) {
              globalThis[segName] = origSegment;
            }
          }
        }

        // 2. Hook native CascadeConfig resolver (when present)
        if (nativeBindings?.resolveName && typeof globalThis !== 'undefined') {
          const resName = nativeBindings.resolveName;
          const curRes = globalThis[resName];
          if (typeof curRes === 'function') {
            if (!origResolve) {
              origResolve = typeof curRes.__agCsStageOrig === 'function' ? curRes.__agCsStageOrig : curRes;
            }
            if (enabled) {
              if (!wrappedResolve) {
                wrappedResolve = function agCsStageResolveConfig(...args) {
                  const baseCfg = origResolve.apply(this, args);
                  if (ctx.isDestroyed?.() || !isEnabled()) return baseCfg;
                  try {
                    return applyStageUpdateConfig(baseCfg, true, nativeBindings);
                  } catch {
                    return baseCfg;
                  }
                };
                wrappedResolve.__agCsStageOrig = origResolve;
              }
              if (globalThis[resName] !== wrappedResolve) {
                globalThis[resName] = wrappedResolve;
              }
            } else if (globalThis[resName] === wrappedResolve || globalThis[resName]?.__agCsStageOrig === origResolve) {
              globalThis[resName] = origResolve;
            }
          }
        }

        // 3. Hook conversation service sendUserCascadeMessage
        if (!enabled) {
          if (hookedSvc && origSend && (hookedSvc.sendUserCascadeMessage === wrappedSend || hookedSvc.sendUserCascadeMessage?.__agCsStageOrig === origSend)) {
            hookedSvc.sendUserCascadeMessage = origSend;
          }
          return;
        }
        const svc = hookedSvc || findConversationService();
        if (!svc || typeof svc.sendUserCascadeMessage !== 'function') return;
        if (svc !== hookedSvc) {
          if (hookedSvc && origSend && hookedSvc.sendUserCascadeMessage === wrappedSend) {
            hookedSvc.sendUserCascadeMessage = origSend;
          }
          hookedSvc = svc;
          const curSend = svc.sendUserCascadeMessage;
          origSend = typeof curSend.__agCsStageOrig === 'function' ? curSend.__agCsStageOrig : curSend;
          wrappedSend = async function agCsStageWrappedSend(payload, ...args) {
            if (!ctx.isDestroyed?.() && isEnabled() && payload && typeof payload === 'object') {
              const hasNativeProto = Boolean(nativeBindings?.schemas?.CascadeConfigSchema && nativeBindings?.createProto && nativeBindings?.cloneProto);
              if (hasNativeProto || payload.cascadeConfig?.plannerConfig) {
                try {
                  const nextPayload = {
                    ...payload,
                    cascadeConfig: applyStageUpdateConfig(payload.cascadeConfig, true, nativeBindings),
                  };
                  return await origSend.call(this, nextPayload, ...args);
                } catch (err) {
                  const msg = String(err && err.message ? err.message : err);
                  if (!/Cannot use field|protobuf|\$typeName/i.test(msg)) {
                    throw err;
                  }
                }
              }
            }
            return origSend.call(this, payload, ...args);
          };
          wrappedSend.__agCsStageOrig = origSend;
        }
        if (hookedSvc.sendUserCascadeMessage !== wrappedSend) {
          hookedSvc.sendUserCascadeMessage = wrappedSend;
        }
      } catch {}
    }

    function onCaptureClick(ev) {
      if (!ev || !ev.isTrusted) return;
      const workedBtn = ev.target?.closest?.('[data-testid="worked-for-collapsible"]');
      if (!workedBtn) return;
      const resp = workedBtn.closest('[data-testid="agent-response"]');
      if (!resp) return;
      const st = getOrInitState(resp);
      st.userToggled = true;
      // If expanding a historical turn whose DOM still has a nested "已探索" tool-group-collapsible,
      // auto-expand inner collapsed tool groups so one click on "已运行" reveals the steps immediately.
      const wasCollapsed = workedBtn.getAttribute('aria-expanded') === 'false';
      if (wasCollapsed && isEnabled()) {
        setTimeout(() => {
          if (ctx.isDestroyed?.() || !isEnabled()) return;
          if (workedBtn.getAttribute('aria-expanded') !== 'true') return;
          const nested = Array.from(resp.querySelectorAll('[data-testid="tool-group-collapsible"][aria-expanded="false"]'));
          for (const inner of nested) {
            if (isElementVisible(inner)) {
              try {
                inner.click();
              } catch {}
            }
          }
        }, 40);
      }
    }

    function clearDecorations() {
      document.querySelectorAll('.ag-cs-stage-bar, .ag-cs-stage-badge, .ag-cs-stage-meta-inline').forEach((el) => el.remove());
    }

    function syncInlineWorkedMeta(targetBtn, text, respEl) {
      if (respEl) {
        respEl.querySelectorAll('.ag-cs-stage-meta-inline').forEach((el) => {
          if (!targetBtn || el.parentElement !== targetBtn) el.remove();
        });
      }
      if (!targetBtn) return;
      let span = targetBtn.querySelector(':scope > .ag-cs-stage-meta-inline');
      if (!text) {
        if (span) span.remove();
        return;
      }
      if (!span) {
        span = document.createElement('span');
        span.className = 'ag-cs-stage-meta-inline text-muted-foreground';
        span.setAttribute('data-ag-no-i18n', '');
        const chevron = targetBtn.querySelector(':scope > svg');
        if (chevron) targetBtn.insertBefore(span, chevron);
        else targetBtn.appendChild(span);
      }
      const formatted = `· ${text}`;
      if (span.textContent !== formatted) span.textContent = formatted;
    }

    function findActiveRunningHeader(resp, workedBtn, workedVisible) {
      if (workedBtn && workedVisible) return workedBtn;
      const groups = Array.from(resp.querySelectorAll('[data-testid="tool-group-collapsible"]')).filter(isElementVisible);
      if (groups.length > 0) return groups[groups.length - 1];
      return null;
    }

    function sync() {
      if (ctx.isDestroyed && ctx.isDestroyed()) return;
      const enabled = isEnabled();
      ensureNativeHooks(enabled);
      if (!enabled) {
        clearDecorations();
        return;
      }

      // Clean up any legacy floating stage bars or sibling badge buttons
      document.querySelectorAll('.ag-cs-stage-bar, .ag-cs-stage-badge').forEach((el) => el.remove());

      const zh = isZhLang();
      const responses = Array.from(document.querySelectorAll('[data-testid="agent-response"]'));
      if (!responses.length) return;
      const { convoRunning, turnStats: fiberTurnStats } = readFiberTurnState();
      const hasCancelBtn = Boolean(document.querySelector('[data-testid="input-cancel-button"]'));

      for (let i = 0; i < responses.length; i++) {
        const resp = responses[i];
        const st = getOrInitState(resp);
        const workedBtn = resp.querySelector('[data-testid="worked-for-collapsible"]');
        const isLast = i === responses.length - 1;
        const turnIsRunning =
          Boolean(resp.querySelector('[data-testid="agent-loading"]')) ||
          (isLast && (convoRunning || hasCancelBtn));

        const domStats = extractStageSummary(resp);
        const fOffset = fiberTurnStats.length - responses.length;
        const fStats = fOffset + i >= 0 && fOffset + i < fiberTurnStats.length ? fiberTurnStats[fOffset + i] : null;
        const mergedStats = {
          updateCount: Math.max(fStats?.updateCount || 0, st.lastStats?.updateCount || 0),
          toolCount: Math.max(domStats.toolCount, fStats?.toolCount || 0, st.lastStats?.toolCount || 0),
          thinkCount: Math.max(domStats.thinkCount, fStats?.thinkCount || 0, st.lastStats?.thinkCount || 0),
          lastLabel: '',
        };
        if (mergedStats.updateCount > 0 || mergedStats.toolCount > 0 || mergedStats.thinkCount > 0) {
          st.lastStats = mergedStats;
        }

        const workedVisible = workedBtn ? isElementVisible(workedBtn) : false;
        const expanded = workedBtn ? workedBtn.getAttribute('aria-expanded') === 'true' : false;

        if (turnIsRunning) {
          st.seenRunning = true;
          st.autoCollapsed = false;

          // Recovery guard: if an earlier state left a running turn's hidden worked-for-collapsible
          // stuck in aria-expanded="false" (which hides all steps with no visible toggle), restore it.
          if (workedBtn && !workedVisible && !expanded && !st.userToggled) {
            try {
              workedBtn.click();
            } catch {}
          }

          const liveHeader = findActiveRunningHeader(resp, workedBtn, workedVisible);
          const liveBadge = liveHeader ? formatStageBadge(mergedStats, zh) : '';
          syncInlineWorkedMeta(liveHeader, liveBadge, resp);
          continue;
        }

        if (!workedBtn) {
          syncInlineWorkedMeta(null, '', resp);
          continue;
        }

        // Enhance Antigravity's native worked-for-collapsible row in-place (zero extra UI bar)
        const nativeWorkedText = workedBtn.querySelector('span:not(.ag-cs-stage-meta-inline)')?.textContent || '';
        const hasNativeUpdatesCount = /\d+\s*(?:updates?\b|条进度|條進度)/i.test(nativeWorkedText);
        const badgeStats = hasNativeUpdatesCount ? { ...mergedStats, updateCount: 0 } : mergedStats;
        const badgeText = workedVisible ? formatStageBadge(badgeStats, zh) : '';
        syncInlineWorkedMeta(workedBtn, badgeText, resp);

        // Fallback auto-collapse for completed turns that didn't have stage updates handled by segment hook
        if (
          shouldAutoCollapseTurn({
            turnIsRunning,
            workedVisible,
            expanded,
            userToggled: st.userToggled,
            autoCollapsed: st.autoCollapsed,
            hasApproval: hasApprovalPrompt(resp),
            seenRunning: st.seenRunning,
            isLast,
            hasFinalAnswer: hasFinalAnswerText(resp, workedBtn),
          })
        ) {
          st.autoCollapsed = true;
          try {
            workedBtn.click();
          } catch {}
        }
      }
    }

    document.addEventListener('click', onCaptureClick, true);
    syncTimer = setInterval(() => {
      if (!document.hidden) sync();
    }, 1500);

    return {
      ownSelector: '.ag-cs-stage-bar, .ag-cs-stage-badge, .ag-cs-stage-meta-inline',
      sync,
      destroy() {
        ensureNativeHooks(false);
        nativeBindings = null;
        origSegment = null;
        wrappedSegment = null;
        origResolve = null;
        wrappedResolve = null;
        hookedSvc = null;
        origSend = null;
        wrappedSend = null;
        document.removeEventListener('click', onCaptureClick, true);
        if (syncTimer) {
          clearInterval(syncTimer);
          syncTimer = null;
        }
        clearDecorations();
      },
    };
  }

  return {
    create,
    hasApprovalPrompt,
    isElementVisible,
    shouldAutoCollapseTurn,
    isStageUpdateGroup,
    flattenToolGroupCollapsibles,
    transformStageSegmentResult,
    discoverNativeStageBindings,
    extractStageSummary,
    formatStageBadge,
    applyStageUpdateConfig,
    STAGE_PROMPT_TITLE,
  };
});
