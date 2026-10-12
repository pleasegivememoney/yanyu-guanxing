(function (root) {
    'use strict';

    const SEARCH_LIMITS = Object.freeze({
        frontierLimit: 0,
        maxEventNodes: 400000,
        // 锁定时机扫描上线后，主搜预算需支撑全部候选锁定起点的展开：
        // 真实存档实测 8M 洗才能把「从正确洗点锁定工具脉」的主链跑完（2013 丹路线）。
        maxMainRawWashes: 8000000,
        maxTailRawWashes: 2000000,
        maxEventDepth: 96,
        estimatedTargetCost: 900,
        maxFinalTailExchangeDepth: 32,
        maxExchangePreviewDepth: 8,
        maxSparseTargetGap: 16,
        maxSparseRawDraws: 64,
        deferredInterleaveEvery: 24,
        maxLockTimingBranches: 120000,
        // 深度帽 100 会误杀主链（错误锁点的同类紫等待虽长，但部分正确锁点
        // 首条同类紫并非目标工具脉，需穿越中等等待才能接到正确窗口）。
        maxLockTimingSeekWashes: 400,
    });

    function numeric(value, fallback = 0) {
        const result = Number(value);
        return Number.isFinite(result) ? result : fallback;
    }

    function sleepTurn() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    class MinHeap {
        constructor(compare) {
            this.items = [];
            this.compare = compare;
        }

        get size() {
            return this.items.length;
        }

        peek() {
            return this.items[0];
        }

        push(value) {
            const items = this.items;
            items.push(value);
            let index = items.length - 1;
            while (index > 0) {
                const parent = (index - 1) >> 1;
                if (this.compare(items[parent], value) <= 0) break;
                items[index] = items[parent];
                index = parent;
            }
            items[index] = value;
        }

        pop() {
            const items = this.items;
            if (!items.length) return null;
            const first = items[0];
            const last = items.pop();
            if (items.length) {
                let index = 0;
                while (true) {
                    const left = index * 2 + 1;
                    if (left >= items.length) break;
                    const right = left + 1;
                    let child = right < items.length && this.compare(items[right], items[left]) < 0 ? right : left;
                    if (this.compare(items[child], last) >= 0) break;
                    items[index] = items[child];
                    index = child;
                }
                items[index] = last;
            }
            return first;
        }

        rebuild(compare, keep = () => true) {
            this.compare = compare;
            this.items = this.items.filter(keep);
            const items = this.items;
            for (let index = (items.length >> 1) - 1; index >= 0; index -= 1) {
                const value = items[index];
                let cursor = index;
                while (true) {
                    const left = cursor * 2 + 1;
                    if (left >= items.length) break;
                    const right = left + 1;
                    const child = right < items.length && compare(items[right], items[left]) < 0 ? right : left;
                    if (compare(items[child], value) >= 0) break;
                    items[cursor] = items[child];
                    cursor = child;
                }
                items[cursor] = value;
            }
        }
    }

    function traceAppend(trace, action) {
        return { previous: trace || null, action };
    }

    function traceActions(trace) {
        const actions = [];
        for (let cursor = trace; cursor; cursor = cursor.previous) actions.push(cursor.action);
        actions.reverse();
        return actions;
    }

    function traceFromActions(actions) {
        let trace = null;
        for (const action of (actions || [])) trace = traceAppend(trace, action);
        return trace;
    }

    function positionsForIds(state, ids) {
        const remaining = state.talents.map((id, index) => ({ id, index, used: false }));
        return ids.map(id => {
            const item = remaining.find(value => !value.used && value.id === id);
            if (!item) throw new Error(`锁脉回放失败：槽位中不存在天赋 ${id}`);
            item.used = true;
            return item.index;
        });
    }

    function idsInStateOrder(state, ids) {
        const wanted = new Set(ids);
        return state.talents.filter(id => wanted.has(id));
    }

    function targetsIn(state, targetSet) {
        return state.talents.filter(id => targetSet.has(id));
    }

    function containsTargets(state, targetSet) {
        for (const id of targetSet) if (!state.talents.includes(id)) return false;
        return true;
    }

    function actionWash(engine, state, keepIds, mode) {
        const result = engine.wash(state, positionsForIds(state, keepIds));
        return {
            state: result.state,
            action: {
                kind: 'wash',
                mode,
                keepIds: result.keepIds,
                cost: result.cost,
                draws: result.draws,
                generatedBars: result.generatedBars,
                after: result.state,
            },
        };
    }

    function actionReplace(engine, state, position, mode, lockedIds = []) {
        const orderedLocks = idsInStateOrder(state, lockedIds);
        const result = engine.replace(state, position, orderedLocks);
        return {
            state: result.state,
            action: {
                kind: 'exchange',
                mode,
                keepIds: orderedLocks,
                cost: 0,
                draws: result.draws,
                generatedBars: 0,
                removedId: result.removedId,
                addedId: result.addedId,
                after: result.state,
            },
        };
    }

    function actionUpgrade(engine, state, targetSlots = 4) {
        const slots = targetSlots === 3 ? 3 : 4;
        const targetZiZhi = 150 + slots;
        const method = slots === 3 ? 'upgradeToThree' : 'upgradeToFour';
        const upgraded = typeof engine[method] === 'function'
            ? engine[method](state)
            : { ...root.WashSourceEngine.cloneState(state), zizhi: targetZiZhi };
        return {
            state: upgraded,
            action: {
                kind: 'upgrade',
                mode: slots === 3 ? 'open-third-slot' : 'open-fourth-slot',
                targetSlots: slots,
                keepIds: [],
                cost: 0,
                draws: 0,
                generatedBars: 0,
                after: upgraded,
            },
        };
    }

    function actionUnlock(state, releasedIds = []) {
        const sameState = root.WashSourceEngine.cloneState(state);
        return {
            state: sameState,
            action: {
                kind: 'unlock',
                mode: 'destroy-vein-release',
                keepIds: [],
                releasedIds: releasedIds.slice(),
                cost: 0,
                draws: 0,
                generatedBars: 0,
                after: sameState,
            },
        };
    }

    function sameNumbers(left, right) {
        return left.length === right.length && left.every((value, index) => value === right[index]);
    }

    function compactActions(actions) {
        const groups = [];
        for (const action of actions) {
            const last = groups[groups.length - 1];
            if (action.kind === 'wash' && last && last.kind === 'wash'
                && last.mode === action.mode && sameNumbers(last.keepIds, action.keepIds)) {
                last.count += 1;
                last.cost += action.cost;
                last.draws += action.draws;
                last.generatedBars += action.generatedBars;
                last.after = action.after;
                continue;
            }
            groups.push({ ...action, keepIds: action.keepIds.slice(), count: action.kind === 'wash' ? 1 : 0 });
        }
        return groups;
    }

    function stateTalentNames(engine, state, lockedIds = []) {
        const locked = new Set(lockedIds);
        return state.talents.map(id => ({ id, name: engine.name(id), locked: locked.has(id) }));
    }

    function replayNode(ctx, node, actions) {
        let state = root.WashSourceEngine.cloneState(ctx.startState);
        let pills = 0;
        for (const action of actions) {
            if (action.kind === 'wash') {
                const replayed = ctx.engine.wash(state, positionsForIds(state, action.keepIds));
                state = replayed.state;
                pills += replayed.cost;
            } else if (action.kind === 'exchange') {
                const position = state.talents.indexOf(action.removedId);
                if (position < 0) throw new Error(`路线回放失败：找不到待置换天赋 ${action.removedId}`);
                state = ctx.engine.replace(state, position, action.keepIds).state;
            } else if (action.kind === 'upgrade') {
                const slots = numeric(action.targetSlots, action.mode === 'open-third-slot' ? 3 : 4);
                const method = slots === 3 ? 'upgradeToThree' : 'upgradeToFour';
                state = typeof ctx.engine[method] === 'function'
                    ? ctx.engine[method](state)
                    : { ...root.WashSourceEngine.cloneState(state), zizhi: 150 + slots };
            } else if (action.kind === 'unlock') {
                state = root.WashSourceEngine.cloneState(state);
            }
            if (root.WashSourceEngine.stateKey(state) !== root.WashSourceEngine.stateKey(action.after)) {
                throw new Error('路线回放失败：操作后状态与搜索状态不一致');
            }
        }
        if (pills !== node.cost || root.WashSourceEngine.stateKey(state) !== root.WashSourceEngine.stateKey(node.state)) {
            throw new Error('路线回放失败：累计丹耗或最终状态不一致');
        }
    }

    function stepLabel(group, engine) {
        if (group.kind === 'upgrade') return numeric(group.targetSlots, 4) === 3 ? '开启第三脉' : '开启第四脉';
        if (group.kind === 'unlock') return '毁脉：解除临时紫脉锁定';
        if (group.kind === 'exchange') return '置换冲突紫脉';
        if (group.mode === 'final-tail') return '锁定前三紫扫描尾脉';
        if (!group.keepIds.length) return '不锁脉推进';
        if (group.mode === 'scan-targets') return `锁定目标脉推进`;
        if (group.mode === 'seek-purple') return '锁前置冲突脉寻找紫脉';
        if (group.mode === 'pad-exchange') return '锁定冲突对垫洗';
        return `锁定 ${group.keepIds.map(id => engine.name(id)).join('、')} 推进`;
    }

    function stepDetail(group, engine) {
        if (group.kind === 'upgrade') {
            const slots = numeric(group.targetSlots, 4) === 3 ? 3 : 4;
            return `将当前资质提升到${slots === 3 ? '三' : '四'}脉；开槽本身不推进洗髓种子。`;
        }
        if (group.kind === 'unlock') {
            return `解除「${(group.releasedIds || []).map(id => engine.name(id)).join('、')}」的保护，作为毁脉临时支点继续洗；该动作本身不推进随机状态。`;
        }
        if (group.kind === 'exchange') {
            return `点击置换「${engine.name(group.removedId)}」，应得到「${engine.name(group.addedId)}」。`;
        }
        const locks = group.keepIds.length
            ? `锁定「${group.keepIds.map(id => engine.name(id)).join('、')}」`
            : '取消全部锁定';
        return `${locks}，连续洗脉 ${group.count} 次；以每次结果核对最后一组槽位。`;
    }

    function routeFromNode(ctx, node, extra = {}) {
        const actions = traceActions(node.trace);
        replayNode(ctx, node, actions);
        const groups = compactActions(actions);
        const steps = [];
        let cumulativePills = 0;
        let cumulativeWashes = 0;
        let cumulativeTalentBars = 0;
        const initialSlots = Math.max(0, Math.min(4, numeric(ctx.initialState.zizhi) - 150));
        const costBreakdown = {};
        for (const group of groups) {
            cumulativePills += group.cost;
            cumulativeWashes += group.kind === 'wash' ? group.count : 0;
            cumulativeTalentBars += group.generatedBars;
            if (group.kind === 'wash') {
                const slotCount = Math.max(0, Math.min(4, numeric(group.after?.zizhi, 154) - 150));
                const bucket = group.keepIds.length ? `lock${group.keepIds.length}`
                    : (slotCount === 3 ? 'threeUnlocked' : 'fourUnlocked');
                costBreakdown[bucket] = numeric(costBreakdown[bucket]) + group.cost;
            }
            steps.push({
                type: group.kind,
                label: stepLabel(group, ctx.engine),
                detail: stepDetail(group, ctx.engine),
                expectedName: group.kind === 'exchange' ? ctx.engine.name(group.addedId) : '',
                washes: group.kind === 'wash' ? group.count : 0,
                unitCost: group.kind === 'wash' ? group.cost / Math.max(1, group.count) : null,
                pills: group.cost,
                cumulativePills,
                cumulativeWashes,
                cumulativeTalentBars,
                after: { talents: stateTalentNames(ctx.engine, group.after, group.keepIds) },
            });
        }
        steps.push({
            type: 'verify', label: '核对最终目标',
            detail: `确认槽位同时包含：${ctx.targetIds.map(id => ctx.engine.name(id)).join('、')}。`,
            washes: 0, unitCost: null, pills: 0, cumulativePills, cumulativeWashes,
            cumulativeTalentBars, after: { talents: stateTalentNames(ctx.engine, node.state, ctx.targetIds) },
        });
        const available = ctx.hasBagPills ? ctx.bagPills : null;
        return {
            kind: extra.kind || 'source-bounded-tactical', verified: true,
            verifiedOptimal: !!extra.verifiedOptimal,
            branchId: extra.branchId || `source-bounded-${node.serial}`,
            branchLabel: extra.branchLabel || (initialSlots === 4 ? '当前四槽起点' : `${initialSlots} 槽真实起手`),
            strategyLabel: extra.strategyLabel || (groups.some(group => group.kind === 'unlock')
                ? '源码规则 · 毁脉临时支点 + 置换窗口 + 尾脉回放'
                : (groups.some(group => group.mode === 'final-tail')
                    ? '源码规则 · 最近冲突脉回溯 + 第四紫尾脉扫描'
                    : '源码规则 · 三槽前推 + 最近冲突脉回溯 + 完整置换窗口')),
            slotPath: [initialSlots, ...groups.filter(group => group.kind === 'upgrade')
                .map(group => numeric(group.targetSlots, numeric(group.after?.zizhi, 154) - 150))]
                .filter((value, index, values) => index === 0 || value !== values[index - 1]),
            totalPills: node.cost, totalWashes: cumulativeWashes,
            totalTalentBars: cumulativeTalentBars,
            exchangeCount: groups.filter(group => group.kind === 'exchange').length,
            steps,
            finalTalents: stateTalentNames(ctx.engine, node.state, ctx.targetIds),
            finalState: {
                zizhi: numeric(node.state.zizhi, 154),
                seed: node.state.bornSeed,
                luck_seed: node.state.luckSeed,
                luck_seed_inited: node.state.luckSeed != null,
                born_talent_rc: numeric(node.state.bornRC),
                tal_lucky: node.state.talLucky,
                talents: stateTalentNames(ctx.engine, node.state, ctx.targetIds),
            },
            costBreakdown,
            inventory: {
                available,
                enough: available == null ? null : available >= node.cost,
                shortfall: available == null ? null : Math.max(0, node.cost - available),
                remaining: available == null ? null : available - node.cost,
            },
        };
    }

    // ===== 脉序评分扫描器（置换脉序经济学） =====
    // 事实：单洗丹耗 = 基础价 + 2×锁定数 − 1 → 长间隔段必须在低锁定数时穿越，
    // 短间隔脉对应收尾（高锁定）——即「取脉顺序决定总丹耗」。
    // 本扫描器在分层子集束上对每种「目标脉获取顺序」做确定性贪心评测（全部经引擎重放计费）：
    //   · 直接取：顺自然流扫到目标紫出现的洗点锁入（同一目标可解锁多个出现点变体）；
    //   · 置换取：锁同型前置蓝脉（工具脉）→ 等可置换紫 → 免费置换沿置换脉序追目标；
    //     首固化点（luckSeed 落定）时机由「候选工具脉首现即锁 + 少量延迟锁定」子扫近似覆盖。
    // 产物：完整上界解（注入 Stage A 首候选，使单调支配剪枝从第 1 秒生效）
    //   + 子集前缀成本表（orderPrefixBest，替换拍脑袋 missing×900 启发）。
    function scanVeinOrders(engine, startState, targetIds, options = {}) {
        const limits = Object.freeze({
            washBudget: Math.max(10000, Math.trunc(numeric(options.washBudget, 1200000))),
            beamWidth: Math.max(8, Math.trunc(numeric(options.beamWidth, 240))),
            keepPerSubset: Math.max(1, Math.trunc(numeric(options.keepPerSubset, 6))),
            maxDirectAppearances: Math.max(1, Math.trunc(numeric(options.maxDirectAppearances, 2))),
            maxToolQueues: Math.max(1, Math.trunc(numeric(options.maxToolQueues, 8))),
            maxChainDepth: Math.max(1, Math.trunc(numeric(options.maxChainDepth, 12))),
            maxLegWashes: Math.max(50, Math.trunc(numeric(options.maxLegWashes, 2600))),
        });
        const clone = root.WashSourceEngine.cloneState;
        const targets = targetIds.slice();
        const targetSet = new Set(targets);
        const maxPills = Math.max(1, numeric(options.maxTotalPills, 3000));
        const budget = { ops: limits.washBudget };
        let consumed = 0;
        let stateEvaluations = 0;
        let aborted = null;
        const byNumber = (left, right) => left - right;

        function actionsTrace(actions) {
            let trace = null;
            for (const action of actions) trace = traceAppend(trace, action);
            return trace;
        }

        function washActionOf(washed) {
            budget.ops -= 1;
            consumed += 1;
            return {
                kind: 'wash', mode: 'order-scan', keepIds: washed.keepIds, cost: washed.cost,
                draws: washed.draws, generatedBars: washed.generatedBars, after: washed.state,
            };
        }

        // 确定性连换：先判命中目标；未命中且新紫仍可被同型锁定蓝脉承接则续链；
        // 断链时仅在「继续锁工具脉还有意义」的语境里洗一槽重定位一次，否则弃用该机会。
        function trySwapChain(state, cost, actions, position, locksBefore, nextId) {
            let st = state;
            let total = cost;
            let act = actions;
            let locks = locksBefore.slice();
            for (let depth = 0; depth < limits.maxChainDepth; depth += 1) {
                let exchanged;
                try {
                    exchanged = engine.replace(st, position, locks);
                } catch (_) {
                    return null;
                }
                budget.ops -= 1;
                consumed += 1;
                const keptLocks = locks.filter(id => exchanged.state.talents.includes(id));
                act = traceAppend(act, {
                    kind: 'exchange', mode: 'order-scan', keepIds: keptLocks, cost: 0,
                    draws: exchanged.draws, generatedBars: 0,
                    removedId: exchanged.removedId, addedId: exchanged.addedId, after: exchanged.state,
                });
                st = exchanged.state;
                locks = keptLocks;
                if (exchanged.addedId === nextId) {
                    const finalLocks = idsInStateOrder(st, Array.from(new Set([...locks, nextId])));
                    if (finalLocks.length >= engine.slotCountFor(numeric(st.zizhi, 154))) return null;
                    return { state: st, cost: total, actions: act, locks: finalLocks };
                }
                let continuePosition = -1;
                if (engine.quality(exchanged.addedId) === 4) {
                    const addedPos = st.talents.indexOf(exchanged.addedId);
                    if (addedPos >= 0 && engine.replaceablePositions(st, locks).includes(addedPos)) {
                        continuePosition = addedPos;
                    }
                }
                if (continuePosition >= 0) {
                    position = continuePosition;
                    continue;
                }
                // 断链：目标紫仍留在盘上则改走直接锁收尾；否则本机会终止（后续屏仍会继续检查）
                if (st.talents.includes(nextId) && !locks.includes(nextId)) {
                    const finalLocks = idsInStateOrder(st, [...locks, nextId]);
                    if (finalLocks.length >= engine.slotCountFor(numeric(st.zizhi, 154))) return null;
                    return { state: st, cost: total, actions: act, locks: finalLocks };
                }
                return null;
            }
            return null;
        }

        function evalLeg(state, cost, actions, locks, nextId) {
            const primary = { state, cost, actions, locks: locks.slice(), tools: [], washed: 0 };
            if (locks.length === 1 && numeric(state.zizhi, 154) === 153 && engine.upgradeToFour) {
                const upgraded = engine.upgradeToFour(state);
                primary.state = upgraded;
                primary.actions = traceAppend(primary.actions, {
                    kind: 'upgrade', mode: 'open-fourth-slot', targetSlots: 4, keepIds: [],
                    cost: 0, draws: 0, generatedBars: 0, after: upgraded,
                });
            }
            const queues = [primary];
            const pendingTools = [];
            const spawnedTools = new Set();
            const directSpawns = new Map();
            const results = [];
            while (queues.length && !aborted) {
                const q = queues.shift();
                for (let wash = 0; wash < limits.maxLegWashes; wash += 1) {
                    if (budget.ops <= 0) { aborted = 'wash-budget'; break; }
                    if (q.cost > maxPills) break;
                    const keepNow = [...q.locks, ...q.tools];
                    if (keepNow.length >= engine.slotCountFor(numeric(q.state.zizhi, 154))) break;
                    if (q.state.talents.includes(nextId)) {
                        // 出现点处理：①直接锁收腿（主队列同一目标最多解锁 maxDirectAppearances 个变体）
                        const spawnCount = directSpawns.get(nextId) || 0;
                        if (!q.tools.length && spawnCount >= limits.maxDirectAppearances) break;
                        const finalLocks = idsInStateOrder(q.state, [...keepNow, nextId]);
                        if (!q.locks.includes(nextId)
                            && finalLocks.length < engine.slotCountFor(numeric(q.state.zizhi, 154))) {
                            if (!q.tools.length) directSpawns.set(nextId, spawnCount + 1);
                            results.push({
                                state: q.state, cost: q.cost, actions: q.actions,
                                locks: finalLocks, washed: q.washed,
                            });
                        }
                        if (q.tools.length) break;
                        // ②同屏可置换紫：先置换追目标（工具锁的意义所在）
                        const replaceable = engine.replaceablePositions(q.state, finalLocks);
                        for (const pp of replaceable) {
                            if (engine.quality(q.state.talents[pp]) !== 4) continue;
                            const swapped = trySwapChain(q.state, q.cost, q.actions, pp, finalLocks, nextId);
                            if (swapped) { results.push({ ...swapped, washed: q.washed }); }
                            break;
                        }
                        // ③不锁：继续扫更晚出现点/更晚固化点
                    } else {
                        // 无目标屏：带工具队列找置换机会；主队列播工具脉起线
                        if (q.tools.length) {
                            const replaceable = engine.replaceablePositions(q.state, keepNow);
                            for (const pp of replaceable) {
                                if (engine.quality(q.state.talents[pp]) !== 4) continue;
                                const swapped = trySwapChain(q.state, q.cost, q.actions, pp, keepNow, nextId);
                                if (swapped) results.push({ ...swapped, washed: q.washed });
                                break;
                            }
                            continue;
                        }
                        if (pendingTools.length + spawnedTools.size < limits.maxToolQueues) {
                            for (const id of q.state.talents) {
                                if (spawnedTools.has(id) || targetSet.has(id) || q.locks.includes(id)) continue;
                                if (engine.quality(id) === 4 || engine.isShenmai(id)) continue;
                                if (!engine.hasOrdinaryPurpleSuccessor(id)) continue;
                                if (q.locks.length + 1 >= engine.slotCountFor(numeric(q.state.zizhi, 154))) continue;
                                spawnedTools.add(id);
                                pendingTools.push({
                                    state: clone(q.state), cost: q.cost, actions: q.actions,
                                    locks: q.locks.slice(), tools: [id], washed: q.washed,
                                });
                                if (pendingTools.length + spawnedTools.size >= limits.maxToolQueues) break;
                            }
                        }
                    }
                    const washed = engine.wash(q.state, positionsForIds(q.state, keepNow));
                    q.actions = traceAppend(q.actions, washActionOf(washed));
                    q.state = washed.state;
                    q.cost += washed.cost;
                    q.washed += 1;
                }
                if (!aborted) queues.push(...pendingTools.splice(0));
            }
            stateEvaluations += 1;
            return results;
        }

        // 层间束搜索：第 k 层枚举「已持目标子集 S + 到达变体」，向每个未持目标扩展一条腿。
        // 每条腿结束后只保留目标紫脉入锁（工具蓝脉释放，否则会拖高后续单价）。
        // 同子集只保留最便宜的 keepPerSubset 个变体；每个子集的最小前缀成本进前缀表。
        const prefixKey = ids => [...ids].sort(byNumber).join(',');
        const prefixBest = new Map([[prefixKey([]), 0]]);
        const goalKey = prefixKey(targets);
        let layer = [{ state: clone(startState), cost: 0, actions: null, locks: [] }];
        const solutions = [];
        for (let depth = 0; depth < targets.length && !aborted; depth += 1) {
            const nextLayer = [];
            for (const item of layer) {
                if (budget.ops <= 0) { aborted = 'wash-budget'; break; }
                const heldSet = new Set(item.locks);
                for (const nextId of targets) {
                    if (heldSet.has(nextId)) continue;
                    const legs = evalLeg(item.state, item.cost, item.actions, item.locks, nextId);
                    for (const leg of legs) {
                        const targetLocks = leg.locks.filter(id => targetSet.has(id));
                        // 这条腿必须确实新增了下 nextId（允许同屏顺带多取）
                        if (!targetLocks.includes(nextId)) continue;
                        const key = prefixKey(targetLocks);
                        if (prefixBest.get(key) == null || leg.cost < prefixBest.get(key)) {
                            prefixBest.set(key, leg.cost);
                        }
                        if (key === goalKey) {
                            solutions.push({ cost: leg.cost, actions: leg.actions, state: leg.state, washed: leg.washed });
                            continue;
                        }
                        nextLayer.push({ ...leg, locks: targetLocks });
                    }
                }
            }
            if (!nextLayer.length) break;
            const groups = new Map();
            for (const item of nextLayer) {
                const bucket = groups.get(prefixKey(item.locks)) || [];
                bucket.push(item);
                groups.set(prefixKey(item.locks), bucket);
            }
            layer = [];
            for (const bucket of groups.values()) {
                bucket.sort((left, right) => left.cost - right.cost || left.washed - right.washed);
                layer.push(...bucket.slice(0, limits.keepPerSubset));
            }
            layer.sort((left, right) => left.cost - right.cost || left.washed - right.washed);
            if (layer.length > limits.beamWidth) layer.length = limits.beamWidth;
        }
        solutions.sort((left, right) => left.cost - right.cost
            || left.washed - right.washed
            || traceActions(left.actions).filter(a => a.kind === 'exchange').length
                - traceActions(right.actions).filter(a => a.kind === 'exchange').length);
        return {
            solutions,
            prefixBest,
            stats: { consumed, stateEvaluations, aborted },
        };
    }

    // ===== 新算法：luckSeed 穷举评分（Phase 0-3）=====
    // 核心洞察：luckSeed 固化时点决定整条置换脉序。搜索空间从事件序列组合爆炸坍缩为
    // 「luckSeed 候选集 × O(1) 评分」。首紫跳脉场景用卡格子/卡脉枚举（~48-64 候选），
    // 非首紫跳脉用 bornSeed@N 链式枚举（~2000 候选）。评分含死脉罚分（一心两用/单神脉）。

    function simulateNaturalSequence(engine, startState, maxWashes, maxPills) {
        const ZZ = root.WashSourceEngine.ZZ_RULES;
        const rule = ZZ[startState.zizhi] || ZZ[153];
        const slots = rule.slots;
        const pityThreshold = rule.pity;
        const clone = root.WashSourceEngine.cloneState;
        let state = clone(startState);
        let totalCost = 0;
        let totalDraws = 0;
        const states = [clone(state)];
        const bornSeedTrajectory = [state.bornSeed];
        const cumDrawsTrajectory = [0]; // cumDraws after each wash
        const firstAppearance = new Map();
        const allAppearances = new Map(); // id -> [wash1, wash2, ...]
        let firstPurpleWash = Infinity;
        let aborted = false;

        for (let w = 1; w <= maxWashes; w++) {
            const washed = engine.wash(state, []);
            state = washed.state;
            totalCost += washed.cost;
            totalDraws += washed.draws;
            states.push(clone(state));
            bornSeedTrajectory.push(state.bornSeed);
            cumDrawsTrajectory.push(totalDraws);
            for (const id of state.talents) {
                if (!firstAppearance.has(id)) firstAppearance.set(id, w);
                if (!allAppearances.has(id)) allAppearances.set(id, []);
                allAppearances.get(id).push(w);
            }
            if (firstPurpleWash === Infinity) {
                for (const id of state.talents) {
                    if (engine.quality(id) === 4) { firstPurpleWash = w; break; }
                }
            }
            if (totalCost > maxPills) { aborted = true; break; }
        }

        const talLuckyInit = numeric(startState.talLucky, 0);
        const wPity = Math.ceil((pityThreshold - talLuckyInit) / slots);
        const isPityFirst = firstPurpleWash > wPity;

        return {
            states, bornSeedTrajectory, cumDrawsTrajectory, firstAppearance, allAppearances, firstPurpleWash,
            wPity, isPityFirst, totalCost, totalDraws, aborted, slots, pityThreshold,
            baseCost: rule.baseCost,
        };
    }

    function enumeratePityCandidates(engine, startState, phase1, maxBlocks) {
        const { bornSeedTrajectory, wPity, slots } = phase1;
        const useRC = !!engine.useBornRC;
        const baseIdx = Math.max(0, Math.min(wPity - 1, bornSeedTrajectory.length - 1));
        const baseBorn = bornSeedTrajectory[baseIdx];
        let baseRC = numeric(startState.bornRC, 0);
        // 推进 baseIdx 洗的 draws 数以得到正确的 RC
        if (useRC) {
            // RC 在 phase1 模拟中已随 draws 递增；近似用 baseIdx * slots
            baseRC = numeric(startState.bornRC, 0) + baseIdx * slots;
        }
        const candidates = [];
        // 卡格子：最后一洗 draws = 1..slots
        let born = baseBorn, rc = baseRC;
        for (let extra = 1; extra <= slots + maxBlocks; extra++) {
            const drawn = engine.draw(born, false, useRC ? rc : 0);
            born = drawn[1];
            if (useRC) rc++;
            if (extra <= slots) {
                candidates.push({ seed: born, method: 'slotBlock', extraDraws: extra, blocks: 0, totalDraws: extra });
            } else {
                const blocks = extra - slots;
                for (let ed = 1; ed <= slots; ed++) {
                    // 卡脉 K 条 + 卡格子 ed draws → 总 extra = blocks + ed
                    // 但我们已经链式推进了 extra 次，需要分别记录
                }
                candidates.push({ seed: born, method: 'veinBlock', blocks: extra - slots, extraDraws: slots, totalDraws: extra });
            }
        }
        return candidates;
    }

    function enumerateExchangeChain(engine, startState, maxDraws) {
        const useRC = !!engine.useBornRC;
        let born = startState.bornSeed;
        let rc = numeric(startState.bornRC, 0);
        const candidates = [];
        for (let n = 1; n <= maxDraws; n++) {
            const drawn = engine.draw(born, false, useRC ? rc : 0);
            born = drawn[1];
            if (useRC) rc++;
            candidates.push({ seed: born, method: 'exchangeChain', totalDraws: n });
        }
        return candidates;
    }

    function scoreExchangeSequence(engine, luckSeed, targetIds, targetSet, seqLen, deadPenalty) {
        let luck = luckSeed;
        const purpleSeq = [];
        for (let i = 0; i < seqLen; i++) {
            const drawn = engine.draw(luck, true);
            purpleSeq.push(drawn[0]);
            luck = drawn[1];
        }
        // 死脉判定
        const shenmaiInTargets = targetIds.filter(id => engine.isShenmai(id)).length;
        const isDead = (id) => {
            if (targetSet.has(id)) return false;
            if (id === 251) return true; // 一心两用
            if (engine.isShenmai(id)) return shenmaiInTargets < 2;
            return false;
        };
        let score = 0;
        const targetPositions = new Map();
        for (const t of targetIds) {
            const pos = purpleSeq.indexOf(t);
            if (pos < 0) continue;
            targetPositions.set(t, pos);
            let deadBefore = 0;
            for (let i = 0; i < pos; i++) {
                if (isDead(purpleSeq[i])) deadBefore++;
            }
            const w = Math.max(0, (seqLen - pos - deadBefore * deadPenalty)) / seqLen;
            score += w;
        }
        return { score, purpleSeq, targetPositions };
    }

    function replayWithLuckSeed(engine, startState, candidate, phase1, targetIds, targetSet, maxPills) {
        const clone = root.WashSourceEngine.cloneState;
        const ZZ = root.WashSourceEngine.ZZ_RULES;
        const actions = [];
        let state = clone(startState);
        let cost = 0;
        let locked = [];
        const targetN = candidate.totalDraws || 0;
        const slots = phase1.slots;

        // --- 阶段 1：推进到固化点 ---
        if (candidate.method === 'exchangeChain') {
            // 非首紫跳脉：需要找到锁模式使 cumDraws = targetN 且 exchange 可触发
            const fixResult = findExchangeFixation(engine, startState, targetN, targetIds, targetSet, maxPills, phase1);
            if (!fixResult) return null;
            state = fixResult.state;
            cost = fixResult.cost;
            locked = fixResult.locked;
            actions.push(...fixResult.actions);
        } else {
            // 首紫跳脉：重放到 pity 触发点
            const pityResult = replayToPity(engine, startState, candidate, phase1, maxPills);
            if (!pityResult) return null;
            state = pityResult.state;
            cost = pityResult.cost;
            locked = pityResult.locked;
            actions.push(...pityResult.actions);
        }

        // 确认 luckSeed 已固化
        if (state.luckSeed == null) return null;

        // --- 阶段 2：升四槽（如果当前三槽且目标需要）---
        if (state.zizhi < 154 && targetIds.length >= 2) {
            const up = actionUpgrade(engine, state, 4);
            actions.push(up.action);
            state = up.state;
        }

        // --- 阶段 3：固化后贪心重放 ---
        const postResult = greedyPostFixation(engine, state, locked, targetIds, targetSet, maxPills - cost, actions, phase1);
        if (!postResult) return null;
        return { state: postResult.state, cost: cost + postResult.cost, actions };
    }

    function findExchangeFixation(engine, startState, targetN, targetIds, targetSet, maxPills, phase1) {
        const { allAppearances, cumDrawsTrajectory } = phase1;
        // 找出所有工具蓝（hasOrdinaryPurpleSuccessor）及其所有出现洗
        const toolBlues = [];
        for (const [id, washes] of allAppearances.entries()) {
            if (engine.quality(id) === 4) continue;
            if (engine.isShenmai(id)) continue;
            if (!engine.hasOrdinaryPurpleSuccessor(id)) continue;
            toolBlues.push({ id, washes });
        }
        if (!toolBlues.length) return null;

        const slots = phase1.slots;
        const drawsPerWash1Lock = Math.max(1.5, slots - 1);

        // 关键过滤：只保留同型紫在自然序列中实际出现过的工具蓝
        // （未出现的紫可能不在 born pool 中或极度稀有，等待它们会浪费大量时间）
        const purpleTypesSeen = new Set();
        for (const [id] of allAppearances.entries()) {
            if (engine.quality(id) === 4 && !engine.isShenmai(id)) {
                purpleTypesSeen.add(engine.talentType(id));
            }
        }
        const viableTools = toolBlues.filter(t => purpleTypesSeen.has(engine.talentType(t.id)));
        const searchTools = viableTools.length ? viableTools : toolBlues;

        // 策略：对每个工具蓝，筛选「可行」的出现洗（runway 足够找到同型紫）
        // minRunway 取小值以纳入「最晚锁工具蓝」的地面真相模式（如聂风 lockWash=176/runway=22）
        const minRunway = 8;
        const ranked = [];
        for (const tool of searchTools) {
            const feasible = [];
            for (const aw of tool.washes) {
                if (!cumDrawsTrajectory || aw >= cumDrawsTrajectory.length) continue;
                const cumAtAw = cumDrawsTrajectory[aw];
                if (cumAtAw >= targetN) continue;
                const runway = (targetN - cumAtAw) / drawsPerWash1Lock;
                if (runway < minRunway) continue;
                feasible.push({ aw, runway });
            }
            if (!feasible.length) continue;
            // 按 aw 降序（最晚优先 = 最低成本），取 top-6
            feasible.sort((a, b) => b.aw - a.aw);
            ranked.push({ id: tool.id, appearances: feasible.slice(0, 6), bestRunway: feasible[0].runway });
        }
        ranked.sort((a, b) => b.appearances.length - a.appearances.length || b.bestRunway - a.bestRunway);
        const toSearch = ranked.slice(0, 6);

        // 遍历所有 (工具蓝, 出现洗) 组合：返回「精确命中 targetN 且固化成本最低」者。
        // 不可在首个精确命中处 return——不同 lockWash 命中同一 N 的成本可差 ~11 丹（聂风 641 vs 652）。
        let bestExact = null;
        let bestNear = null;
        let bestDiff = Infinity;
        for (const tool of toSearch) {
            const type = engine.talentType(tool.id);
            for (const { aw } of tool.appearances) {
                const lockWash = aw + 1;
                const result = simulateToExchange(engine, startState, lockWash, tool.id, type, targetN, maxPills, targetIds, slots, cumDrawsTrajectory);
                if (!result) continue;
                if (result.cumDraws === targetN) {
                    if (!bestExact || result.cost < bestExact.cost) bestExact = result;
                } else {
                    const diff = Math.abs(result.cumDraws - targetN);
                    if (diff < bestDiff) { bestDiff = diff; bestNear = result; }
                }
            }
        }
        return bestExact || bestNear;
    }

    function simulateToExchange(engine, startState, lockWash, toolId, toolType, targetN, maxPills, targetIds, slots, cumDrawsTrajectory) {
        const clone = root.WashSourceEngine.cloneState;
        let state = clone(startState);
        let cost = 0, cumDraws = 0;
        const actions = [];
        let locked = [];
        // 动态 maxW：根据剩余 draws 需求和 1-lock/2-lock 阶段的 draws/wash 估算
        const cumAtLock = cumDrawsTrajectory ? cumDrawsTrajectory[Math.min(lockWash - 1, cumDrawsTrajectory.length - 1)] : (lockWash - 1) * slots;
        const remainingDraws = Math.max(0, targetN - cumAtLock);
        const drawsPerWash = Math.max(1, slots - 2); // 保守：2-lock 阶段 draws/wash
        const maxW = Math.min(lockWash + Math.max(80, Math.ceil(remainingDraws / drawsPerWash) + 40), 600);

        for (let w = 1; w <= maxW; w++) {
            if (cost > maxPills) return null;
            let keepIds = [];

            // 在 lockWash 时锁定工具蓝（必须当前槽位中存在）
            if (w === lockWash && state.talents.includes(toolId)) {
                locked = [toolId];
            }
            // 如果工具蓝不在槽位，无法锁定 → 失败
            if (w === lockWash && !state.talents.includes(toolId)) return null;

            if (locked.length) {
                keepIds = locked.filter(id => state.talents.includes(id));
                // 工具蓝已锁后，寻找同型紫（type === toolType 的紫脉）出现在槽位中
                if (keepIds.length === 1 && keepIds[0] === toolId) {
                    for (const id of state.talents) {
                        if (id === toolId) continue;
                        if (engine.quality(id) !== 4) continue;
                        if (engine.isShenmai(id)) continue;
                        if (engine.talentType(id) !== toolType) continue;
                        if (keepIds.length < slots - 1) {
                            keepIds.push(id);
                            locked.push(id);
                        }
                        break;
                    }
                }
            }

            const positions = positionsForIds(state, keepIds);
            const washed = engine.wash(state, positions);
            cumDraws += washed.draws;
            cost += washed.cost;
            state = washed.state;
            actions.push({ kind: 'wash', mode: 'luckseed-fixation', keepIds: washed.keepIds, cost: washed.cost, draws: washed.draws, generatedBars: washed.generatedBars, after: state });

            // 检查 exchange 是否可触发（需要 2 锁：工具蓝 + 同型紫）
            // 关键：必须等到 cumDraws == targetN 才执行 exchange，因为 luckSeed = bornSeed@cumDraws
            // 提前 exchange 会导致 luckSeed 偏移，置换序列完全不同
            if (locked.length >= 2) {
                const activeLocks = locked.filter(id => state.talents.includes(id));
                const replaceable = engine.replaceablePositions(state, activeLocks);
                if (replaceable.length > 0) {
                    if (cumDraws === targetN) {
                        // 精确命中：执行 exchange
                        const exResult = engine.replace(state, replaceable[0], activeLocks);
                        actions.push({ kind: 'exchange', mode: 'luckseed-fixation', keepIds: activeLocks.slice(), cost: 0, draws: exResult.draws, generatedBars: 0, removedId: exResult.removedId, addedId: exResult.addedId, after: exResult.state });
                        state = exResult.state;
                        locked = locked.filter(id => id !== exResult.removedId);
                        if (targetIds.includes(exResult.addedId)) locked.push(exResult.addedId);
                        return { state, cost, locked, actions, cumDraws };
                    }
                    if (cumDraws > targetN) {
                        // 超过目标：无法精确命中，失败
                        return null;
                    }
                    // cumDraws < targetN：继续洗脉推进 bornSeed，不执行 exchange
                }
            }
            // 早期终止：lockWash 之后 cumDraws 超过 targetN → 不可能精确命中
            if (w >= lockWash && cumDraws > targetN) return null;
        }
        return null;
    }

    function replayToPity(engine, startState, candidate, phase1, maxPills) {
        const clone = root.WashSourceEngine.cloneState;
        const { wPity, slots } = phase1;
        let state = clone(startState);
        let cost = 0;
        const actions = [];
        let locked = [];
        // 简化：以 0 锁推进到 pity 触发
        const maxW = wPity + 5;
        for (let w = 1; w <= maxW; w++) {
            if (cost > maxPills) return null;
            const keepIds = locked.filter(id => state.talents.includes(id));
            const positions = positionsForIds(state, keepIds);
            const washed = engine.wash(state, positions);
            cost += washed.cost;
            state = washed.state;
            actions.push({ kind: 'wash', mode: 'luckseed-pity', keepIds: washed.keepIds, cost: washed.cost, draws: washed.draws, generatedBars: washed.generatedBars, after: state });
            // pity 触发后 luckSeed 固化
            if (state.luckSeed != null) {
                return { state, cost, locked, actions };
            }
        }
        return state.luckSeed != null ? { state, cost, locked, actions } : null;
    }

    // 固化后「催化剂感知」贪心重放：luckSeed 已固化 ⇒ 置换结果序列 purpleSeq 完全确定。
    // 剩余目标分两类：(a) ∈ purpleSeq 且无自然出现 ⇒ 必须置换；(b) 其余 ⇒ 自然捕获。
    // 每次置换需要「已锁工具蓝 + 其同型紫催化剂」。关键在于选择哪种工具类型：
    // 前向模拟（仅锁已获得目标，born 链最快推进）预测每种 type 的催化剂出现洗，
    // 取成本最低者；并在「催化剂前最后一次同型工具蓝出现洗」才锁它（最少 2 锁慢洗）。
    // 这正是 2013 聂风路线的本质：exchange1(type170)→九阴鬼脉，exchange2 切到 type180(拳脚高手→拳脚无双)→转世金仙，岿然顶天自然。
    function greedyPostFixation(engine, state, initialLocked, targetIds, targetSet, budget, actions, phase1) {
        const clone = root.WashSourceEngine.cloneState;
        let current = clone(state);
        let cost = 0;
        const maxWashes = 400;
        const slotCount = engine.slotCountFor ? engine.slotCountFor(current.zizhi) : (current.zizhi - 150);
        const isToolBlue = id => engine.quality(id) !== 4 && !engine.isShenmai(id) && engine.hasOrdinaryPurpleSuccessor(id);
        const isOrdPurple = id => engine.quality(id) === 4 && !engine.isShenmai(id);

        // 已获得的目标（固化交换可能已产出其中之一）
        let held = targetIds.filter(id => current.talents.includes(id));
        // 自然可取的目标集合（Phase 1 自然序列中出现过）
        const naturalSet = new Set();
        if (phase1 && phase1.firstAppearance) {
            for (const id of targetIds) if (phase1.firstAppearance.has(id)) naturalSet.add(id);
        }
        // 固化后确定性置换序列（从当前 luckSeed 反复 draw(true)）
        const pseq = [];
        if (current.luckSeed != null) {
            let luck = current.luckSeed;
            for (let i = 0; i < 30; i++) { const drawn = engine.draw(luck, true); pseq.push(drawn[0]); luck = drawn[1]; }
        }
        const pset = new Set(pseq);

        let lockedTool = null; // {id, type} 当前已锁工具蓝
        let plan = null;       // {type, lockWash, lockId} 当前置换规划
        let pursuitWash = 0;   // 自本次规划起的洗数
        let lastHeldCount = held.length;

        // 前向模拟：仅锁 heldIds（born 链最快推进），为每种 type 记录催化剂首现洗 + 其前最后一次同型工具蓝出现洗
        function selectBestCatalystTool(startState, heldIds, horizon) {
            let sim = clone(startState);
            let simCost = 0;
            const lastToolWash = new Map(), lastToolId = new Map(), toolSeen = new Map(), cat = new Map();
            const scan = (w) => {
                for (const id of sim.talents) {
                    const t = engine.talentType(id);
                    if (isToolBlue(id)) { lastToolWash.set(t, w); lastToolId.set(t, id); toolSeen.set(t, true); }
                    else if (isOrdPurple(id) && toolSeen.has(t) && !cat.has(t)) {
                        cat.set(t, { type: t, catalystWash: w, lockWash: lastToolWash.get(t), lockId: lastToolId.get(t), cost: simCost });
                    }
                }
            };
            scan(0);
            for (let w = 1; w <= horizon && cat.size < 4; w++) {
                const keepIds = idsInStateOrder(sim, heldIds).slice(0, slotCount - 1);
                let washed;
                try { washed = engine.wash(sim, positionsForIds(sim, keepIds)); } catch (e) { break; }
                sim = washed.state; simCost += washed.cost;
                scan(w);
            }
            return [...cat.values()].sort((a, b) => a.cost - b.cost);
        }

        for (let w = 0; w < maxWashes; w++) {
            if (containsTargets(current, targetSet)) return { state: current, cost };
            if (cost >= budget) return null;
            const heldInSlots = held.filter(id => current.talents.includes(id));

            // 1) 催化剂就位 ⇒ 立即置换（推进 purpleSeq 取下一目标）
            const activeLocks = lockedTool && current.talents.includes(lockedTool.id)
                ? idsInStateOrder(current, [...heldInSlots, lockedTool.id]) : heldInSlots.slice();
            const replaceable = engine.replaceablePositions(current, activeLocks);
            if (replaceable.length > 0 && current.luckSeed != null) {
                const exResult = engine.replace(current, replaceable[0], activeLocks);
                actions.push({ kind: 'exchange', mode: 'luckseed-greedy', keepIds: activeLocks.slice(), cost: 0, draws: exResult.draws, generatedBars: 0, removedId: exResult.removedId, addedId: exResult.addedId, after: exResult.state });
                current = exResult.state;
                if (targetSet.has(exResult.addedId) && !held.includes(exResult.addedId)) held.push(exResult.addedId);
                lockedTool = null; plan = null; pursuitWash = 0; // 重新规划下一次置换
                continue;
            }

            // 2) 剩余目标分类：∈purpleSeq 且非自然 ⇒ 需置换
            const remaining = targetIds.filter(id => !held.includes(id));
            const needExchange = remaining.filter(id => pset.has(id) && !naturalSet.has(id));
            if (held.length !== lastHeldCount) { plan = null; lockedTool = null; pursuitWash = 0; lastHeldCount = held.length; }

            // 3) 规划工具类型 + 在最晚时机锁工具蓝
            let keepIds = heldInSlots.slice();
            if (needExchange.length) {
                if (!plan) {
                    const cands = selectBestCatalystTool(current, heldInSlots, 160);
                    if (cands.length) { plan = cands[0]; pursuitWash = 0; }
                }
                if (plan && !lockedTool && pursuitWash >= plan.lockWash) {
                    const tb = current.talents.find(id => isToolBlue(id) && engine.talentType(id) === plan.type);
                    if (tb) lockedTool = { id: tb, type: plan.type };
                }
                if (lockedTool && current.talents.includes(lockedTool.id) && !keepIds.includes(lockedTool.id)) keepIds.push(lockedTool.id);
            }

            // 4) 洗脉（保证 keepIds 均在槽位且留 ≥1 空槽）
            keepIds = idsInStateOrder(current, keepIds).slice(0, Math.max(0, slotCount - 1));
            let washed;
            try { washed = engine.wash(current, positionsForIds(current, keepIds)); } catch (e) { return null; }
            cost += washed.cost;
            current = washed.state;
            actions.push({ kind: 'wash', mode: 'luckseed-greedy', keepIds: washed.keepIds, cost: washed.cost, draws: washed.draws, generatedBars: washed.generatedBars, after: current });
            pursuitWash++;
            for (const id of targetIds) if (current.talents.includes(id) && !held.includes(id)) held.push(id);
        }
        return containsTargets(current, targetSet) ? { state: current, cost } : null;
    }

    // 预计算「置换机会」cumDraws 位置：自然序列中某型普通紫出现、且该型工具蓝已在更早 cumDraws 出现
    // ⇒ 此刻可锁工具蓝 + 该紫触发一次 exchange。排除目标紫（目标须自然保留，不可牺牲作催化剂）。
    // born 链位置与锁模式无关，故自然序列给出的机会位置对固化后同样适用（仅对应洗数不同）。
    function computeExchangeOpportunities(engine, phase1, targetSet) {
        const { allAppearances, cumDrawsTrajectory } = phase1;
        const traj = cumDrawsTrajectory || [];
        if (!traj.length) return [];
        const atCum = (w) => traj[Math.min(w, traj.length - 1)];
        const toolFirstCum = new Map();
        for (const [id, washes] of allAppearances.entries()) {
            if (engine.quality(id) === 4 || engine.isShenmai(id)) continue;
            if (!engine.hasOrdinaryPurpleSuccessor(id)) continue;
            const t = engine.talentType(id);
            const c = atCum(washes[0]);
            if (!toolFirstCum.has(t) || c < toolFirstCum.get(t)) toolFirstCum.set(t, c);
        }
        const opps = [];
        for (const [id, washes] of allAppearances.entries()) {
            if (engine.quality(id) !== 4 || engine.isShenmai(id)) continue;
            if (targetSet.has(id)) continue;
            const tb = toolFirstCum.get(engine.talentType(id));
            if (tb == null) continue;
            for (const w of washes) { const c = atCum(w); if (c > tb) opps.push(c); }
        }
        opps.sort((a, b) => a - b);
        return opps;
    }

    // 估算候选路线总丹耗（仅用于 Phase 3 排序）：固化成本 + 固化后「各次置换等催化剂 + 自然目标等 born 位置」的垫洗成本。
    // 三个关键项，缺一即会把实际失败/昂贵的候选误排到最前、耗尽 Phase 3 预算：
    //  (1) 固化后每次 exchange 必须等 born 链推进到下一个可用催化剂位置（主导成本）；
    //  (2) 到达 purpleSeq[pos] 需「pos 之前可产出项数」次 exchange（engine.replace 跳过 isAllowedAt=false/重复项），
    //      深层目标（如 pos19）需十余次 exchange + 十余个催化剂 ⇒ 成本爆炸；
    //  (3) 自然目标只有在其 born 位置 ≥ 固化点 N 时才可捕获（0 锁推进已越过更早的自然出现 ⇒ 丢失）。
    function estimateRouteCost(engine, candidate, targetIds, targetPositions, phase1, opportunities) {
        const N = candidate.totalDraws || 0;
        const traj = phase1.cumDrawsTrajectory || [];
        const base = phase1.baseCost || 3;
        const base4 = base + 2; // 四槽 baseCost
        const zizhi = 150 + (phase1.slots || 3);
        let fixWash = -1;
        for (let w = 0; w < traj.length; w++) { if (traj[w] >= N) { fixWash = w; break; } }
        if (fixWash < 0) return Infinity; // N 超出自然序列可达范围
        const fixCost = fixWash * base;
        const ps = candidate.purpleSeq || [];
        // 可产出前缀计数：allowedPrefix[k] = purpleSeq[0..k] 中 isAllowedAt 的项数（= 到达 k 所需 exchange 次数）
        const allowedPrefix = [];
        let ac = 0, fixIdx = -1;
        for (let i = 0; i < ps.length; i++) {
            const ok = typeof engine.isAllowedAt === 'function' ? engine.isAllowedAt(ps[i], zizhi) : true;
            if (ok) { ac++; if (fixIdx < 0) fixIdx = i; }
            allowedPrefix.push(ac);
        }
        if (fixIdx < 0) fixIdx = 0;
        const pos0 = ps[fixIdx]; // 固化 exchange 实际产出（首个可产出项）
        const fixAllowedCount = allowedPrefix[fixIdx] || 1;

        // 自然目标 born 位置 ≥ N 的最早 cumDraws（否则固化前已丢失）
        const natCumAt = (t) => {
            const appears = phase1.allAppearances && phase1.allAppearances.get(t);
            if (!appears) return null;
            let best = null;
            for (const w of appears) {
                const c = w < traj.length ? traj[w] : Infinity;
                if (c >= N && (best == null || c < best)) best = c;
            }
            return best;
        };

        let missed = 0;
        const exchangeTargets = [];
        for (const t of targetIds) {
            if (t === pos0) continue; // 固化 exchange 直接产出
            const nat = natCumAt(t);
            if (nat != null) continue; // 可自然捕获（更省），稍后计入等待
            const pos = targetPositions && targetPositions.get ? targetPositions.get(t) : undefined;
            if (pos != null && pos > fixIdx) exchangeTargets.push({ pos });
            else missed += 3000; // 既不可自然捕获、也不在置换序列有效位 → 不可得
        }
        exchangeTargets.sort((a, b) => a.pos - b.pos);

        let curCum = N;
        let waitDraws = 0;
        // 固化后逐次置换：每个目标消耗 (allowedPrefix[pos] - fixAllowedCount) 次催化剂机会
        for (const { pos } of exchangeTargets) {
            const exNeeded = Math.max(1, (allowedPrefix[pos] || 0) - fixAllowedCount);
            for (let e = 0; e < exNeeded; e++) {
                let opp = -1;
                for (const o of opportunities) { if (o >= curCum) { opp = o; break; } }
                if (opp < 0) { missed += 3000; break; }
                waitDraws += opp - curCum;
                curCum = opp + 1;
            }
        }
        // 自然目标：等到其 born 位置（cumDraws ≥ N）后捕获
        for (const t of targetIds) {
            if (t === pos0) continue;
            const nat = natCumAt(t);
            if (nat == null) continue; // 已在 exchangeTargets/missed 处理
            if (nat > curCum) { waitDraws += nat - curCum; curCum = nat; }
        }
        // 固化后 2 锁 4 槽：约 3 draws/洗、每洗 base4+3 丹
        const waitCost = Math.ceil(waitDraws / 3) * (base4 + 3);
        const wastePenalty = (pos0 != null && targetIds.includes(pos0)) ? 0 : 300;
        return fixCost + waitCost + missed + wastePenalty;
    }

    function analyzeAndScoreLuckSeeds(engine, startState, targetIds, options = {}) {
        const maxTotalPills = numeric(options.maxTotalPills, 3000);
        const maxWashCap = Math.trunc(numeric(options.maxWashCap, 600));
        const maxDraws = Math.trunc(numeric(options.maxDraws, 2000));
        const seqLen = Math.trunc(numeric(options.seqLen, 30));
        const topKCount = Math.trunc(numeric(options.topK, 150));
        const deadPenalty = numeric(options.deadPenalty, 3);
        const maxBlocks = Math.trunc(numeric(options.maxBlocks, 15));
        const targetSet = new Set(targetIds);
        const t0 = Date.now();
        const ZZ = root.WashSourceEngine.ZZ_RULES;
        const rule = ZZ[startState.zizhi] || ZZ[153];

        // Phase 0: 初态分情形
        const luckFixed = startState.luckSeed != null;
        const slots = rule.slots;
        const caseType = luckFixed ? (slots >= 4 ? 'A' : 'B') : (slots >= 4 ? 'C' : 'D');

        // Phase 1: 原始脉分析
        const phase1 = simulateNaturalSequence(engine, startState, maxWashCap, maxTotalPills);
        const naturalTargets = new Map();
        const exchangeNeeded = [];
        for (const id of targetIds) {
            const w = phase1.firstAppearance.get(id);
            if (w != null) naturalTargets.set(id, w);
            else exchangeNeeded.push(id);
        }
        // 可行性快判
        let lowerBound = 0;
        for (const [, w] of naturalTargets) lowerBound += w * rule.baseCost;
        lowerBound += exchangeNeeded.length * Math.ceil(rule.pity / slots) * rule.baseCost;
        const feasible = lowerBound <= maxTotalPills * 1.5; // 宽松判定

        const phase1Ms = Date.now() - t0;
        if (!feasible) {
            return { caseType, feasible, naturalTargets, exchangeNeeded, isPityFirst: phase1.isPityFirst, topK: [], bestRoute: null, stats: { phase1Ms, phase2Ms: 0, phase3Ms: 0, candidatesEvaluated: 0 } };
        }

        // 计算最小可行 N：第一个「有匹配工具蓝的非神脉紫」在自然序列中的 cumDraws × 0.7
        // 低于此值的候选无法在 runway 内找到同型紫，直接跳过
        let minFeasibleN = 0;
        {
            const toolBlueTypes = new Set();
            for (const [id] of phase1.allAppearances.entries()) {
                if (engine.quality(id) === 4 || engine.isShenmai(id)) continue;
                if (engine.hasOrdinaryPurpleSuccessor(id)) toolBlueTypes.add(engine.talentType(id));
            }
            let earliestViablePurpleWash = Infinity;
            for (const [id, washes] of phase1.allAppearances.entries()) {
                if (engine.quality(id) !== 4 || engine.isShenmai(id)) continue;
                if (!toolBlueTypes.has(engine.talentType(id))) continue;
                if (washes[0] < earliestViablePurpleWash) earliestViablePurpleWash = washes[0];
            }
            if (earliestViablePurpleWash < Infinity && phase1.cumDrawsTrajectory) {
                const idx = Math.min(earliestViablePurpleWash, phase1.cumDrawsTrajectory.length - 1);
                minFeasibleN = Math.floor(phase1.cumDrawsTrajectory[idx] * 0.7);
            }
        }

        // Phase 2: luckSeed 穷举 + 评分
        const t2 = Date.now();
        let candidates;
        if (luckFixed) {
            candidates = [{ seed: startState.luckSeed, method: 'fixed', totalDraws: 0 }];
        } else if (phase1.isPityFirst) {
            candidates = enumeratePityCandidates(engine, startState, phase1, maxBlocks);
        } else {
            candidates = enumerateExchangeChain(engine, startState, maxDraws);
        }
        const scored = [];
        for (const c of candidates) {
            const s = scoreExchangeSequence(engine, c.seed, targetIds, targetSet, seqLen, deadPenalty);
            if (s.score > 0) scored.push({ ...c, ...s });
        }
        scored.sort((a, b) => b.score - a.score);
        // 在 topK 截取前过滤不可行候选（N < minFeasibleN 的无法完成 fixation）
        const feasibleScored = minFeasibleN > 0
            ? scored.filter(c => c.method !== 'exchangeChain' || c.totalDraws >= minFeasibleN)
            : scored;
        // 成本感知重排：按估算总丹耗升序（同分则 score 降序），使便宜候选优先进入精算
        const opportunities = computeExchangeOpportunities(engine, phase1, targetSet);
        for (const c of feasibleScored) c.estCost = estimateRouteCost(engine, c, targetIds, c.targetPositions, phase1, opportunities);
        feasibleScored.sort((a, b) => (a.estCost - b.estCost) || (b.score - a.score));
        const topCandidates = feasibleScored.slice(0, topKCount);
        const phase2Ms = Date.now() - t2;

        // Phase 3: Top-K 精算（按估算成本升序；不在首个成功处 break，追踪全局最优）
        const t3 = Date.now();
        const phase3BudgetMs = Math.trunc(numeric(options.phase3BudgetMs, 15000));
        let bestRoute = null;
        let profilesRun = 0;
        for (const candidate of topCandidates) {
            if (Date.now() - t3 > phase3BudgetMs) break;
            if (candidate.estCost === Infinity) continue;
            profilesRun++;
            const route = replayWithLuckSeed(engine, startState, candidate, phase1, targetIds, targetSet, maxTotalPills);
            if (route && containsTargets(route.state, targetSet)) {
                if (!bestRoute || route.cost < bestRoute.cost) bestRoute = route;
            }
        }
        const phase3Ms = Date.now() - t3;

        return {
            caseType, feasible, naturalTargets, exchangeNeeded,
            isPityFirst: phase1.isPityFirst,
            topK: topCandidates,
            bestRoute,
            stats: { phase1Ms, phase2Ms, phase3Ms, candidatesEvaluated: scored.length, profilesRun, totalMs: Date.now() - t0 },
        };
    }

    async function searchWashRoutesFast(input) {
        if (!root.WashSourceEngine) throw new Error('源码洗脉状态机未加载');
        const talentData = input?.talentData || root.TALENT_DATA || {};
        const targetIds = Array.from(new Set((input?.targetIds || []).map(Number).filter(id => id > 0)));
        const targetSet = new Set(targetIds);
        const maxTotalPills = Math.max(0, Math.min(100000, Math.trunc(numeric(input?.options?.maxTotalPills, 3000))));
        const onProgress = typeof input?.onProgress === 'function' ? input.onProgress : () => {};
        const onCandidate = typeof input?.onCandidate === 'function' ? input.onCandidate : null;
        const shouldCancel = typeof input?.shouldCancel === 'function' ? input.shouldCancel : () => false;
        const yieldControl = typeof input?.yieldControl === 'function' ? input.yieldControl : sleepTurn;
        if (!targetIds.length || targetIds.length > 4) {
            return { strength: '输入无效', routes: [], noResultReason: '请选择 1–4 条目标紫脉。' };
        }

        const engine = new root.WashSourceEngine.Engine(talentData, input.initialState || {}, {
            dlcMode: !!input.dlcMode,
            eligibleTalentIds: input.eligibleTalentIds,
            saveChannel: input.initialState?.save_channel || '',
        });
        const unavailable = targetIds.filter(id => !engine.allowed.has(id));
        if (unavailable.length) {
            return { strength: '输入无效', routes: [], noResultReason: `当前人物或四脉资质不可用目标：${unavailable.map(id => engine.name(id)).join('、')}` };
        }

        const startState = engine.initialState(input.initialState || {});
        const initialSlotCount = Math.max(0, Math.min(4, numeric(startState.zizhi, numeric(input.initialState?.zizhi, 154)) - 150));
        const {
            maxEventNodes,
            maxMainRawWashes,
            maxTailRawWashes,
            maxEventDepth,
            estimatedTargetCost,
            maxFinalTailExchangeDepth,
            maxExchangePreviewDepth,
            maxSparseTargetGap,
            maxSparseRawDraws,
            deferredInterleaveEvery,
            maxLockTimingBranches,
            maxLockTimingSeekWashes,
        } = SEARCH_LIMITS;
        const scope = {
            algorithm: 'source-complete-window-destroy-tail-v025',
            implementationRevision: 'v0.2.5-complete-window-destroy',
            strategyGraph: '0–2 槽先升三槽、首条目标紫后开四槽、最近冲突脉反查、全部置换窗口保留、稀疏目标桥、毁脉临时支点、三四紫尾段独立预算',
            maxTotalPills,
            activePillCeiling: maxTotalPills,
            currentPillCost: 0,
            scanBound: 'max-total-pills',
            initialSlotCount,
            slotStagesChecked: initialSlotCount < 3
                ? [initialSlotCount, 3, 4]
                : (initialSlotCount === 3 ? [3, 4] : [4]),
            initialLuckSeedInited: startState.luckSeed != null,
            expandedNodes: 0,
            generatedNodes: 0,
            dominatedNodes: 0,
            prunedByPills: 0,
            prunedByCandidateDominance: 0,
            frontierPeak: 1,
            unlockedWashesScanned: 0,
            lockedWashesScanned: 0,
            conflictAnchors: 0,
            nearestBlockerCheckpoints: 0,
            nearestBlockerReplays: 0,
            olderBlockersDiscarded: 0,
            nearestBlockerPurpleTriggers: 0,
            infiniteExchangeStarts: 0,
            targetSacrificeBranches: 0,
            targetSwapSuccesses: 0,
            maxTargetsHeld: targetsIn(startState, targetSet).length,
            targetCoverage: {},
            firstExchangePadsChecked: 0,
            exchangeWindowsScanned: 0,
            exchangeWindowsExpanded: 0,
            exchangeWindowsDeferred: 0,
            exchangeWindowsSkipped: 0,
            exchangePreviewTargetHits: 0,
            sparseExchangeWindowsDetected: 0,
            sparseExchangeWindowsExpanded: 0,
            sparseExchangeBestGap: null,
            exchangeAttempts: 0,
            exchangeSuccesses: 0,
            externalExchangeChains: 0,
            deferredTargetSacrificeNodes: 0,
            deferredNodesExpanded: 0,
            deferredInterleaves: 0,
            destroyVeinBranches: 0,
            destroyVeinExpanded: 0,
            finalTailStarts: 0,
            thirdTailCandidates: 0,
            finalTailWashes: 0,
            finalTailExchangeBranches: 0,
            upgradeBranches: 0,
            candidateCount: 0,
            exchangeRetryBridges: 0,
            padWindowCycleCut: 0,
            lockTimingBranches: 0,
            lockTimingExpanded: 0,
            lockTimingSeekCuts: 0,
            lockTimingLimitReached: false,
            frontierLimit: 0,
            maxEventNodes,
            maxMainRawWashes,
            maxTailRawWashes,
            maxRawWashes: maxMainRawWashes + maxTailRawWashes,
            maxEventDepth,
            deferredInterleaveEvery,
            rawWashesSimulated: 0,
            mainRawWashesSimulated: 0,
            tailRawWashesSimulated: 0,
            prunedByFrontier: 0,
            heuristicWeight: 1.15,
            exhaustiveWithinStrategyGraph: false,
            safetyLimitReached: false,
            mainSafetyLimitReached: false,
            tailSafetyLimitReached: false,
            orderScanMs: 0,
            orderScanConsumed: 0,
            orderScanSolutions: 0,
            orderScanSubsets: 0,
            orderScanAborted: null,
            orderInjectedBound: null,
        };
        const ctx = {
            engine, targetIds, targetSet, initialState: input.initialState || {}, startState,
            hasBagPills: !!input.hasBagPills,
            bagPills: numeric(input.bagPills, numeric(input.initialState?.bag_pills)),
        };

        let serial = 0;
        let operations = 0;
        let lastProgressAt = 0;
        let mainNodesSinceDeferred = 0;
        // 单调支配剪枝：丹耗沿路线只增不减，任何成本已 ≥ 当前最优完整候选的
        // 节点不可能再产生更好结果，直接剪掉。没有这条剪枝时劣质分支会
        // 一路膨胀到预算上限，把主链（如 2013 起线）排到队列末尾很晚才展开。
        let bestCandidateCost = Infinity;
        const modePriority = Object.freeze({ milestone: 0, pad: 1, seek: 2, baseline: 3 });
        const priorityOf = node => {
            const held = targetsIn(node.state, targetSet).length;
            const missing = Math.max(0, targetIds.length - held);
            const tailBonus = targetIds.length >= 3 && held >= targetIds.length - 1 ? 3600 : 0;
            const firstPurpleBonus = held === 1 ? 900 : 0;
            const threeSlotBonus = numeric(node.state.zizhi, 154) === 153 && held === 0 ? 260 : 0;
            const remainingCost = missing * estimatedTargetCost;
            return node.cost + remainingCost * scope.heuristicWeight
                - held * 520 - tailBonus - firstPurpleBonus - threeSlotBonus
                - numeric(node.importance, 0) + numeric(node.eventDepth, 0) * 3;
        };
        const costCompare = (left, right) => priorityOf(left) - priorityOf(right)
            || left.cost - right.cost
            || numeric(modePriority[left.mode], 9) - numeric(modePriority[right.mode], 9)
            || left.serial - right.serial;
        const queue = new MinHeap(costCompare);
        const deferredQueue = new MinHeap(costCompare);
        const distance = new Map();
        const candidateNodes = new Map();
        let bestReportedCost = Infinity;

        function slotCountOf(state) {
            if (typeof engine.slotCountFor === 'function') return engine.slotCountFor(numeric(state.zizhi, 154));
            return Math.max(1, Math.min(4, (state.talents || []).length || initialSlotCount || 4));
        }

        function candidateSignature(node) {
            const groups = compactActions(traceActions(node.trace));
            const route = groups.map(group => group.kind === 'wash'
                ? `w:${group.mode}:${group.keepIds.join('.')}:${group.count}`
                : (group.kind === 'exchange'
                    ? `x:${group.removedId}>${group.addedId}:${group.keepIds.join('.')}`
                    : (group.kind === 'unlock'
                        ? `r:${(group.releasedIds || []).join('.')}`
                        : 'u:4'))).join('|');
            return `${root.WashSourceEngine.stateKey(node.state)}|${route}`;
        }

        function recordCandidate(node) {
            const signature = candidateSignature(node);
            const previous = candidateNodes.get(signature);
            if (!previous || node.cost < previous.cost) candidateNodes.set(signature, node);
            scope.candidateCount = candidateNodes.size;
            if (node.cost < bestCandidateCost) bestCandidateCost = node.cost;
            // 增量上报：每当新的全局最低成本候选诞生，立即回传当前 Top 候选。
            // UI 可在主链完成时（远早于整体搜索结束）展示/提前停止。
            if (onCandidate && node.cost < bestReportedCost) {
                bestReportedCost = node.cost;
                try {
                    onCandidate(buildResult());
                } catch (_) { /* 上报失败不影响搜索 */ }
            }
        }

        function report(message, force = false) {
            const now = Date.now();
            if (!force && now - lastProgressAt < 120) return;
            lastProgressAt = now;
            onProgress({
                phase: 'bounded-search',
                done: scope.expandedNodes,
                total: Math.max(1, scope.expandedNodes + queue.size + deferredQueue.size),
                expandedNodes: scope.expandedNodes,
                generatedNodes: scope.generatedNodes,
                rawWashesSimulated: scope.rawWashesSimulated,
                currentPillCost: scope.currentPillCost,
                activePillCeiling: maxTotalPills,
                maxTotalPills,
                candidateCount: scope.candidateCount,
                message,
            });
        }

        function nodeKey(state, mode, meta) {
            const protectedIds = (meta.protectedIds || []).slice();
            const carryLockedIds = (meta.carryLockedIds || []).slice();
            return [
                mode,
                protectedIds.join(','),
                carryLockedIds.join(','),
                meta.anchorKind || '-',
                meta.washedAfterAnchor ? 1 : 0,
                numeric(meta.anchorId, 0),
                numeric(meta.conflictId, 0),
                numeric(meta.destroyPivotId, 0),
                meta.deferred ? 'D' : 'P',
                root.WashSourceEngine.stateKey(state),
            ].join('|');
        }

        function enqueue(state, cost, trace, mode = 'milestone', meta = {}) {
            if (cost > maxTotalPills) {
                scope.prunedByPills += 1;
                return false;
            }
            // 单调支配：成本已不优于当前最佳完整候选的节点不再展开（含 0 成本置换/升槽边）。
            if (cost >= bestCandidateCost) {
                scope.prunedByCandidateDominance += 1;
                return false;
            }
            const eventDepth = numeric(meta.eventDepth, 0);
            if (eventDepth > maxEventDepth) {
                scope.safetyLimitReached = true;
                return false;
            }
            const protectedIds = idsInStateOrder(state, meta.protectedIds || []);
            const carryLockedIds = idsInStateOrder(state, meta.carryLockedIds || []);
            const normalizedMeta = { ...meta, protectedIds, carryLockedIds, eventDepth };
            const key = nodeKey(state, mode, normalizedMeta);
            const node = {
                state, cost, trace, serial: ++serial, key, mode,
                ...normalizedMeta,
                importance: numeric(meta.importance, 0),
            };
            const heldTargets = targetsIn(state, targetSet).slice().sort((a, b) => a - b);
            scope.maxTargetsHeld = Math.max(scope.maxTargetsHeld, heldTargets.length);
            const coverageKey = heldTargets.join(',') || '-';
            const coverageCost = scope.targetCoverage[coverageKey];
            if (coverageCost == null || cost < coverageCost) scope.targetCoverage[coverageKey] = cost;

            // 完整候选先按「路线签名」收集，再做状态支配。
            // 这样不同操作序列即使抵达同一最终状态，也不会因为 distance 先命中而被静默吞掉。
            if (containsTargets(state, targetSet)) {
                scope.generatedNodes += 1;
                recordCandidate(node);
                report(`已记录 ${scope.candidateCount.toLocaleString()} 条完整候选，继续遍历其他分支`, true);
                return true;
            }

            const previous = distance.get(key);
            if (previous != null && previous <= cost) {
                scope.dominatedNodes += 1;
                return false;
            }
            distance.set(key, cost);
            scope.generatedNodes += 1;
            const destination = normalizedMeta.deferred ? deferredQueue : queue;
            destination.push(node);
            scope.frontierPeak = Math.max(scope.frontierPeak, queue.size + deferredQueue.size);
            if (normalizedMeta.deferred) scope.deferredTargetSacrificeNodes += 1;
            return true;
        }

        function noteWash(kind = 'main') {
            scope.rawWashesSimulated += 1;
            if (kind === 'tail') scope.tailRawWashesSimulated += 1;
            else scope.mainRawWashesSimulated += 1;
        }

        function mainWashBudgetAvailable() {
            return scope.mainRawWashesSimulated < maxMainRawWashes;
        }

        function tailWashBudgetAvailable() {
            return scope.tailRawWashesSimulated < maxTailRawWashes;
        }

        async function checkpoint(message, kind = 'main') {
            operations += 1;
            if (shouldCancel()) throw new Error('SEARCH_CANCELLED');
            if (kind === 'tail') {
                if (!tailWashBudgetAvailable()) {
                    scope.tailSafetyLimitReached = true;
                    scope.safetyLimitReached = true;
                    return false;
                }
            } else if (!mainWashBudgetAvailable()) {
                scope.mainSafetyLimitReached = true;
                scope.safetyLimitReached = true;
                throw new Error('SEARCH_MAIN_SAFETY_LIMIT');
            }
            if (operations % 256 === 0) {
                report(message);
                await yieldControl();
            }
            return true;
        }

        function canWash(state, lockedIds) {
            return idsInStateOrder(state, lockedIds).length < slotCountOf(state);
        }

        function canContinueAt(cost) {
            return cost <= maxTotalPills && cost < bestCandidateCost;
        }

        function targetGainImportance(state, previousCount, extra = 0) {
            const gain = Math.max(0, targetsIn(state, targetSet).length - previousCount);
            return gain * 2400 + extra;
        }

        function previewSparseLuckTargets(state) {
            const missing = targetIds.filter(id => !state.talents.includes(id));
            if (!missing.length || typeof engine.draw !== 'function') {
                return { hit: false, nearestGap: null, targetIds: [], rawDraws: 0 };
            }
            const missingSet = new Set(missing);
            const occupied = new Set(state.talents || []);
            let luck = state.luckSeed == null ? state.bornSeed : state.luckSeed;
            let rawDraws = 0;
            let visibleGap = 0;
            const hits = [];
            const seenTargets = new Set();

            // 这里只用于优先级/保留判断，不直接生成路线。
            // 按当前状态近似预览未来 Luck 紫序：允许非目标紫夹在目标之间。
            // 真正能否跨过中间紫，仍由后续真实 wash + replace() 状态机验证。
            while (rawDraws < maxSparseRawDraws && visibleGap < maxSparseTargetGap) {
                let candidate;
                [candidate, luck] = engine.draw(luck, true);
                rawDraws += 1;
                if (typeof engine.isAllowedAt === 'function' && !engine.isAllowedAt(candidate, state.zizhi)) continue;
                // 当前已占用同名紫在真实 replace() 中会被内部跳过，不计入“可见置换脉序”距离。
                if (occupied.has(candidate)) continue;
                visibleGap += 1;
                if (missingSet.has(candidate) && !seenTargets.has(candidate)) {
                    seenTargets.add(candidate);
                    hits.push({ id: candidate, gap: visibleGap, rawDraws });
                }
            }
            const nearest = hits.reduce((best, item) => !best || item.gap < best.gap ? item : best, null);
            return {
                hit: !!nearest,
                nearestGap: nearest ? nearest.gap : null,
                targetIds: hits.map(item => item.id),
                hits,
                rawDraws,
            };
        }

        function previewExchangeChainForTarget(state, lockedIds, depth = maxExchangePreviewDepth, visited = new Set()) {
            if (depth <= 0) return false;
            const orderedLocks = idsInStateOrder(state, lockedIds || []);
            const visitKey = `${root.WashSourceEngine.stateKey(state)}|${orderedLocks.join(',')}|${depth}`;
            if (visited.has(visitKey)) return false;
            visited.add(visitKey);
            const positions = engine.replaceablePositions(state, orderedLocks);
            for (const position of positions) {
                const removedId = state.talents[position];
                let exchanged;
                try {
                    exchanged = actionReplace(engine, state, position, 'preview-exchange', orderedLocks);
                } catch (_) {
                    continue;
                }
                if (targetSet.has(exchanged.action.addedId)) return true;
                const nextLocks = orderedLocks.filter(id => id !== removedId && exchanged.state.talents.includes(id));
                if (previewExchangeChainForTarget(exchanged.state, nextLocks, depth - 1, visited)) return true;
            }
            return false;
        }

        function classifyExchangeWindow(beforeState, exchanged, lockedIds) {
            const beforeTargetCount = targetsIn(beforeState, targetSet).length;
            const afterTargetCount = targetsIn(exchanged.state, targetSet).length;
            const addedTarget = targetSet.has(exchanged.action.addedId);
            const removedTarget = targetSet.has(exchanged.action.removedId);
            const nextLocks = idsInStateOrder(exchanged.state,
                (lockedIds || []).filter(id => id !== exchanged.action.removedId));
            const chainCanReachTarget = previewExchangeChainForTarget(exchanged.state, nextLocks);
            if (chainCanReachTarget) scope.exchangePreviewTargetHits += 1;

            // v0.2.4：目标紫在 Luck/置换脉序中不要求相邻。
            // 例如「混元 → 不灭 → 神力 → 拳脚 → 顶天」：中间三紫没有即时目标收益，
            // 但只要固定 Luck 序列在近距离仍存在缺失目标，就不能把这些中继状态一律降级成垃圾分支。
            const sparse = previewSparseLuckTargets(exchanged.state);
            const immediateProductive = addedTarget || afterTargetCount > beforeTargetCount || chainCanReachTarget;
            const sparseProductive = !immediateProductive && sparse.hit;
            // 固化落点：首次置换（置换完成或洗脉触发保底）会把 luckSeed 钉死。
            // 固化前，垫洗推进 bornSeed 就能整体平移未来全部置换脉序；固化后，
            // 普通垫洗对置换结果失效，唯一免费杠杆是提交未命中置换自身推进 luckSeed。
            // 因此固化窗口命中目标时，若剩余缺失目标离固化落点更近，应获得排序加成。
            const finalizing = beforeState.luckSeed == null;
            // 提交未命中重试桥：固化后的未命中置换也值得提交——只要同型前置冲突脉
            // 仍被锁住可重新寻紫，这条重试链就值得留在主队列。
            const blockerRetained = nextLocks.length > 0
                && typeof engine.hasOrdinaryPurpleSuccessor === 'function'
                && nextLocks.some(id => engine.hasOrdinaryPurpleSuccessor(id));
            const retryBridge = !addedTarget && exchanged.state.luckSeed != null && blockerRetained && sparse.hit;
            if (retryBridge) scope.exchangeRetryBridges += 1;
            if (sparseProductive) {
                scope.sparseExchangeWindowsDetected += 1;
                if (scope.sparseExchangeBestGap == null || sparse.nearestGap < scope.sparseExchangeBestGap) {
                    scope.sparseExchangeBestGap = sparse.nearestGap;
                }
            }
            return {
                addedTarget,
                removedTarget,
                afterTargetCount,
                productive: immediateProductive || sparseProductive,
                immediateProductive,
                sparseProductive,
                retryBridge,
                finalizing,
                nearestMissingGap: sparse.nearestGap,
                sparseTargetGap: sparse.nearestGap,
                sparseTargetIds: sparse.targetIds,
                chainCanReachTarget,
                nextLocks,
            };
        }

        // 固化落点加成：把「置换后剩余目标在 luck 脉序中很快出现」的窗口排到更前，
        // 等价于让搜索优先选择「一次固化能顺带服务后续置换」的垫洗位置（联合窗口）。
        function landingBonusOf(window) {
            if (!window.finalizing || !window.addedTarget) return 0;
            const gap = numeric(window.nearestMissingGap, maxSparseTargetGap);
            return Math.max(0, 700 - 100 * (gap - 1));
        }

        function directExchangeBranches(state, cost, trace, lockedIds, meta = {}) {
            const orderedLocks = idsInStateOrder(state, lockedIds || []);
            const positions = engine.replaceablePositions(state, orderedLocks);
            if (!positions.length) return 0;
            let generated = 0;
            for (const position of positions) {
                scope.exchangeAttempts += 1;
                const exchanged = actionReplace(engine, state, position, 'direct-exchange', orderedLocks);
                scope.exchangeSuccesses += 1;
                const window = classifyExchangeWindow(state, exchanged, orderedLocks);
                if (window.removedTarget) scope.targetSacrificeBranches += 1;
                if (window.removedTarget && window.addedTarget) scope.targetSwapSuccesses += 1;
                if (meta.fromExchange) scope.externalExchangeChains += 1;

                // v0.2.3：先处理能直接取得目标、或当前置换链继续可达目标的窗口。
                // 仅改变 TalLucky / Luck 而暂时没有目标价值的置换不删除，而是放进延后队列，
                // 避免它们在低成本主线尚未跑完前吃掉全局 wash 安全预算。
                // 例外：重试桥（luckSeed 固化后唯一有效的免费杠杆）不延后。
                const deferred = !window.productive && !window.retryBridge;
                const sparseBonus = window.sparseProductive
                    ? Math.max(650, 2300 - numeric(window.sparseTargetGap, maxSparseTargetGap) * 210)
                    : 0;
                if (window.sparseProductive) scope.sparseExchangeWindowsExpanded += 1;
                enqueue(exchanged.state, cost, traceAppend(trace, exchanged.action), 'milestone', {
                    eventDepth: numeric(meta.eventDepth, 0) + 1,
                    importance: window.addedTarget ? 3200 + landingBonusOf(window)
                        : (window.immediateProductive ? 2300
                            : (window.retryBridge ? Math.max(1500, sparseBonus) : (window.sparseProductive ? sparseBonus : 180))),
                    carryLockedIds: window.nextLocks,
                    fromExchange: true,
                    deferred,
                    sparseBridgeTargetIds: window.sparseTargetIds,
                    sparseBridgeGap: window.sparseTargetGap,
                });
                generated += 1;
            }
            return generated;
        }

        function seekOpportunity(state, node, washedAfterAnchor) {
            if (!state.talents.includes(node.anchorId)
                || node.protectedIds.some(id => !state.talents.includes(id))) return null;
            const anchorPosition = state.talents.indexOf(node.anchorId);
            const lockedIds = idsInStateOrder(state, [...node.protectedIds, node.anchorId]);
            if (lockedIds.length >= slotCountOf(state)) return null;
            const replaceable = engine.replaceablePositions(state, lockedIds);
            let sourcePosition = -1;
            let conflictId = null;
            if (node.anchorKind === 'ordinary' && washedAfterAnchor) {
                sourcePosition = replaceable.find(position => position > anchorPosition
                    && engine.quality(state.talents[position]) === 4
                    && !engine.isShenmai(state.talents[position])
                    && engine.talentType(state.talents[position]) === engine.talentType(node.anchorId)) ?? -1;
                conflictId = node.anchorId;
            } else if (node.anchorKind === 'shenmai' && replaceable.includes(anchorPosition)) {
                sourcePosition = anchorPosition;
                conflictId = state.talents.find((id, index) => index !== anchorPosition && engine.isShenmai(id));
            }
            return { lockedIds, sourcePosition, conflictId };
        }

        function enqueuePadOpportunity(state, cost, trace, node, washedAfterAnchor, importance = 420) {
            const opportunity = seekOpportunity(state, node, washedAfterAnchor);
            if (!opportunity || opportunity.sourcePosition < 0) return false;
            const sourceId = state.talents[opportunity.sourcePosition];
            scope.conflictAnchors += 1;
            if (node.protectedIds.length === 1) scope.infiniteExchangeStarts += 1;
            if (targetSet.has(sourceId)) scope.targetSacrificeBranches += 1;
            enqueue(state, cost, trace, 'pad', {
                protectedIds: node.protectedIds,
                anchorId: sourceId,
                conflictId: opportunity.conflictId,
                anchorKind: node.anchorKind,
                eventDepth: node.eventDepth,
                importance: importance + (targetSet.has(sourceId) ? 1100 : 0),
            });
            return true;
        }

        function generatedPurpleIds(state, keepIds) {
            const kept = new Set((keepIds || []).map(Number));
            return state.talents.filter(id => !kept.has(id) && engine.quality(id) === 4);
        }

        // 锁定时机扫描：固化前「在哪一洗锁定前置蓝脉」会整体平移后续全部脉序，
        // 贪心首停（只在最近 blocker 反查点或首现点锁定）会漏掉更优时机。
        // 因此对每个出现可承接同型紫 blocker 脉的洗点，都开一条「从该洗点锁定并前推」的
        // seek 线；后续同类紫出现 → pad 垫洗窗口扫描的结构由 seek/pad 模式原样承接。
        // 仅在 0–1 锁的寻脉线启用（覆盖：不锁起锁、首紫后锁第二条工具脉），
        // 并用全局分支上限防止横向爆炸。
        // 锁定时机改由 Phase 3（analyzeAndScoreLuckSeeds）确定性重放决定并注入 UB，
        // 此处不再用 importance 引导 A* 排序（旧模块 3 的锁定时机 importance 启发已按方案删除，回退到常量 800）。
        function enqueueLockTimingBranches(state, cost, trace, node, keepIds) {
            if (typeof engine.hasOrdinaryPurpleSuccessor !== 'function') return 0;
            const orderedProtected = idsInStateOrder(state, node.protectedIds || []);
            if (orderedProtected.length > 1) return 0;
            if (orderedProtected.length + 1 >= slotCountOf(state)) return 0;
            const kept = new Set((keepIds || []).map(Number));
            let generated = 0;
            for (const id of state.talents) {
                if (kept.has(id) || orderedProtected.includes(id)) continue;
                if (engine.quality(id) === 4 || engine.isShenmai(id)) continue;
                if (!engine.hasOrdinaryPurpleSuccessor(id)) continue;
                if (scope.lockTimingBranches >= maxLockTimingBranches) {
                    scope.lockTimingLimitReached = true;
                    break;
                }
                scope.lockTimingBranches += 1;
                const enqueued = enqueue(state, cost, trace, 'seek', {
                    protectedIds: orderedProtected,
                    anchorId: id,
                    anchorKind: 'ordinary',
                    washedAfterAnchor: false,
                    eventDepth: node.eventDepth,
                    importance: 800,
                    lockTiming: true,
                });
                if (enqueued) {
                    scope.lockTimingExpanded += 1;
                    generated += 1;
                }
            }
            return generated;
        }

        function rememberNearestBlockers(nearestByType, state, cost, trace, protectedIds, scanStep) {
            const orderedProtected = idsInStateOrder(state, protectedIds || []);
            if (orderedProtected.length + 1 >= slotCountOf(state)) return;
            const byType = new Map();
            for (const anchorId of state.talents) {
                if (orderedProtected.includes(anchorId)) continue;
                if (!engine.hasOrdinaryPurpleSuccessor(anchorId)) continue;
                const type = engine.talentType(anchorId);
                if (!byType.has(type)) byType.set(type, []);
                byType.get(type).push(anchorId);
            }
            for (const [type, anchorIds] of byType.entries()) {
                const previous = nearestByType.get(type);
                if (previous && previous.scanStep < scanStep) {
                    scope.olderBlockersDiscarded += previous.anchors.length;
                }
                nearestByType.set(type, {
                    scanStep,
                    anchors: anchorIds.map(anchorId => ({
                        state: root.WashSourceEngine.cloneState(state),
                        cost,
                        trace,
                        protectedIds: orderedProtected.slice(),
                        anchorId,
                    })),
                });
                scope.nearestBlockerCheckpoints += anchorIds.length;
            }
        }

        function enqueueNearestBlockerReplays(nearestByType, generatedPurples, scanStep, eventDepth) {
            let generated = 0;
            for (const purpleId of generatedPurples) {
                if (engine.isShenmai(purpleId)) continue;
                const nearest = nearestByType.get(engine.talentType(purpleId));
                if (!nearest || nearest.scanStep >= scanStep) continue;
                scope.nearestBlockerPurpleTriggers += 1;
                const gap = Math.max(1, scanStep - nearest.scanStep);
                for (const checkpoint of nearest.anchors) {
                    const enqueued = enqueue(checkpoint.state, checkpoint.cost, checkpoint.trace, 'seek', {
                        protectedIds: checkpoint.protectedIds,
                        anchorId: checkpoint.anchorId,
                        anchorKind: 'ordinary',
                        washedAfterAnchor: false,
                        eventDepth,
                        importance: 900 + (targetSet.has(purpleId) ? 900 : 0) + Math.max(0, 240 - gap * 12),
                        triggerPurpleId: purpleId,
                        triggerGap: gap,
                    });
                    if (enqueued) {
                        scope.nearestBlockerReplays += 1;
                        generated += 1;
                    }
                }
            }
            return generated;
        }

        function enqueueFinalTailExchangeBranches(state, cost, trace, lockedTargetIds, node) {
            const orderedLocks = idsInStateOrder(state, lockedTargetIds || []);
            const lockedSet = new Set(orderedLocks);
            const positions = engine.replaceablePositions(state, orderedLocks)
                // 尾脉专用分支固定保留前三紫；只允许置换第四个活动槽。
                .filter(position => !lockedSet.has(state.talents[position]));
            if (!positions.length) return 0;
            let generated = 0;
            for (const position of positions) {
                if (numeric(node.eventDepth, 0) >= maxFinalTailExchangeDepth) {
                    scope.safetyLimitReached = true;
                    break;
                }
                scope.exchangeAttempts += 1;
                scope.finalTailExchangeBranches += 1;
                const exchanged = actionReplace(engine, state, position, 'final-tail-exchange', orderedLocks);
                scope.exchangeSuccesses += 1;
                const nextTrace = traceAppend(trace, exchanged.action);
                enqueue(exchanged.state, cost, nextTrace, 'milestone', {
                    eventDepth: numeric(node.eventDepth, 0) + 1,
                    importance: targetSet.has(exchanged.action.addedId) ? 5200 : 3600,
                    carryLockedIds: orderedLocks,
                    fromExchange: true,
                    finalTailOrigin: true,
                });
                generated += 1;
            }
            return generated;
        }

        async function processFinalTail(node) {
            scope.finalTailStarts += 1;
            let state = node.state;
            let cost = node.cost;
            let trace = node.trace;
            let lockedTargets = idsInStateOrder(state, targetsIn(state, targetSet));

            // 三槽已经锁满三条目标时，第四紫必然先开第四槽；开槽本身不推进 RNG。
            if (slotCountOf(state) < 4) {
                const upgraded = actionUpgrade(engine, state);
                scope.upgradeBranches += 1;
                trace = traceAppend(trace, upgraded.action);
                state = upgraded.state;
                lockedTargets = idsInStateOrder(state, lockedTargets);
            }

            // 当前活动槽如果已经形成天然神脉冲突，先把「置换 / 不置换」都保留下来。
            enqueueFinalTailExchangeBranches(state, cost, trace, lockedTargets, node);

            while (true) {
                if (!canWash(state, lockedTargets)) break;
                if (!tailWashBudgetAvailable()) {
                    scope.tailSafetyLimitReached = true;
                    scope.safetyLimitReached = true;
                    break;
                }
                const next = actionWash(engine, state, lockedTargets, 'final-tail');
                if (!canContinueAt(cost + next.action.cost)) {
                    scope.prunedByPills += 1;
                    break;
                }
                cost += next.action.cost;
                noteWash('tail');
                scope.finalTailWashes += 1;
                scope.lockedWashesScanned += 1;
                trace = traceAppend(trace, next.action);
                state = next.state;

                if (containsTargets(state, targetSet)) {
                    enqueue(state, cost, trace, 'milestone', {
                        eventDepth: numeric(node.eventDepth, 0) + 1,
                        importance: 6200,
                        carryLockedIds: lockedTargets,
                        finalTailOrigin: true,
                    });
                    // 同一条「前三紫固定、完全不置换」直线在第一次命中第四紫后，
                    // 再故意洗掉目标只会得到严格更贵的同类路线，因此本直线到此结束。
                    break;
                }

                // 第四槽可能通过九阴/玄阳/混元互冲形成合法置换入口；
                // 每个真实 landing 会进入 milestone，下一轮可选择继续置换或停止后再洗。
                enqueueFinalTailExchangeBranches(state, cost, trace, lockedTargets, node);
                if (!(await checkpoint('正在锁定前三紫完整扫描第四紫尾脉与天然置换入口', 'tail'))) break;
            }
        }

        async function processNode(node) {
            if (node.mode === 'milestone') {
                const currentTargets = targetsIn(node.state, targetSet);
                const carryLocks = node.carryLockedIds || [];
                directExchangeBranches(node.state, node.cost, node.trace,
                    carryLocks.length ? carryLocks : currentTargets,
                    { eventDepth: node.eventDepth, fromExchange: !!node.fromExchange });

                // 四紫模式在已经固定三条目标后切到专用尾脉扫描。
                // 这一阶段不再建立普通 blocker 搜索，因为三条紫锁定后只剩一个活动槽；
                // 仍保留原始紫直接命中、神脉天然冲突、Xraw 重复内跳与外部连续置换。
                if (targetIds.length === 4 && currentTargets.length === 3) {
                    await processFinalTail(node);
                    return;
                }

                const currentZiZhi = numeric(node.state.zizhi, 154);
                if (currentZiZhi < 153) {
                    // 0–2 槽只先开到三槽：在三槽洗出第一条目标紫后，
                    // 再由下面的三槽里程碑生成开启第四槽的分支。
                    const upgraded = actionUpgrade(engine, node.state, 3);
                    scope.upgradeBranches += 1;
                    enqueue(upgraded.state, node.cost, traceAppend(node.trace, upgraded.action), 'milestone', {
                        eventDepth: node.eventDepth + 1,
                        importance: 2600,
                    });
                    return;
                }
                if (currentZiZhi === 153 && currentTargets.length) {
                    const upgraded = actionUpgrade(engine, node.state);
                    scope.upgradeBranches += 1;
                    enqueue(upgraded.state, node.cost, traceAppend(node.trace, upgraded.action), 'milestone', {
                        eventDepth: node.eventDepth + 1,
                        importance: 1900 + currentTargets.length * 400,
                    });
                    // 多目标规划在三槽取得第一条目标紫后立即开第四槽，
                    // 不再保留“继续用三槽凑齐其余目标”的分支。
                    return;
                }

                if (node.fromExchange && currentTargets.length === 1 && node.state.luckSeed != null) {
                    const releasedId = currentTargets[0];
                    const unlocked = actionUnlock(node.state, [releasedId]);
                    scope.destroyVeinBranches += 1;
                    if (enqueue(unlocked.state, node.cost, traceAppend(node.trace, unlocked.action), 'baseline', {
                        protectedIds: [],
                        eventDepth: node.eventDepth + 1,
                        importance: 520,
                        deferred: true,
                        destroyPivotId: releasedId,
                    })) {
                        scope.destroyVeinExpanded += 1;
                    }
                }

                enqueue(node.state, node.cost, node.trace, 'baseline', {
                    protectedIds: currentTargets,
                    eventDepth: node.eventDepth,
                    importance: node.importance,
                });
                return;
            }

            if (node.mode === 'baseline') {
                let state = node.state;
                let cost = node.cost;
                let trace = node.trace;
                let scanStep = 0;
                const startingTargetCount = node.protectedIds.length;
                const nearestBlockers = new Map();

                // 里程碑本身可能是「目标紫 + 有价值冲突脉」同屏；先把当前槽面作为第 0 步检查点。
                rememberNearestBlockers(nearestBlockers, state, cost, trace, node.protectedIds, scanStep);

                while (true) {
                    if (node.protectedIds.some(id => !state.talents.includes(id))) break;
                    if (!canWash(state, node.protectedIds)) break;
                    const next = actionWash(engine, state, node.protectedIds,
                        node.protectedIds.length ? 'scan-targets' : 'scan-unlocked');
                    if (!canContinueAt(cost + next.action.cost)) {
                        scope.prunedByPills += 1;
                        break;
                    }
                    cost += next.action.cost;
                    noteWash('main');
                    trace = traceAppend(trace, next.action);
                    state = next.state;
                    scanStep += 1;
                    if (node.protectedIds.length) scope.lockedWashesScanned += 1;
                    else scope.unlockedWashesScanned += 1;

                    const generatedPurples = generatedPurpleIds(state, next.action.keepIds);
                    // 先用「之前最近一次」的 blocker 反查当前紫；本次同屏 blocker 不能倒序用于当前紫。
                    enqueueNearestBlockerReplays(nearestBlockers, generatedPurples, scanStep, node.eventDepth);
                    // 锁定时机扫描：不依赖紫脉反查，对每个 blocker 出现洗点直接起锁定线。
                    enqueueLockTimingBranches(state, cost, trace, node, next.action.keepIds);

                    const nextTargets = targetsIn(state, targetSet);
                    if (nextTargets.length > startingTargetCount) {
                        if (targetIds.length === 4 && startingTargetCount === 2 && nextTargets.length === 3) {
                            // 第三紫每一次真实出现都立即独立验证第四紫；尾段验证结束后，本锁二主线继续向后扫描。
                            scope.thirdTailCandidates += 1;
                            await processFinalTail({
                                state,
                                cost,
                                trace,
                                eventDepth: node.eventDepth + 1,
                            });
                        } else {
                            enqueue(state, cost, trace, 'milestone', {
                                eventDepth: node.eventDepth + 1,
                                importance: targetGainImportance(state, startingTargetCount, 900),
                            });
                        }
                    }

                    directExchangeBranches(state, cost, trace,
                        nextTargets.length > startingTargetCount ? nextTargets : node.protectedIds,
                        { eventDepth: node.eventDepth, fromExchange: false });

                    // 当前洗脉结束后再更新最近 blocker，供下一次及更后的紫脉事件使用。
                    rememberNearestBlockers(nearestBlockers, state, cost, trace, node.protectedIds, scanStep);

                    await checkpoint(nextTargets.length >= targetIds.length - 1 && targetIds.length >= 3
                        ? '正在保留第三紫各出现点并验证第四紫尾脉'
                        : '正在前推原始脉序并反查最近合法冲突脉');
                }
                return;
            }

            if (node.mode === 'seek') {
                let state = node.state;
                let cost = node.cost;
                let trace = node.trace;
                let washedAfterAnchor = !!node.washedAfterAnchor;
                let seekSteps = 0;
                const startingTargetCount = targetsIn(node.state, targetSet).length;
                while (true) {
                    // 锁定时机起路线的长尾保险：错误锁点的同类紫等待距离极长，
                    // 扫描超帽直接剪线（正确锁点实测只需 ≤13 洗，远小于帽）。
                    if (node.lockTiming && seekSteps > maxLockTimingSeekWashes) {
                        scope.lockTimingSeekCuts += 1;
                        break;
                    }
                    const opportunity = seekOpportunity(state, node, washedAfterAnchor);
                    if (!opportunity) break;
                    if (enqueuePadOpportunity(state, cost, trace, node, washedAfterAnchor)) break;
                    if (!canWash(state, opportunity.lockedIds)) break;
                    const next = actionWash(engine, state, opportunity.lockedIds, 'seek-purple');
                    if (!canContinueAt(cost + next.action.cost)) {
                        scope.prunedByPills += 1;
                        break;
                    }
                    cost += next.action.cost;
                    noteWash('main');
                    scope.lockedWashesScanned += 1;
                    seekSteps += 1;
                    trace = traceAppend(trace, next.action);
                    state = next.state;
                    washedAfterAnchor = true;
                    const currentTargetCount = targetsIn(state, targetSet).length;
                    if (currentTargetCount > startingTargetCount) {
                        enqueue(state, cost, trace, 'milestone', {
                            eventDepth: node.eventDepth + 1,
                            importance: targetGainImportance(state, startingTargetCount, 800),
                        });
                    }
                    directExchangeBranches(state, cost, trace, opportunity.lockedIds, {
                        eventDepth: node.eventDepth,
                        fromExchange: false,
                    });
                    await checkpoint('正在锁住最近冲突脉寻找待置换紫脉');
                }
                return;
            }

            if (node.mode === 'pad') {
                let state = node.state;
                let cost = node.cost;
                let trace = node.trace;
                const startingTargetCount = targetsIn(node.state, targetSet).length;
                // 置换结果只取决于（luckSeed 固化后的 luck 基准 + 当前占位内容）；
                // 同一签名再次出现意味着后续窗口必然循环重复，扫描提前剪枝。
                const visitedWindowSignatures = new Set();
                while (true) {
                    const keepIds = idsInStateOrder(state, [...node.protectedIds, node.conflictId, node.anchorId]);
                    const position = state.talents.indexOf(node.anchorId);
                    if (keepIds.some(id => !state.talents.includes(id))) break;
                    if (position >= 0 && engine.replaceablePositions(state, keepIds).includes(position)) {
                        const seedBasis = state.luckSeed == null
                            ? `B${numeric(state.bornSeed, 0)}`
                            : `L${numeric(state.luckSeed, 0)}`;
                        const windowSignature = `${seedBasis}|${[...state.talents]
                            .sort((left, right) => left - right).join('.')}|P${position}`;
                        if (visitedWindowSignatures.has(windowSignature)) {
                            scope.padWindowCycleCut += 1;
                            break;
                        }
                        visitedWindowSignatures.add(windowSignature);
                        scope.exchangeAttempts += 1;
                        scope.exchangeWindowsScanned += 1;
                        const exchanged = actionReplace(engine, state, position, 'conflict-exchange', keepIds);
                        scope.exchangeSuccesses += 1;
                        const window = classifyExchangeWindow(state, exchanged, keepIds);
                        if (window.removedTarget) scope.targetSacrificeBranches += 1;
                        if (window.removedTarget && window.addedTarget) scope.targetSwapSuccesses += 1;

                        const deferred = !(window.productive || window.retryBridge);
                        if (deferred) scope.exchangeWindowsDeferred += 1;
                        const sparseBonus = window.sparseProductive
                            ? Math.max(700, 3000 - numeric(window.sparseTargetGap, maxSparseTargetGap) * 150)
                            : 0;
                        if (window.sparseProductive) scope.sparseExchangeWindowsExpanded += 1;
                        const enqueued = enqueue(exchanged.state, cost, traceAppend(trace, exchanged.action), 'milestone', {
                            eventDepth: node.eventDepth + 1,
                            importance: window.addedTarget ? 3600 + landingBonusOf(window)
                                : (window.immediateProductive ? 2700
                                    : (window.retryBridge ? Math.max(1500, sparseBonus)
                                        : (window.sparseProductive ? sparseBonus
                                            : (window.removedTarget ? 420 : 260)))),
                            carryLockedIds: window.nextLocks,
                            fromExchange: true,
                            deferred,
                            sparseBridgeTargetIds: window.sparseTargetIds,
                            sparseBridgeGap: window.sparseTargetGap,
                        });
                        if (enqueued) scope.exchangeWindowsExpanded += 1;
                    }
                    if (!canWash(state, keepIds)) break;
                    const next = actionWash(engine, state, keepIds, 'pad-exchange');
                    if (!canContinueAt(cost + next.action.cost)) {
                        scope.prunedByPills += 1;
                        break;
                    }
                    cost += next.action.cost;
                    noteWash('main');
                    scope.lockedWashesScanned += 1;
                    scope.firstExchangePadsChecked += 1;
                    trace = traceAppend(trace, next.action);
                    state = next.state;
                    const currentTargetCount = targetsIn(state, targetSet).length;
                    if (currentTargetCount > startingTargetCount) {
                        enqueue(state, cost, trace, 'milestone', {
                            eventDepth: node.eventDepth + 1,
                            importance: targetGainImportance(state, startingTargetCount, 750),
                        });
                    }
                    await checkpoint('正在扫描无穷置换窗口；所有合法窗口均保留，目标窗口优先展开');
                }
            }
        }

        function buildResult() {
            const routes = Array.from(candidateNodes.values())
                .map(node => routeFromNode(ctx, node))
                .sort((left, right) => left.totalPills - right.totalPills
                    || left.totalWashes - right.totalWashes
                    || left.exchangeCount - right.exchangeCount
                    || left.steps.length - right.steps.length
                    || String(left.branchId).localeCompare(String(right.branchId)));

            return {
                strength: routes.length
                    ? (scope.exhaustiveWithinStrategyGraph ? '源码精确回放候选（v0.2.5 战术图已遍历完成）' : '源码精确回放候选（v0.2.5 扩展安全上限内）')
                    : (scope.exhaustiveWithinStrategyGraph ? 'v0.2.5 战术图完整遍历未找到路线' : 'v0.2.5 战术图扩展安全上限搜索'),
                objective: ['total_pills', 'total_washes', 'exchange_count', 'step_count'],
                targetIds,
                targetNames: targetIds.map(id => engine.name(id)),
                searchScope: scope,
                routes,
                noResultReason: routes.length ? ''
                    : `在不超过 ${maxTotalPills.toLocaleString()} 丹的 v0.2.5 战术图内未找到完整路线${scope.safetyLimitReached ? '；搜索触及主搜索/尾脉/状态深度安全上限，结果不是完整穷尽。' : '。'}`,
            };
        }

        // ===== luckSeed 穷举评分分析（Phase 0-3）：主搜索开始前跑一次秒级分析 =====
        // 产出：①完整路线上界（注入首候选，立即收紧单调支配剪枝，秒级首报）；
        //       ②自然目标/置换目标分类信息。
        // 分析失败绝不影响主搜索（整体 try 包裹）。
        if (initialSlotCount >= 3 && input.options?.luckSeedAnalysis !== false) {
            try {
                const analysis = analyzeAndScoreLuckSeeds(engine, startState, targetIds, {
                    maxTotalPills,
                    maxWashCap: Math.trunc(numeric(input.options?.analysisWashCap, 600)),
                    maxDraws: Math.trunc(numeric(input.options?.analysisMaxDraws, 2000)),
                    topK: Math.trunc(numeric(input.options?.analysisTopK, 20)),
                });
                scope.orderScanMs = analysis.stats.totalMs || 0;
                scope.orderScanConsumed = analysis.stats.candidatesEvaluated || 0;
                scope.orderScanSolutions = analysis.bestRoute ? 1 : 0;
                scope.orderScanSubsets = analysis.topK.length;
                scope.orderScanAborted = analysis.feasible ? null : 'infeasible';
                if (analysis.bestRoute && analysis.bestRoute.cost <= maxTotalPills
                    && containsTargets(analysis.bestRoute.state, targetSet)) {
                    const node = {
                        state: analysis.bestRoute.state, cost: analysis.bestRoute.cost,
                        trace: traceFromActions(analysis.bestRoute.actions),
                        serial: ++serial, mode: 'milestone', eventDepth: 0, importance: 0,
                    };
                    recordCandidate(node);
                    scope.orderInjectedBound = analysis.bestRoute.cost;
                }
            } catch (_) { /* luckSeed 分析为加速预置，任何异常都回退到无分析的原行为 */ }
        }

        try {
            onProgress({ phase: 'worker-start', done: 0, total: 1, message: '正在初始化三槽/四槽源码一致洗脉状态机' });
            enqueue(startState, 0, null, 'milestone');
            report(`最大耗丹 ${maxTotalPills.toLocaleString()}：从当前 ${initialSlotCount} 槽状态开始完整前推`, true);
            while ((queue.size || deferredQueue.size) && scope.expandedNodes < maxEventNodes) {
                let fromDeferred = false;
                if (!queue.size) {
                    fromDeferred = true;
                } else if (deferredQueue.size) {
                    const mainNode = queue.peek();
                    const rescueNode = deferredQueue.peek();
                    const rescueCompetitive = priorityOf(rescueNode) <= priorityOf(mainNode) + 450;
                    const rescueWaited = mainNodesSinceDeferred >= deferredInterleaveEvery;
                    fromDeferred = rescueCompetitive || rescueWaited;
                }
                const activeQueue = fromDeferred ? deferredQueue : queue;
                const node = activeQueue.pop();
                if (fromDeferred) {
                    mainNodesSinceDeferred = 0;
                    scope.deferredInterleaves += 1;
                } else {
                    mainNodesSinceDeferred += 1;
                }
                if (distance.get(node.key) !== node.cost) continue;
                if (node.cost > maxTotalPills) continue;
                scope.currentPillCost = node.cost;
                scope.expandedNodes += 1;
                if (fromDeferred) scope.deferredNodesExpanded += 1;
                await processNode(node);
                report(`关键状态 ${scope.expandedNodes.toLocaleString()}，模拟洗脉 ${scope.rawWashesSimulated.toLocaleString()}（主 ${scope.mainRawWashesSimulated.toLocaleString()} / 尾 ${scope.tailRawWashesSimulated.toLocaleString()}），主队列 ${queue.size.toLocaleString()}，救援 ${deferredQueue.size.toLocaleString()}，毁脉 ${scope.destroyVeinExpanded.toLocaleString()}，稀疏桥 ${scope.sparseExchangeWindowsDetected.toLocaleString()}，完整候选 ${scope.candidateCount.toLocaleString()}`);
                await checkpoint('正在继续遍历其余可达路线');
            }
            if (queue.size || deferredQueue.size) scope.safetyLimitReached = true;
            scope.exhaustiveWithinStrategyGraph = !queue.size && !deferredQueue.size && !scope.safetyLimitReached;
            return buildResult();
        } catch (error) {
            if (error && error.message === 'SEARCH_CANCELLED') return { cancelled: true, routes: [], searchScope: scope };
            if (error && error.message === 'SEARCH_MAIN_SAFETY_LIMIT') {
                scope.mainSafetyLimitReached = true;
                scope.safetyLimitReached = true;
                scope.exhaustiveWithinStrategyGraph = false;
                return buildResult();
            }
            throw error;
        }
    }

    // ===== Stage B：动作图上分支定界最优搜索（证明最低丹耗） =====
    // 默认宏观事件动作图（actionGraph=macro）：节点 = 完整引擎状态 + 当前寻脉段锁集 + 是否事件点；
    //   寻脉段内锁集保持不变逐洗，仅在事件点（新生紫脉/新生可承接蓝脉/置换/升槽）允许切换锁集，
    //   置换在任意洗脉点可选（垫洗窗口完整保留）——这正是「锁前置蓝→找同类紫→垫洗→置换」
    //   思路的严格化，深度从数百逐洗压到事件级，能在预算内跑完并给出族内最优证明。
    // options.actionGraph='full' 恢复全体合法动作图（任意锁集逐洗切换，通常只能 time-cap + gap 证书）。
    async function searchWashRoutesOptimal(input, base = {}) {
        if (!root.WashSourceEngine) throw new Error('源码洗脉状态机未加载');
        const talentData = input?.talentData || root.TALENT_DATA || {};
        const targetIds = Array.from(new Set((input?.targetIds || []).map(Number).filter(id => id > 0)));
        const targetSet = new Set(targetIds);
        const options = input?.options || {};
        const maxTotalPills = Math.max(0, Math.min(100000, Math.trunc(numeric(options.maxTotalPills, 3000))));
        const onProgress = typeof input?.onProgress === 'function' ? input.onProgress : () => {};
        const shouldCancel = typeof input?.shouldCancel === 'function' ? input.shouldCancel : () => false;
        const yieldControl = typeof input?.yieldControl === 'function' ? input.yieldControl : sleepTurn;
        const stateCap = Math.max(64, Math.trunc(numeric(options.frontierStateCap, 400000)));
        const elapsedCap = Math.max(500, Math.trunc(numeric(options.elapsedMsCap, 30000)));
        const exchangeCap = Math.max(32, Math.trunc(numeric(options.exchangeClosureCap, 200000)));
        const useAdmissibleH = !!options.admissibleHeuristic;
        const macroMode = String(options.actionGraph || 'macro').toLowerCase() !== 'full';
        const startedAt = Date.now();
        if (!targetIds.length || targetIds.length > 4) {
            return { strength: '输入无效', routes: [], noResultReason: '请选择 1–4 条目标紫脉。' };
        }

        const engine = new root.WashSourceEngine.Engine(talentData, input.initialState || {}, {
            dlcMode: !!input.dlcMode,
            eligibleTalentIds: input.eligibleTalentIds,
            saveChannel: input.initialState?.save_channel || '',
        });
        const unavailable = targetIds.filter(id => !engine.allowed.has(id));
        if (unavailable.length) {
            return { strength: '输入无效', routes: [], noResultReason: `当前人物或四脉资质不可用目标：${unavailable.map(id => engine.name(id)).join('、')}` };
        }

        const startState = engine.initialState(input.initialState || {});
        const initialSlotCount = Math.max(0, Math.min(4, numeric(startState.zizhi, 154) - 150));
        const upperBound = base.bestComplete != null
            && Number.isFinite(numeric(base.bestComplete))
            && numeric(base.bestComplete) <= maxTotalPills
            ? numeric(base.bestComplete)
            : maxTotalPills + 1;
        const scope = {
            algorithm: 'optimal-branch-and-bound-v2',
            actionGraph: macroMode ? 'macro-event' : 'full',
            strategyGraph: macroMode
                ? '宏观事件动作图：寻脉段锁集仅在事件点（新生紫脉/新生可承接蓝脉/置换/升槽）切换，任意洗脉点可选置换，含提交未命中重试链；任意锁集逐洗切换请用 options.actionGraph="full"'
                : '全体合法动作图：任意锁集逐洗 + 全部合法置换 + 自由升槽',
            maxTotalPills,
            initialSlotCount,
            statesExpanded: 0,
            statesGenerated: 0,
            dominatedNodes: 0,
            prunedByUpperBound: 0,
            prunedByPills: 0,
            frontierPeak: 0,
            exchangeEdgesGenerated: 0,
            exchangeClosureCapReached: false,
            washEdgesGenerated: 0,
            upgradeEdgesGenerated: 0,
            bestComplete: null,
            lowerBound: null,
            gap: null,
            verifiedOptimal: false,
            terminatedBy: 'running',
            elapsedMs: 0,
        };
        const ctx = {
            engine, targetIds, targetSet, initialState: input.initialState || {}, startState,
            hasBagPills: !!input.hasBagPills,
            bagPills: numeric(input.bagPills, numeric(input.initialState?.bag_pills)),
        };

        let serial = 0;
        let bestNode = null;
        let lastReportAt = 0;
        const improvingNodes = [];
        const distance = new Map();
        // 宏观模式下同一引擎状态在不同寻脉段语境（锁集/事件点）下展开的子女集不同，
        // 支配键必须带上语境，否则会误杀另一条寻脉段的重试链。
        function dominanceKey(state, run, isEvent) {
            const base = root.WashSourceEngine.stateKey(state);
            if (!macroMode) return base;
            return `${base}|K:${(run || []).join('.')}|E:${isEvent ? 1 : 0}`;
        }
        const queue = new MinHeap((left, right) => left.f - right.f || left.cost - right.cost || left.serial - right.serial);

        function slotCountOf(state) {
            if (typeof engine.slotCountFor === 'function') return engine.slotCountFor(numeric(state.zizhi, 154));
            return Math.max(1, Math.min(4, (state.talents || []).length || initialSlotCount || 4));
        }

        // 自由选择锁位后，多神脉槽恒可置换；普通紫脉在同型前置非紫被锁时也可置换。
        // 置换结果只取决于被移除槽位，与具体锁集无关，因此每个位置只生成一条 0 成本边。
        function exchangeablePositionsOf(state) {
            const result = [];
            const shenmaiIndexes = state.talents
                .map((id, index) => ({ id, index }))
                .filter(item => engine.isShenmai(item.id))
                .map(item => item.index);
            const multiShenmai = shenmaiIndexes.length >= 2;
            const firstByType = new Map();
            state.talents.forEach((id, index) => {
                const type = engine.talentType(id);
                if (multiShenmai && engine.isShenmai(id)) {
                    result.push({ index, locks: [] });
                    if (!firstByType.has(type)) firstByType.set(type, index);
                    return;
                }
                if (firstByType.has(type)) {
                    const earlierId = state.talents[firstByType.get(type)];
                    if (engine.quality(id) === 4 && !engine.isShenmai(id)
                        && engine.quality(earlierId) < 4) {
                        result.push({ index, locks: [earlierId] });
                    }
                } else {
                    firstByType.set(type, index);
                }
            });
            // 与引擎判定对齐，防止规则演进造成偏差。
            return result.filter(entry => engine.replaceablePositions(state, entry.locks).includes(entry.index));
        }

        // 保守可采纳启发式：存在任何 0 成本边（可置换/可升槽）时无法排除免费取得目标 → 0；
        // 仅当四槽且无可置换位置时，每个缺失目标至少需要一次洗脉（一次洗脉最多产出 1 条紫）。
        function heuristicOf(state) {
            if (!useAdmissibleH) return 0;
            if (numeric(state.zizhi, 154) < 154) return 0;
            if (exchangeablePositionsOf(state).length) return 0;
            const missing = targetIds.filter(id => !state.talents.includes(id)).length;
            const rule = (root.WashSourceEngine.ZZ_RULES || {})[154];
            return missing * numeric(rule && rule.baseCost, 5);
        }

        // 仅用于 0 成本边的展开排序（productive-first），不参与最优性判定。
        function chainCanReachTarget(state, depth = 8, visited = new Set()) {
            if (depth <= 0) return false;
            const key = root.WashSourceEngine.stateKey(state);
            if (visited.has(key)) return false;
            visited.add(key);
            for (const entry of exchangeablePositionsOf(state)) {
                let exchanged;
                try {
                    exchanged = engine.replace(state, entry.index, entry.locks);
                } catch (_) {
                    continue;
                }
                if (targetSet.has(exchanged.addedId)) return true;
                if (chainCanReachTarget(exchanged.state, depth - 1, visited)) return true;
            }
            return false;
        }

        function effectiveBest() {
            if (bestNode) return bestNode.cost;
            return upperBound <= maxTotalPills ? upperBound : Infinity;
        }

        function recordSolution(node) {
            if (bestNode && node.cost >= bestNode.cost) {
                scope.dominatedNodes += 1;
                return false;
            }
            bestNode = node;
            improvingNodes.push(node);
            if (improvingNodes.length > 32) improvingNodes.splice(0, improvingNodes.length - 32);
            scope.bestComplete = node.cost;
            return true;
        }

        function enqueue(state, cost, trace, h, run = null, isEvent = false) {
            if (cost >= effectiveBest()) {
                scope.prunedByUpperBound += 1;
                return false;
            }
            if (cost > maxTotalPills) {
                scope.prunedByPills += 1;
                return false;
            }
            const key = dominanceKey(state, run, isEvent);
            const previous = distance.get(key);
            if (previous != null && previous <= cost) {
                scope.dominatedNodes += 1;
                return false;
            }
            // 同一 (状态, 锁集) 下事件点节点的子女集严格包含非事件点节点（全枚举 ⊇ 延续），
            // 因此更便宜的事件点版本可以直接支配非事件点版本。
            if (macroMode && !isEvent && Array.isArray(run)) {
                const eventKey = dominanceKey(state, run, true);
                const eventCost = distance.get(eventKey);
                if (eventCost != null && eventCost <= cost) {
                    scope.dominatedNodes += 1;
                    return false;
                }
            }
            distance.set(key, cost);
            scope.statesGenerated += 1;
            const node = { state, cost, f: cost + numeric(h, 0), trace, serial: ++serial, key, run, isEvent };
            if (containsTargets(state, targetSet)) {
                recordSolution(node);
                return true;
            }
            queue.push(node);
            scope.frontierPeak = Math.max(scope.frontierPeak, queue.size);
            return true;
        }

        function expandNode(node) {
            const state = node.state;
            const cost = node.cost;
            const trace = node.trace;
            const slots = slotCountOf(state);

            // 0 成本置换边：productive-first 排序，同 g 下按 serial 先展开。
            const exchanges = [];
            for (const entry of exchangeablePositionsOf(state)) {
                if (scope.exchangeEdgesGenerated >= exchangeCap) {
                    scope.exchangeClosureCapReached = true;
                    break;
                }
                let exchanged;
                try {
                    exchanged = engine.replace(state, entry.index, entry.locks);
                } catch (_) {
                    continue;
                }
                scope.exchangeEdgesGenerated += 1;
                const addedTarget = targetSet.has(exchanged.addedId);
                const score = addedTarget ? 0 : (chainCanReachTarget(exchanged.state) ? 1 : 2);
                exchanges.push({ score, exchanged, locks: entry.locks });
            }
            exchanges.sort((left, right) => left.score - right.score);
            for (const item of exchanges) {
                const exchanged = item.exchanged;
                enqueue(exchanged.state, cost, traceAppend(trace, {
                    kind: 'exchange',
                    mode: 'optimal-exchange',
                    keepIds: idsInStateOrder(state, item.locks),
                    cost: 0,
                    draws: exchanged.draws,
                    generatedBars: 0,
                    removedId: exchanged.removedId,
                    addedId: exchanged.addedId,
                    after: exchanged.state,
                }), heuristicOf(exchanged.state), null, true);
            }

            // 0 成本升槽边；"暂不升槽"分支即当前状态继续留在队列参与后续展开。
            const zizhi = numeric(state.zizhi, 154);
            if (zizhi < 154 && slots < 4) {
                const upgraded = actionUpgrade(engine, state, slots < 3 ? 3 : 4);
                scope.upgradeEdgesGenerated += 1;
                enqueue(upgraded.state, cost, traceAppend(trace, upgraded.action), heuristicOf(upgraded.state), null, true);
            }

            // 正成本洗脉边：全体图枚举全部合法锁集；宏观图仅在事件点枚举，
            // 非事件点只生成一条「寻脉段延续」边（锁集不变逐洗），含提交未命中重试链。
            const fullEnumerate = !macroMode || !Array.isArray(node.run) || node.isEvent;
            const keepOptions = [];
            if (fullEnumerate) {
                const totalMasks = 1 << slots;
                for (let mask = 0; mask < totalMasks; mask += 1) {
                    const positions = [];
                    for (let bit = 0; bit < slots; bit += 1) {
                        if ((mask & (1 << bit)) && bit < state.talents.length) positions.push(bit);
                    }
                    if (positions.length >= slots) continue;
                    keepOptions.push(positions.map(position => state.talents[position]));
                }
                keepOptions.sort((left, right) => left.length - right.length);
            } else {
                try {
                    const keepIds = idsInStateOrder(state, node.run);
                    if (keepIds.length < slots) keepOptions.push(keepIds);
                } catch (_) {
                    /* 锁集已不完整：该寻脉段自然终止 */
                }
            }
            for (const keepIds of keepOptions) {
                const washed = actionWash(engine, state, keepIds, fullEnumerate ? 'optimal-wash' : 'optimal-run');
                scope.washEdgesGenerated += 1;
                const keepSet = new Set(keepIds);
                // 事件点 = 新生紫脉，或新生「可承接同型紫脉」的 blocker 蓝脉：
                // 后者是「锁定工具脉」的正确时机点（如 2013 日志第 175 洗锁精气旺盛），
                // 若不把它当事件点，寻脉段内锁集永远切不到刚出现的蓝脉上。
                const generatedEvent = washed.state.talents.some(id => !keepSet.has(id)
                    && (engine.quality(id) === 4
                        || (typeof engine.hasOrdinaryPurpleSuccessor === 'function'
                            && engine.hasOrdinaryPurpleSuccessor(id))));
                enqueue(washed.state, cost + washed.action.cost,
                    traceAppend(trace, washed.action), heuristicOf(washed.state),
                    macroMode ? keepIds.slice() : null, generatedEvent);
            }
        }

        function currentLowerBound() {
            let fMin = null;
            if (queue.size) fMin = queue.peek().f;
            if (pendingFMin != null) fMin = fMin == null ? pendingFMin : Math.min(fMin, pendingFMin);
            if (fMin != null) {
                const best = effectiveBest();
                return Number.isFinite(best) ? Math.min(best, fMin) : fMin;
            }
            const best = effectiveBest();
            return Number.isFinite(best) ? best : null;
        }

        function report(force = false) {
            const now = Date.now();
            if (!force && now - lastReportAt < 150) return;
            lastReportAt = now;
            const lowerBound = currentLowerBound();
            const best = effectiveBest();
            onProgress({
                phase: 'optimal-proof',
                statesExpanded: scope.statesExpanded,
                frontierPeak: scope.frontierPeak,
                currentF: queue.size ? queue.peek().f : null,
                bestComplete: Number.isFinite(best) ? best : null,
                lowerBound,
                gap: Number.isFinite(best) && lowerBound != null ? Math.max(0, best - lowerBound) : null,
                elapsedMs: now - startedAt,
                message: Number.isFinite(best)
                    ? `已找到 ${best} 丹路线，正在收紧最优性证明`
                    : (macroMode ? '正在宏观事件动作图上证明族内最低丹耗' : '正在全体合法动作图上证明最低丹耗'),
            });
        }

        // 预算中断时，刚弹出但未展开的节点也算“未探索”，其 f 必须计入下界。
        let pendingFMin = null;
        try {
            enqueue(startState, 0, null, heuristicOf(startState));
            let terminatedBy = 'running';
            while (queue.size) {
                const node = queue.pop();
                if (distance.get(node.key) !== node.cost) continue;
                if (macroMode && !node.isEvent && Array.isArray(node.run)) {
                    const eventCost = distance.get(dominanceKey(node.state, node.run, true));
                    if (eventCost != null && eventCost <= node.cost) continue;
                }
                const best = effectiveBest();
                if (Number.isFinite(best) && node.f >= best) {
                    terminatedBy = 'optimal-proven';
                    break;
                }
                if (scope.statesExpanded >= stateCap) {
                    pendingFMin = node.f;
                    terminatedBy = 'state-cap';
                    break;
                }
                if (Date.now() - startedAt >= elapsedCap) {
                    pendingFMin = node.f;
                    terminatedBy = 'time-cap';
                    break;
                }
                if (shouldCancel()) {
                    pendingFMin = node.f;
                    terminatedBy = 'user-cancelled';
                    break;
                }
                scope.statesExpanded += 1;
                expandNode(node);
                if ((scope.statesExpanded & 255) === 0) {
                    report();
                    await yieldControl();
                }
            }
            // 队列排空 = 所有 g < best 的状态均已完整展开，同样构成最优性证明；
            // 仅当无解或置换闭包预算降级时保留“未证明”语义。
            if (terminatedBy === 'running') {
                terminatedBy = Number.isFinite(effectiveBest()) && !scope.exchangeClosureCapReached
                    ? 'optimal-proven'
                    : 'exhausted';
            }
            scope.terminatedBy = terminatedBy;
            scope.elapsedMs = Date.now() - startedAt;
            scope.lowerBound = currentLowerBound();
            const best = effectiveBest();
            scope.bestComplete = Number.isFinite(best) ? best : null;
            scope.gap = scope.bestComplete != null && scope.lowerBound != null
                ? Math.max(0, scope.bestComplete - scope.lowerBound)
                : null;
            scope.verifiedOptimal = scope.bestComplete != null && scope.gap === 0
                && !scope.exchangeClosureCapReached
                && terminatedBy !== 'user-cancelled';

            const routes = improvingNodes.map(node => routeFromNode(ctx, node, {
                kind: 'optimal-bnb',
                verifiedOptimal: scope.verifiedOptimal,
                branchId: `optimal-bnb-${node.serial}`,
                branchLabel: initialSlotCount === 4 ? '当前四槽起点' : `${initialSlotCount} 槽真实起手`,
                strategyLabel: macroMode ? '宏观事件动作图 · 分支定界最优搜索' : '全体合法动作图 · 分支定界最优搜索',
            })).sort((left, right) => left.totalPills - right.totalPills
                || left.totalWashes - right.totalWashes
                || left.exchangeCount - right.exchangeCount
                || left.steps.length - right.steps.length);

            return {
                strength: routes.length
                    ? (scope.verifiedOptimal
                        ? `源码精确回放候选（${macroMode ? '宏观事件动作图' : '全体合法动作图'} · 已证明最低丹耗）`
                        : `源码精确回放候选（${macroMode ? '宏观事件动作图' : '全体合法动作图'} · 预算内最优）`)
                    : (scope.verifiedOptimal
                        ? `${macroMode ? '宏观事件动作图' : '全体合法动作图'}完整遍历未找到路线`
                        : `${macroMode ? '宏观事件动作图' : '全体合法动作图'}预算内搜索未找到路线`),
                objective: ['total_pills', 'total_washes', 'exchange_count', 'step_count'],
                targetIds,
                targetNames: targetIds.map(id => engine.name(id)),
                searchScope: scope,
                routes,
                bestComplete: scope.bestComplete,
                verifiedOptimal: scope.verifiedOptimal,
                lowerBound: scope.lowerBound,
                gap: scope.gap,
                noResultReason: routes.length ? ''
                    : `在不超过 ${maxTotalPills.toLocaleString()} 丹的${macroMode ? '宏观事件' : '全体合法'}动作图内未找到完整路线${scope.exchangeClosureCapReached
                        ? '；置换边预算耗尽，结果不是完整穷尽。'
                        : (terminatedBy === 'state-cap'
                            ? '；状态数预算耗尽，结果不是完整穷尽。'
                            : (terminatedBy === 'time-cap' ? '；时间预算耗尽，结果不是完整穷尽。' : '。'))}`,
            };
        } catch (error) {
            if (error && error.message === 'SEARCH_CANCELLED') return { cancelled: true, routes: [], searchScope: scope };
            throw error;
        }
    }

    // ===== 两阶段编排：Stage A 快速上界 → Stage B 证明最优 =====
    async function searchWashRoutes(input) {
        const options = input?.options || {};
        const fast = await searchWashRoutesFast(input);
        if (fast && fast.cancelled) return fast;
        if (!fast || options.proveOptimal === false) return fast;
        const fastBest = (fast.routes || []).length
            ? Math.min(...fast.routes.map(route => numeric(route.totalPills, Infinity)))
            : null;
        const optimal = await searchWashRoutesOptimal(input, { bestComplete: fastBest });
        if (optimal.cancelled) return fast;
        const merged = [...(fast.routes || []), ...(optimal.routes || [])]
            .sort((left, right) => left.totalPills - right.totalPills
                || left.totalWashes - right.totalWashes
                || left.exchangeCount - right.exchangeCount
                || left.steps.length - right.steps.length)
            .slice(0, 6);
        const verifiedOptimal = !!optimal.verifiedOptimal;
        if (verifiedOptimal) {
            merged.forEach(route => {
                if (Number(route.totalPills) === Number(optimal.lowerBound)) route.verifiedOptimal = true;
            });
        }
        const lowerBound = optimal.lowerBound;
        const gap = optimal.gap;
        return {
            strength: merged.length
                ? (verifiedOptimal
                    ? '源码精确回放候选（已证明最低丹耗）'
                    : (gap != null
                        ? `源码精确回放候选（预算内最优，最低可能 ≥ ${Number(lowerBound).toLocaleString()} 丹，缺口 ≤ ${Number(gap).toLocaleString()} 丹）`
                        : '源码精确回放候选（预算内最优，最优性未证明）'))
                : (optimal.noResultReason || fast.noResultReason || '未找到可回放路线'),
            objective: fast.objective || ['total_pills', 'total_washes', 'exchange_count', 'step_count'],
            targetIds: fast.targetIds || optimal.targetIds,
            targetNames: fast.targetNames || optimal.targetNames,
            searchScope: { ...(fast.searchScope || {}), stageB: optimal.searchScope },
            routes: merged,
            verifiedOptimal,
            lowerBound,
            gap,
            noResultReason: merged.length ? ''
                : (optimal.noResultReason || fast.noResultReason || '搜索范围内没有找到可回放路线。'),
        };
    }

    root.WashSourceOptimizer = Object.freeze({
        searchWashRoutes,
        searchWashRoutesFast,
        searchWashRoutesOptimal,
        analyzeAndScoreLuckSeeds,
        scanVeinOrders,
        MinHeap,
        compactActions,
    });
})(typeof window !== 'undefined' ? window : globalThis);
