#!/usr/bin/env node
// 洗脉最优丹耗对拍验证（Node 版，直接加载运行时引擎）
//
// 用途：验证 wash_source_optimizer.js 的两阶段架构（Stage A 快速上界 + Stage B 分支定界）：
//   1. Stage B（无 UB 热启动）作为纯 B&B 参考：小上限场景下收敛时 gap === 0 且 verifiedOptimal。
//   2. UB 热启动只加速、不改变最终最优值：warm.bestComplete === cold.bestComplete。
//   3. 可采纳 h 开关两态结果一致（防 h 引入不可采纳误差）。
//   4. 回归：Stage A（旧加权 A* 战术图）找到路线时，Stage B 最优值 ≤ Stage A 最优值。
//   5. 编排器 searchWashRoutes 在 Stage B 证明最优时正确打标 verifiedOptimal。
//   6. 快照对比：--update 写入 dev/wash_optimal.snapshot.json；默认模式与快照逐字段对比。
//
// 用法：
//   node dev/check_wash_optimal.mjs            # 运行对拍并与快照对比（无快照则先写入）
//   node dev/check_wash_optimal.mjs --update   # 运行对拍并刷新快照

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHARED = path.resolve(HERE, '..', 'web', 'shared');
const SNAPSHOT_FILE = path.join(HERE, 'wash_optimal.snapshot.json');
const UPDATE_SNAPSHOT = process.argv.includes('--update');
const SEED_SCAN_LIMIT = 8000;

// ---------- 共享脚本加载（vm 沙箱模拟 worker 的 importScripts 链） ----------
function loadShared() {
    const context = vm.createContext({
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        TextEncoder,
    });
    for (const file of ['sequence_rules.js', 'data.js', 'wash_route_engine.js', 'wash_source_optimizer.js']) {
        vm.runInContext(readFileSync(path.join(SHARED, file), 'utf8'), context, { filename: file });
    }
    if (!context.WashSourceEngine || !context.WashSourceOptimizer || !context.TALENT_DATA) {
        throw new Error('共享脚本加载失败：缺少 WashSourceEngine / WashSourceOptimizer / TALENT_DATA');
    }
    return context;
}

// ---------- 工具 ----------
function withTimeout(promise, ms, label) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`${label} 超时（> ${ms}ms）`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

function baseState(overrides = {}) {
    return {
        zizhi: 154,
        seed: 1,
        luck_seed_inited: true,
        luck_seed: 1,
        tal_lucky: 900, // 恰好触发保底，首洗必先抽紫池
        born_talent_rc: 0,
        talents: [],
        role_id: 1,
        sex: 1,
        role_level: 90,
        vip: 1,
        salt: 0,
        role_stats: { str_val: 1000, con: 1000, dex: 1000, int_val: 1000 },
        ...overrides,
    };
}

// 在种子空间内寻找确定性场景：首洗（pity 激活）即抽出目标紫的 seed。
function findSeed(engine, stateTemplate, keepPositions, targetId) {
    for (let seed = 1; seed <= SEED_SCAN_LIMIT; seed += 1) {
        const raw = { ...stateTemplate, seed, luck_seed: seed };
        try {
            const start = engine.initialState(raw);
            const washed = engine.wash(start, keepPositions);
            if (washed.state.talents.includes(targetId)) return seed;
        } catch (_) {
            // 洗脉抽取未收敛等异常：换下一个种子
        }
    }
    throw new Error(`在 ${SEED_SCAN_LIMIT} 个种子内未找到首洗即得目标 ${targetId} 的确定性种子`);
}

