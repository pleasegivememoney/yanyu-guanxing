#!/usr/bin/env node
// 装备精炼「最高计算」对拍：以本地存档打造 碎月重刀 第 42 次、每属性精炼 300 次为例，
// 对比自动模拟里 analyzeRefinement 的贪心最高值 与 手动 buildXilianMaxPlan 的精确最高值。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { Buffer } from 'node:buffer';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SHARED = path.resolve(ROOT, 'web', 'shared');
const SAVE_DIR = path.resolve(ROOT, 'output', 'android-s11-胡萝卜', '20261008-130134');

function makeContext() {
    const sandbox = {
        console,
        setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
        TextEncoder, TextDecoder,
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        Buffer,
        location: { protocol: 'file:' },
        fetch: () => Promise.reject(new Error('no fetch')),
        Math,
        Date,
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    for (const file of ['sequence_rules.js', 'wasm_data.js', 'equip_data.js', 'core_glue.js', 'equip_auto_optimizer.js']) {
        vm.runInContext(readFileSync(path.join(SHARED, file), 'utf8'), sandbox, { filename: file });
    }
    return sandbox;
}

async function main() {
    const ctx = makeContext();
    const ok = await ctx.initWasm();
    if (!ok) throw new Error('WASM 加载失败');
    const EQUIP_DATA = ctx.EQUIP_DATA;
    if (!ctx.wasmMakeInitTables(EQUIP_DATA)) throw new Error('装备表注入失败');

    const save = JSON.parse(readFileSync(path.join(SAVE_DIR, 'dat.json'), 'utf8'));
    const meta = JSON.parse(readFileSync(path.join(SAVE_DIR, 'dat.meta.json'), 'utf8'));
    const makeRnd = save.MakeRnd || (Array.isArray(save) ? save[0].MakeRnd : null);
    const state = {
        save_version: meta.version || '',
        save_channel: meta.channel || meta.platform || '',
        Seeds: makeRnd.Seeds || {},
        LuckySeeds: makeRnd.LuckySeeds || {},
        IDSeeds: makeRnd.IDSeeds || {},
        MakeLucky: makeRnd.MakeLucky || {},
    };
    if (!ctx.wasmMakeSetState(state)) throw new Error('MakeRnd 注入失败');

    // 定位 碎月重刀 图纸 / 铁匠
    const targetName = '碎月重刀';
    const equipEntry = Object.values(EQUIP_DATA.equipment).find(e => e.name === targetName);
    if (!equipEntry) throw new Error(`装备表未找到 ${targetName}`);
    const paper = Object.values(EQUIP_DATA.papers).find(p => Number(p.dz_equip) === Number(equipEntry.id));
    console.log(`碎月重刀 equipId=${equipEntry.id} type=${equipEntry.type} lv=${equipEntry.lv} paper=${paper && paper.id}(${paper && paper.name}) exts=${Object.keys(equipEntry.exts || {}).join(',')}`);
    // 列出所有可打造该图纸的铁匠，逐个看第 42 次的颜色
    const npcList = Object.values(EQUIP_DATA.craftsman).filter(c =>
        ctx.EquipmentAutoOptimizer.papersForCraftsman(EQUIP_DATA, c.id).some(it => Number(it.paper.id) === Number(paper.id)),
    );
    console.log(`可打造铁匠 ${npcList.length} 个：${npcList.map(c => c.id + '(' + (c.place || c.name) + ')').join(', ')}`);

    const bridge = {
        getMakeState: () => ctx.wasmMakeGetState(),
        setMakeState: (next) => ctx.wasmMakeSetState(next),
        makePreview: (req, count) => ctx.wasmMakePreview(req, count),
        xilianPlan: (equip, accepts) => ctx.wasmXilianPlan(equip, accepts),
        xilianOnce: (equip) => ctx.wasmXilianOnce(equip),
    };

    for (const npc of npcList) {
        const req2 = ctx.EquipmentAutoOptimizer.buildMakeRequest({ npcId: npc.id, paperId: paper.id, specialId: 0 }, EQUIP_DATA);
        const resp2 = bridge.makePreview(req2, 42);
        bridge.setMakeState(JSON.parse(JSON.stringify(state)));
        const it42 = resp2.items[41];
        console.log(`  npc=${npc.id}(${npc.place || npc.name}) 第42次 color=${it42 && it42.color} exts=${JSON.stringify((it42 && it42.exts || []).map(e => e.prop || e.Key || e.key))}`);
    }
    const craftsmanId = npcList.find(n => n.id === 30950) || npcList[0];
    const req = ctx.EquipmentAutoOptimizer.buildMakeRequest({ npcId: craftsmanId.id, paperId: paper.id, specialId: 0 }, EQUIP_DATA);
    const REFINE = 300, SCAN = 42;
    const resp = bridge.makePreview(req, SCAN);
    bridge.setMakeState(JSON.parse(JSON.stringify(state)));
    console.log(`\n=== 铁匠 ${craftsmanId.id}(${craftsmanId.place || craftsmanId.name}) 逐次打造（仅统计蓝/紫装，精炼 ${REFINE} 次）===`);

    let mismatchCount = 0;
    for (const item of resp.items) {
        if (![3, 4].includes(Number(item.color))) continue;
        const rawEquip = ctx.EquipmentAutoOptimizer.makeResultToEquip(item, EQUIP_DATA, paper.id);
        const equip = ctx.EquipmentAutoOptimizer.upgradeEquip(rawEquip, EQUIP_DATA).equip;
        const props = ctx.EquipmentAutoOptimizer.supportedTargetProperties(EQUIP_DATA.equipment[String(rawEquip.id)], EQUIP_DATA, ctx.EquipmentAutoOptimizer.TARGET_PROPERTIES);
        const exact = buildXilianMaxPlan(ctx, equip, REFINE);
        for (const prop of props) {
            const greedy = ctx.EquipmentAutoOptimizer.analyzeRefinement(bridge, JSON.parse(JSON.stringify(equip)), prop, REFINE, EQUIP_DATA);
            const ex = exact(prop);
            const diff = (ex.total || 0) - (greedy.total || 0);
            if (diff > 1e-9) {
                mismatchCount++;
                console.log(`  第${String(item.index).padStart(3)}次 color=${item.color} ${prop.padEnd(11)} 贪心=${greedy.total} 精确=${ex.total} 差=${diff}`);
            }
        }
    }
    console.log(`\n共 ${mismatchCount} 处「贪心最高 < 精确最高」漏算。`);

    // 专项：第 42 次紫装，验证精确最高可通过真实 wasm 回放达成（确认非乐观估计）
    const it42b = resp.items[41];
    if (it42b && [3, 4].includes(Number(it42b.color))) {
        const raw42 = ctx.EquipmentAutoOptimizer.makeResultToEquip(it42b, EQUIP_DATA, paper.id);
        const eq42 = ctx.EquipmentAutoOptimizer.upgradeEquip(raw42, EQUIP_DATA).equip;
        const props42 = ctx.EquipmentAutoOptimizer.supportedTargetProperties(EQUIP_DATA.equipment[String(raw42.id)], EQUIP_DATA, ctx.EquipmentAutoOptimizer.TARGET_PROPERTIES);
        const exact42 = buildXilianMaxPlan(ctx, eq42, REFINE);
        console.log(`\n=== 第42次 color=${it42b.color} 逐属性：优化器(修复后) vs 手动精确 vs 优化器计划回放(真实wasm) ===`);
        for (const prop of props42) {
            const g = ctx.EquipmentAutoOptimizer.analyzeRefinement(bridge, JSON.parse(JSON.stringify(eq42)), prop, REFINE, EQUIP_DATA);
            const e = exact42(prop);
            // 用优化器自身给出的 accepts 计划回放，验证声明的最高值真实可达
            const acc = Array(REFINE).fill(false);
            (g.plan && g.plan.accepts || []).forEach(a => { if (a.index >= 1 && a.index <= REFINE) acc[a.index - 1] = true; });
            const rp = ctx.wasmXilianPlan(toWasmPlain(eq42), acc);
            const replayTotal = (rp.equip && rp.equip.exts || []).reduce((s, p) => s + ((p && p.prop === prop && Number.isFinite(Number(p.value))) ? Number(p.value) : 0), 0);
            console.log(`  ${prop.padEnd(11)} 优化器=${g.total} 精确=${e.total} 计划回放=${replayTotal} ${Math.abs(g.total - e.total) < 1e-9 && Math.abs(replayTotal - g.total) < 1e-9 ? '✓一致且可达' : '✗不一致'}`);
        }
    }
}

// 复刻 equip.js buildXilianMaxPlan，逐属性返回精确最高值与路径
function buildXilianMaxPlan(ctx, eq, count) {
    const toWasmEquip = ctx.EquipmentAutoOptimizer.__unused_toWasm || null;
    // 直接内联一份与 equip.js 一致的 toWasmEquip（optimizer 内部同名，此处独立实现）
    function toWasm(equip) {
        return {
            id: equip.id, only_id: equip.only_id || 0, name: equip.name, color: equip.color,
            level: equip.level || 0, lv_prop: equip.lv_prop || 0, S: equip.S || 0, CZSeed: equip.CZSeed,
            XLLevel: equip.XLLevel || 0, XLNumber: equip.XLNumber || 0, exts: JSON.parse(JSON.stringify(equip.exts || [])),
            xilian_accepted: (equip.xilian_marks || []).length, xilian_marks: JSON.parse(JSON.stringify(equip.xilian_marks || [])),
            need_lv: equip.need_lv || 0, typ: equip.typ || 0,
        };
    }
    const costMult = (m) => [1, 2, 4, 8][Math.min(3, Math.max(0, m))];
    const maskMult = (mask) => costMult(((mask & 1) ? 1 : 0) + ((mask & 2) ? 1 : 0) + ((mask & 4) ? 1 : 0));
    const markMask = (marks) => { let mask = 0; for (const r of marks || []) { const s = Number(r); if (s >= 1 && s <= 3) mask |= 1 << (s - 1); } return mask; };
    const targetValues = (exts, target, slotCount) => { const out = []; for (let i = 0; i < slotCount; i++) { const p = exts && exts[i]; out.push((p && (p.prop || p.Key || p.key) === target) ? Number(p.value != null ? p.value : p.Value) || 0 : 0); } return out; };

    return function (target) {
        const slotCount = Math.min(3, Math.max(1, eq.exts && eq.exts.length || 0));
        const initialXl = Number(eq.XLLevel) || 0;
        const initialMask = markMask(eq.xilian_marks || []);
        const initialValues = targetValues(eq.exts, target, slotCount);

        const seedBefore = [];
        let seedProbe = JSON.parse(JSON.stringify(toWasm(eq)));
        for (let i = 0; i < count; i++) {
            seedBefore.push(seedProbe.CZSeed);
            const once = ctx.wasmXilianOnce(seedProbe);
            if (once.error || !once.equip) throw new Error(once.error || `seed ${i}`);
            seedProbe = once.equip;
        }
        const offerCache = new Map();
        function offerAt(step, effectiveLevel) {
            const level = Math.min(100, effectiveLevel);
            const key = `${step}|${level}`;
            if (offerCache.has(key)) return offerCache.get(key);
            const probe = { ...toWasm(eq), CZSeed: seedBefore[step - 1], XLLevel: level, XLNumber: (Number(eq.XLNumber) || 0) + step - 1, xilian_marks: [], xilian_accepted: 0 };
            const once = ctx.wasmXilianOnce(probe);
            if (once.error || !once.result) throw new Error(once.error || `offer ${step}`);
            offerCache.set(key, once.result);
            return once.result;
        }
        const allMask = (1 << slotCount) - 1;
        const candidates = [];
        for (let addedMask = 0; addedMask <= allMask; addedMask++) {
            if (addedMask & initialMask) continue;
            const enabledMask = initialMask | addedMask;
            let mask = initialMask, xlLevel = initialXl;
            const values = initialValues.slice();
            const firstSteps = Array(slotCount).fill(0), bestSteps = Array(slotCount).fill(0);
            const xlAfter = Array(count + 1).fill(initialXl);
            for (let step = 1; step <= count; step++) {
                const offer = offerAt(step, xlLevel);
                xlLevel += maskMult(mask);
                xlAfter[step] = xlLevel;
                const slotIndex = Number(offer.slot) - 1;
                if (slotIndex < 0 || slotIndex >= slotCount || !(enabledMask & (1 << slotIndex))) continue;
                if (!(mask & (1 << slotIndex))) {
                    mask |= 1 << slotIndex;
                    firstSteps[slotIndex] = step;
                    values[slotIndex] = (offer.prop && offer.prop.prop === target) ? Number(offer.prop.value) || 0 : 0;
                    if (offer.prop && offer.prop.prop === target) bestSteps[slotIndex] = step;
                } else if (offer.prop && offer.prop.prop === target && Number(offer.prop.value) > values[slotIndex]) {
                    values[slotIndex] = Number(offer.prop.value);
                    bestSteps[slotIndex] = step;
                }
            }
            const stepSet = new Set([...firstSteps, ...bestSteps].filter(Boolean));
            const steps = [...stepSet].sort((a, b) => a - b);
            const lastStep = steps[steps.length - 1] || 0;
            candidates.push({ enabledMask, values, steps, keepCount: stepSet.size, lastStep, cutoffLianjin: lastStep ? xlAfter[lastStep] - initialXl : 0 });
        }
        candidates.sort((a, b) => {
            const ta = a.values.reduce((s, v) => s + v, 0), tb = b.values.reduce((s, v) => s + v, 0);
            if (Math.abs(ta - tb) > 1e-12) return tb - ta;
            if (a.cutoffLianjin !== b.cutoffLianjin) return a.cutoffLianjin - b.cutoffLianjin;
            if (a.lastStep !== b.lastStep) return a.lastStep - b.lastStep;
            return a.keepCount - b.keepCount;
        });
        const maxTotal = candidates[0].values.reduce((s, v) => s + v, 0);
        return { total: maxTotal, values: candidates[0].values, steps: candidates[0].steps };
    };
}

// 用真实 wasm xilian_plan 回放精确计划的 accepts，验证精确最高值确实可达
function verifyExact(ctx, equip, prop, count, steps) {
    const accepts = Array(count).fill(false);
    for (const s of steps) accepts[s - 1] = true;
    const wasmEq = ctx.EquipmentAutoOptimizer.makeWasmEquipForTest ? ctx.EquipmentAutoOptimizer.makeWasmEquipForTest(equip) : toWasmPlain(equip);
    const plan = ctx.wasmXilianPlan(wasmEq, accepts);
    if (plan.error || !plan.equip) throw new Error(plan.error || '回放失败');
    const exts = plan.equip.exts || [];
    return exts.reduce((sum, p) => sum + ((p && p.prop === prop && Number.isFinite(Number(p.value))) ? Number(p.value) : 0), 0);
}

function toWasmPlain(equip) {
    return {
        id: equip.id, only_id: equip.only_id || 0, name: equip.name, color: equip.color,
        level: equip.level || 0, lv_prop: equip.lv_prop || 0, S: equip.S || 0, CZSeed: equip.CZSeed,
        XLLevel: equip.XLLevel || 0, XLNumber: equip.XLNumber || 0, exts: JSON.parse(JSON.stringify(equip.exts || [])),
        xilian_accepted: (equip.xilian_marks || []).length, xilian_marks: JSON.parse(JSON.stringify(equip.xilian_marks || [])),
        need_lv: equip.need_lv || 0, typ: equip.typ || 0,
    };
}

main().catch(e => { console.error('[ERROR]', e && e.stack || e); process.exitCode = 1; });