function assertEqual(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}：期望 ${expected}，实际 ${actual}`);
}

function assertTrue(condition, label) {
    if (!condition) throw new Error(label);
}

// ---------- 场景执行 ----------
async function runScenario(context, label, raw, targets, maxTotalPills) {
    const optimizer = context.WashSourceOptimizer;
    const makeInput = (extraOptions = {}) => ({
        initialState: raw,
        targetIds: targets,
        talentData: context.TALENT_DATA,
        dlcMode: false,
        options: { maxTotalPills, ...extraOptions },
        shouldCancel: () => false,
        onProgress: () => {},
    });
    const cold = await withTimeout(optimizer.searchWashRoutesOptimal(makeInput(), {}), 90000, `${label} Stage B 冷启动`);
    const warm = await withTimeout(
        optimizer.searchWashRoutesOptimal(makeInput(), { bestComplete: cold.bestComplete }),
        90000,
        `${label} Stage B 热启动`,
    );
    const hOn = await withTimeout(
        optimizer.searchWashRoutesOptimal(makeInput({ admissibleHeuristic: true }), {}),
        90000,
        `${label} Stage B 可采纳 h`,
    );
    const fast = await withTimeout(optimizer.searchWashRoutesFast(makeInput()), 90000, `${label} Stage A`);
    const orchestrated = await withTimeout(optimizer.searchWashRoutes(makeInput({ proveOptimal: true })), 90000, `${label} 编排器`);
    return { label, cold, warm, hOn, fast, orchestrated, targets };
}

function verifyScenario(scenario) {
    const { label, cold, warm, hOn, fast, orchestrated, targets } = scenario;
    const failures = [];
    const notes = [];
    try {
        assertTrue(cold.routes.length > 0, `${label}：Stage B 应找到路线`);
        assertTrue(
            cold.gap === 0 && cold.verifiedOptimal === true,
            `${label}：Stage B 收敛时应 gap===0 且 verifiedOptimal（gap=${cold.gap}, terminatedBy=${cold.searchScope.terminatedBy}）`,
        );
        assertEqual(
            cold.searchScope.terminatedBy, 'optimal-proven', `${label}：Stage B 终止原因应为 optimal-proven`,
        );
        // UB 热启动只加速、不改变最优值
        assertEqual(warm.bestComplete, cold.bestComplete, `${label}：热启动不得改变最优值`);
        assertEqual(warm.verifiedOptimal, cold.verifiedOptimal, `${label}：热启动不得改变最优性结论`);
        // h 开关两态一致
        assertEqual(hOn.bestComplete, cold.bestComplete, `${label}：可采纳 h 开关两态最优值一致`);
        assertEqual(hOn.verifiedOptimal, cold.verifiedOptimal, `${label}：可采纳 h 开关两态最优性结论一致`);
        // 路线回放校验（routeFromNode 内部 replayNode 已校验）
        const bestRoute = cold.routes[0];
        assertTrue(bestRoute.verified === true, `${label}：最优路线应通过回放校验`);
        for (const id of targets) {
            assertTrue(
                (bestRoute.finalTalents || []).some(item => Number(item.id) === Number(id)),
                `${label}：最优路线终态应含目标 ${id}`,
            );
        }
        // 回归：旧算法（Stage A）有解时，新算法最优值 ≤ 旧算法最优值
        const fastBest = fast.routes.length ? Math.min(...fast.routes.map(route => Number(route.totalPills))) : null;
        if (fastBest != null) {
            assertTrue(cold.bestComplete <= fastBest, `${label}：新算法 ${cold.bestComplete} 丹应 ≤ 旧算法 ${fastBest} 丹`);
        } else {
            notes.push('Stage A 在此上限未找到路线，跳过新旧对比');
        }
        // 编排器：Stage B 证明最优时整体 verifiedOptimal，最便宜路线被打标
        assertEqual(orchestrated.verifiedOptimal, true, `${label}：编排器应报告 verifiedOptimal`);
        assertEqual(
            Math.min(...orchestrated.routes.map(route => Number(route.totalPills))),
            cold.bestComplete,
            `${label}：编排器最便宜路线应与 Stage B 最优值一致`,
        );
        const flagged = orchestrated.routes.filter(route => route.verifiedOptimal === true);
        assertTrue(flagged.length > 0, `${label}：编排器应对最优路线打标 verifiedOptimal`);
        assertEqual(flagged[0].totalPills, cold.bestComplete, `${label}：打标路线丹耗应等于最优值`);
        assertEqual(orchestrated.gap, 0, `${label}：编排器 gap 应为 0`);
    } catch (error) {
        failures.push(error.message);
    }
    return { label, failures, notes, cold };
}

// 预算中断场景：固定种子 + 极小状态预算，验证证书语义（不得声称已证明、必须给下界）。
async function runBudgetScenario(context, label, raw, targets, maxTotalPills, stateCap) {
    const optimizer = context.WashSourceOptimizer;
    const input = {
        initialState: raw,
        targetIds: targets,
        talentData: context.TALENT_DATA,
        dlcMode: false,
        options: { maxTotalPills, frontierStateCap: stateCap, elapsedMsCap: 60000 },
        shouldCancel: () => false,
        onProgress: () => {},
    };
    return withTimeout(optimizer.searchWashRoutesOptimal(input, {}), 90000, label);
}

// ---------- 主流程 ----------
async function main() {
    const context = loadShared();
    const probe = new context.WashSourceEngine.Engine(context.TALENT_DATA, baseState(), { dlcMode: false });
    const purpleIds = probe.purpleIds.filter(id => probe.allowed.has(id));
    if (purpleIds.length < 4) throw new Error('紫池太小，无法构造 4 目标场景');
    const junkIds = probe.allIds.filter(id => probe.quality(id) < 4 && probe.allowed.has(id));
    const purpleByType = new Map();
    for (const id of purpleIds) {
        const type = probe.talentType(id);
        if (!purpleByType.has(type)) purpleByType.set(type, id);
    }
    const distinct = [...purpleByType.values()];
    if (distinct.length < 4) throw new Error('不同型的紫脉不足 4 条，无法构造互不干扰的目标组合');
    const [p1, p2, p3, p4] = distinct.slice(0, 4);
    const junkTypes = new Set(distinct.slice(0, 4).map(id => probe.talentType(id)));
    const junk = junkIds.filter(id => !junkTypes.has(probe.talentType(id))).slice(0, 2);
    if (junk.length < 2) throw new Error('缺少与目标不同型的非紫填充脉');

    const results = [];
    const failures = [];

    // 场景 1：单目标、空槽、首洗保底即出目标
    {
        const raw = baseState({ talents: [] });
        const seed = findSeed(probe, raw, [], p1);
        raw.seed = seed;
        raw.luck_seed = seed;
        results.push(await runScenario(context, '单目标空槽首洗', raw, [p1], 10));
    }
    // 场景 2：三目标、已含 2 条目标紫，锁 2 首洗出第三条
    {
        const raw = baseState({ talents: [{ id: p1 }, { id: p2 }, { id: junk[0] }, { id: junk[1] }] });
        const seed = findSeed(probe, raw, [0, 1], p3);
        raw.seed = seed;
        raw.luck_seed = seed;
        results.push(await runScenario(context, '三目标已含二锁二首洗', raw, [p1, p2, p3], 20));
    }
    // 场景 3：四目标、已含 3 条目标紫，锁 3 首洗出第四条
    {
        const raw = baseState({ talents: [{ id: p1 }, { id: p2 }, { id: p3 }, { id: junk[0] }] });
        const seed = findSeed(probe, raw, [0, 1, 2], p4);
        raw.seed = seed;
        raw.luck_seed = seed;
        results.push(await runScenario(context, '四目标已含三锁三首洗', raw, [p1, p2, p3, p4], 30));
    }

    // 场景 4：预算中断证书（固定种子，4 槽 50 丹 3 目标在 64 状态预算内不可能证明）
    {
        const raw = baseState({ talents: [], seed: 1, luck_seed: 1 });
        const budget = await runBudgetScenario(context, '预算中断证书', raw, [p1, p2, p3], 50, 64);
        const terminatedBy = budget.searchScope.terminatedBy;
        try {
            assertEqual(terminatedBy, 'state-cap', '预算中断证书：终止原因应为 state-cap');
            assertEqual(budget.verifiedOptimal, false, '预算中断证书：预算耗尽不得声称已证明');
            assertTrue(budget.lowerBound != null, '预算中断证书：应给出下界');
            if (budget.bestComplete != null) {
                assertTrue(budget.lowerBound <= budget.bestComplete, '预算中断证书：下界不得超过最优上界');
                assertTrue(budget.gap > 0, '预算中断证书：未证明时缺口应大于 0');
            }
            console.log(`[PASS] 预算中断证书：${terminatedBy} · 上界 ${budget.bestComplete ?? '—'} · 下界 ${budget.lowerBound}`
                + ` · 缺口 ${budget.gap ?? '—'}（展开 ${budget.searchScope.statesExpanded} 状态 / ${budget.searchScope.elapsedMs}ms）`);
        } catch (error) {
            failures.push(error.message);
            console.log(`[FAIL] 预算中断证书：${error.message}`);
        }
    }

    // ---------- 场景校验 ----------
    const snapshotRows = [];
    console.log('=== 洗脉最优丹耗对拍 ===\n');
    for (const scenario of results) {
        const { label, failures: local, notes, cold } = verifyScenario(scenario);
        const bestRoute = cold.routes[0] || {};
        const row = {
            label,
            bestPills: cold.bestComplete,
            lowerBound: cold.lowerBound,
            gap: cold.gap,
            verifiedOptimal: cold.verifiedOptimal,
            terminatedBy: cold.searchScope.terminatedBy,
            totalWashes: Number(bestRoute.totalWashes || 0),
        };
        snapshotRows.push(row);
        failures.push(...local);
        if (local.length) {
            console.log(`[FAIL] ${label}`);
            local.forEach(message => console.log(`       ${message}`));
        } else {
            console.log(`[PASS] ${label}：最优 ${row.bestPills} 丹 · 下界 ${row.lowerBound} · 洗 ${row.totalWashes} 次 · ${row.terminatedBy}`
                + `（Stage B 展开 ${cold.searchScope.statesExpanded} 状态 / ${cold.searchScope.elapsedMs}ms）`);
            notes.forEach(message => console.log(`       note: ${message}`));
        }
    }

    // ---------- 快照对比 ----------
    const snapshotPayload = {
        description: '洗脉最优丹耗对拍快照：场景最优值（确定性种子构造，引擎逻辑不变则值稳定）',
        generatedAt: new Date().toISOString(),
        scenarios: snapshotRows,
    };
    if (UPDATE_SNAPSHOT) {
        writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshotPayload, null, 2)}\n`);
        console.log(`\n快照已写入 ${SNAPSHOT_FILE}`);
    } else if (existsSync(SNAPSHOT_FILE)) {
        const previous = JSON.parse(readFileSync(SNAPSHOT_FILE, 'utf8'));
        for (const row of snapshotRows) {
            const before = (previous.scenarios || []).find(item => item.label === row.label);
            if (!before) {
                failures.push(`快照缺失场景 ${row.label}（如属预期新增，请运行 --update）`);
                continue;
            }
            if (before.bestPills !== row.bestPills || before.lowerBound !== row.lowerBound || before.gap !== row.gap
                || before.verifiedOptimal !== row.verifiedOptimal || before.totalWashes !== row.totalWashes) {
                failures.push(`快照漂移 ${row.label}：`
                    + `bestPills ${before.bestPills}→${row.bestPills}, lowerBound ${before.lowerBound}→${row.lowerBound}, `
                    + `gap ${before.gap}→${row.gap}, totalWashes ${before.totalWashes}→${row.totalWashes}（如属预期，请运行 --update）`);
            }
        }
        if (!failures.length) console.log('\n快照对比：全部一致');
    } else {
        writeFileSync(SNAPSHOT_FILE, `${JSON.stringify(snapshotPayload, null, 2)}\n`);
        console.log(`\n首次运行：快照已生成 ${SNAPSHOT_FILE}（后续运行将与快照对比）`);
    }

    console.log('');
    if (failures.length) {
        console.log(`共 ${failures.length} 项失败，对拍未通过`);
        process.exitCode = 1;
    } else {
        console.log('全部场景通过，对拍通过');
    }
}

main().catch(error => {
    console.error(`[ERROR] ${error && error.stack ? error.stack : error}`);
    process.exitCode = 1;
});
