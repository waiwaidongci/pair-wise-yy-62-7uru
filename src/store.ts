import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { stowageApi, type Cargo, type CargoType } from './api';
import {
  buildReviewPackage,
  cargoSetFingerprint,
  FIELD_LABEL,
  formatFieldValue,
  mergeDrafts,
  parseReviewPackage,
  pendingConflictCount,
  slotFingerprint,
  slotKey,
  syncSlotConflicts,
  type DraftSide,
  type MergeConflict,
  type MergeField,
  type ReviewComment,
  type ReviewPackage
} from './merge';

export type StowageComment = ReviewComment;

export type ImportStatus = 'idle' | 'importing' | 'review' | 'failed';

export type ImportState = {
  status: ImportStatus;
  error: string | null;
  lastImportAt: string | null;
  pkgSummary: null | {
    planRevision: number;
    baseRevision: number;
    exportedAt: string;
    source: DraftSide;
    autoMerged: string[];
    addedComments: string[];
  };
};

type State = {
  cargo: Cargo[];
  activeCargoId: string;
  planRevision: number;
  baseRevision: number;
  baseCargo: Cargo[];
  baseCargoFingerprint: string;
  comments: StowageComment[];
  acceptedLimits: string[];
  locked: boolean;
  viewMode: '3d' | 'section';
  draftSavedAt: string;
  conflicts: MergeConflict[];
  importState: ImportState;
};

const initialCargo: Cargo[] = [
  { id: 'BL-88214', bill: 'SEA-88214', type: '集装箱', bay: 12, row: 4, tier: 2, deck: '主甲板', weight: 24.6, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '已绑扎', color: '#2b7c75' },
  { id: 'BL-88219', bill: 'SEA-88219', type: '集装箱', bay: 13, row: 4, tier: 2, deck: '主甲板', weight: 28.1, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: 'UN 1263', lashing: '需复核', color: '#c77835' },
  { id: 'BL-88231', bill: 'SEA-88231', type: '集装箱', bay: 10, row: 6, tier: 1, deck: '主甲板', weight: 18.2, dimension: '20 × 8 × 8.6 ft', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#366d94' },
  { id: 'BL-88240', bill: 'SEA-88240', type: '集装箱', bay: 8, row: 2, tier: 2, deck: '货舱', weight: 31.4, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '待绑扎', color: '#6d528d' },
  { id: 'BL-88247', bill: 'SEA-88247', type: '重大件', bay: 15, row: 0, tier: 1, deck: '主甲板', weight: 112.5, dimension: '18.4 × 4.2 × 4.8 m', port: '温哥华', hazmat: '无', lashing: '需复核', color: '#b64f49' },
  { id: 'BL-88254', bill: 'SEA-88254', type: '散货', bay: 5, row: 0, tier: 0, deck: '货舱', weight: 286.0, dimension: '散装 / 420 m³', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#9a7836' }
];

const VOYAGE_ID = 'V-2609-17';
const VESSEL = '海岳轮';

function nowLabel() {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function baseCargoSeed(): Cargo[] {
  // V4 基线：离港前船、码头各持一份的共同祖先版本
  return [
    { ...initialCargo[0] },
    { ...initialCargo[1], bay: 12, lashing: '待绑扎' },
    { ...initialCargo[2] },
    { ...initialCargo[3], tier: 1 },
    { ...initialCargo[4], bay: 14, row: 1 },
    { ...initialCargo[5] }
  ];
}

function freshState(): State {
  const baseCargo = baseCargoSeed();
  return {
    cargo: initialCargo.map((c) => ({ ...c })),
    activeCargoId: 'BL-88247',
    planRevision: 5,
    baseRevision: 4,
    baseCargo,
    baseCargoFingerprint: cargoSetFingerprint(baseCargo),
    comments: [
      { id: 'CM-21', cargoId: 'BL-88219', author: '港方配载', role: '码头', content: '危险品箱与船员生活区保持隔离，请在最终图中标注危险品隔离线。', status: '待确认', source: 'terminal' },
      { id: 'CM-22', cargoId: 'BL-88247', author: '周船长', role: '船长', content: '重大件横向支撑需增加两组绑扎点，检查甲板局部强度。', status: '待确认', source: 'ship' },
      { id: 'CM-23', cargoId: 'BL-88254', author: '货主代表', role: '货主', content: '釜山港卸货前不得覆盖散货舱口，已接受当前安排。', status: '已接受', source: 'terminal', acceptedFingerprint: slotFingerprint({ ...initialCargo[5] }) }
    ],
    acceptedLimits: [],
    locked: false,
    viewMode: '3d',
    draftSavedAt: '09:52',
    conflicts: [],
    importState: { status: 'idle', error: null, lastImportAt: null, pkgSummary: null }
  };
}

const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy62-stowage-plan') : null;
let initialState: State;
if (raw) {
  try {
    const parsed = JSON.parse(raw) as Partial<State>;
    const fallback = freshState();
    initialState = {
      ...fallback,
      ...parsed,
      // 旧版本本地缓存补齐新增字段
      baseRevision: parsed.baseRevision ?? fallback.baseRevision,
      baseCargo: parsed.baseCargo ?? fallback.baseCargo,
      baseCargoFingerprint: parsed.baseCargoFingerprint ?? fallback.baseCargoFingerprint,
      comments: (parsed.comments ?? fallback.comments).map((c) => ({
        ...c,
        source: c.source ?? 'ship',
        status: c.status === '已接受' || c.status === '已退回' || c.status === '需重新确认' ? c.status : '待确认'
      })) as StowageComment[],
      conflicts: parsed.conflicts ?? [],
      importState: parsed.importState ?? fallback.importState
    };
  } catch {
    initialState = freshState();
  }
} else {
  initialState = freshState();
}

function touchDraft(state: State) {
  state.planRevision += 1;
  state.draftSavedAt = nowLabel();
  // 本地编辑后重扫货位冲突（如解除同货位占用自动关闭）
  state.comments.forEach((comment) => {
    if (comment.status !== '已接受' || !comment.acceptedFingerprint) return;
    const related = state.cargo.find((c) => c.id === comment.cargoId);
    if (related && slotFingerprint(related) !== comment.acceptedFingerprint) comment.status = '需重新确认';
  });
  state.conflicts = syncSlotConflicts(state.cargo, state.baseCargo, state.conflicts, nowLabel());
}

const slice = createSlice({
  name: 'stowage',
  initialState,
  reducers: {
    selectCargo(state, action: PayloadAction<string>) { state.activeCargoId = action.payload; },
    moveCargo(state, action: PayloadAction<{ id: string; bay: number; row: number; tier: number }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (!cargo) return;
      const { bay, row, tier } = action.payload;
      if (cargo.bay === bay && cargo.row === row && cargo.tier === tier) return;
      Object.assign(cargo, { bay, row, tier });
      touchDraft(state);
    },
    updateLashing(state, action: PayloadAction<{ id: string; lashing: Cargo['lashing'] }>) {
      const cargo = state.cargo.find((item) => item.id === action.payload.id);
      if (!cargo || cargo.lashing === action.payload.lashing) return;
      cargo.lashing = action.payload.lashing;
      touchDraft(state);
    },
    addComment(state, action: PayloadAction<{ cargoId: string; author: string; role: StowageComment['role']; content: string }>) {
      state.comments.unshift({ ...action.payload, id: `CM-${Date.now()}`, status: '待确认', source: 'ship' });
      touchDraft(state);
    },
    acceptComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload);
      if (!comment || comment.status === '已接受') return;
      const related = state.cargo.find((c) => c.id === comment.cargoId);
      comment.status = '已接受';
      // 记录接受瞬间的货位指纹，之后货位一变就要重新确认
      comment.acceptedFingerprint = related ? slotFingerprint(related) : undefined;
    },
    rejectComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload);
      if (comment) comment.status = '已退回';
    },
    acceptLimit(state, action: PayloadAction<string>) {
      if (!state.acceptedLimits.includes(action.payload)) state.acceptedLimits.push(action.payload);
    },
    setViewMode(state, action: PayloadAction<'3d' | 'section'>) { state.viewMode = action.payload; },
    lockPlan(state) {
      if (pendingConflictCount(state.conflicts) > 0) return; // 冲突没处理完不能锁定
      state.locked = true;
      state.planRevision += 1;
      // 锁定后当前版本成为新的对账基线
      state.baseRevision = state.planRevision;
      state.baseCargo = state.cargo.map((c) => ({ ...c }));
      state.baseCargoFingerprint = cargoSetFingerprint(state.baseCargo);
      state.conflicts = [];
      state.importState = { status: 'idle', error: null, lastImportAt: nowLabel(), pkgSummary: null };
    },
    // ---- 离线合并 -------------------------------------------------------
    startImport(state) {
      state.importState = { ...state.importState, status: 'importing', error: null };
    },
    failImport(state, action: PayloadAction<string>) {
      // 导入失败：原草稿与既有冲突原样保留，仅记录失败原因供重试
      state.importState = { ...state.importState, status: 'failed', error: action.payload };
    },
    dismissImportError(state) {
      state.importState = { ...state.importState, status: 'idle', error: null };
    },
    applyImport(state, action: PayloadAction<{ raw: string }>) {
      const parsed = parseReviewPackage(action.payload.raw);
      if (!parsed.ok) {
        state.importState = { ...state.importState, status: 'failed', error: parsed.error };
        return;
      }
      const result = mergeDrafts({
        voyageId: VOYAGE_ID,
        local: state.cargo,
        localComments: state.comments,
        base: state.baseCargo,
        pkg: parsed.pkg,
        now: nowLabel()
      });
      if (!result.ok || !result.cargo || !result.comments || !result.conflicts || !result.report) {
        state.importState = { ...state.importState, status: 'failed', error: result.error ?? '合并失败，草稿保持不变。' };
        return;
      }
      state.cargo = result.cargo;
      state.comments = result.comments;
      state.conflicts = result.conflicts;
      state.planRevision += 1;
      state.draftSavedAt = nowLabel();
      if (typeof localStorage !== 'undefined') {
        try { localStorage.setItem(PACKAGE_STORE_KEY, JSON.stringify(parsed.pkg)); } catch { /* 快照仅用于解决冲突时取码头版取值，写失败不影响导入 */ }
      }
      state.importState = {
        status: 'review',
        error: null,
        lastImportAt: nowLabel(),
        pkgSummary: {
          planRevision: parsed.pkg.planRevision,
          baseRevision: parsed.pkg.baseRevision,
          exportedAt: parsed.pkg.exportedAt,
          source: parsed.pkg.source,
          autoMerged: result.report.autoMerged,
          addedComments: result.report.addedComments
        }
      };
    },
    resolveBillConflict(state, action: PayloadAction<{ id: string; side: DraftSide | 'base' }>) {
      const conflict = state.conflicts.find((c) => c.id === action.payload.id);
      if (!conflict || conflict.kind !== 'bill' || conflict.status !== '待处理') return;
      const cargo = state.cargo.find((c) => c.bill === conflict.bill);
      if (!cargo) return;
      const pkg = lastPackageSnapshot();
      const incomingMap = new Map((pkg?.cargo ?? []).map((c) => [c.bill, c]));
      const baseMap = new Map(state.baseCargo.map((c) => [c.bill, c]));

      conflict.fields.forEach((fv) => {
        let value: string | number | undefined;
        if (action.payload.side === 'base') value = baseMap.get(conflict.bill)?.[fv.field];
        else if (action.payload.side === 'terminal') value = incomingMap.get(conflict.bill)?.[fv.field];
        else value = fv.local; // 船端现值
        if (value !== undefined) (cargo as Record<string, unknown>)[fv.field] = value;
      });
      conflict.status = '已解决';
      conflict.resolution = { side: action.payload.side, at: nowLabel(), note: resolveNote(conflict, action.payload.side) };
      touchDraft(state);
    },
    resolveSlotConflict(state, action: PayloadAction<{ id: string; keepBill: string }>) {
      const conflict = state.conflicts.find((c) => c.id === action.payload.id);
      if (!conflict || conflict.kind !== 'slot' || conflict.status !== '待处理' || !conflict.slotKey) return;
      const keep = state.cargo.find((c) => c.bill === action.payload.keepBill);
      if (!keep) return;
      // 其余票退回各自基线货位（基线缺失时保持原位但标记，由后续票冲突承接）
      state.cargo.forEach((c) => {
        if (c.id === keep.id || slotKey(c) !== conflict.slotKey) return;
        const baseline = state.baseCargo.find((b) => b.id === c.id);
        if (baseline) Object.assign(c, { deck: baseline.deck, bay: baseline.bay, row: baseline.row, tier: baseline.tier });
      });
      conflict.status = '已解决';
      conflict.resolution = { side: 'auto', bill: keep.bill, at: nowLabel(), note: `货位保留 ${keep.bill}，其余票退回基线货位` };
      touchDraft(state);
    },
    clearResolvedConflicts(state) {
      state.conflicts = state.conflicts.filter((c) => c.status === '待处理');
      if (pendingConflictCount(state.conflicts) === 0) {
        state.importState = { ...state.importState, status: 'idle' };
      }
    }
  }
});

function resolveNote(conflict: MergeConflict, side: DraftSide | 'base') {
  const parts = conflict.fields.map((f) => {
    const v = side === 'ship' ? f.local : side === 'terminal' ? f.incoming : f.base;
    return `${FIELD_LABEL[f.field]}=${formatFieldValue(f.field, v)}`;
  });
  const label = side === 'ship' ? '船端版' : side === 'terminal' ? '码头版' : '共同基线';
  return `采用${label}（${parts.join('，')}）`;
}

// 最近导入审阅包的快照：解决冲突选“码头版”时取值用
const PACKAGE_STORE_KEY = 'yy62-last-review-package';
function lastPackageSnapshot(): ReviewPackage | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const rawPkg = localStorage.getItem(PACKAGE_STORE_KEY);
    return rawPkg ? (JSON.parse(rawPkg) as ReviewPackage) : null;
  } catch {
    return null;
  }
}

export const {
  selectCargo,
  moveCargo,
  updateLashing,
  addComment,
  acceptComment,
  rejectComment,
  acceptLimit,
  setViewMode,
  lockPlan,
  startImport,
  failImport,
  dismissImportError,
  applyImport,
  resolveBillConflict,
  resolveSlotConflict,
  clearResolvedConflicts
} = slice.actions;

export const store = configureStore({
  reducer: { stowage: slice.reducer, [stowageApi.reducerPath]: stowageApi.reducer },
  middleware: (getDefault) => getDefault().concat(stowageApi.middleware)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('yy62-stowage-plan', JSON.stringify(store.getState().stowage));
});

/** 导出本方离线审阅包（船端/码头同构，网络恢复后对账）。 */
export function exportReviewPackage(source: DraftSide, exportedAt = new Date().toLocaleString('zh-CN', { hour12: false })) {
  const state = store.getState().stowage;
  const pkg = buildReviewPackage({
    voyageId: VOYAGE_ID,
    vessel: VESSEL,
    planRevision: state.planRevision,
    baseRevision: state.baseRevision,
    baseCargoFingerprint: state.baseCargoFingerprint,
    cargo: state.cargo,
    comments: state.comments,
    source,
    exportedAt
  });
  return JSON.stringify(pkg, null, 2);
}

export { PACKAGE_STORE_KEY };
export type { MergeField, ReviewPackage };

export type RootState = ReturnType<typeof store.getState>;

export function calculateStability(cargo: Cargo[]) {
  const total = cargo.reduce((sum, item) => sum + item.weight, 0);
  const longitudinal = cargo.reduce((sum, item) => sum + item.weight * item.bay, 0) / Math.max(total, 1);
  const vertical = cargo.reduce((sum, item) => sum + item.weight * (item.tier + 1), 0) / Math.max(total, 1);
  const deckLoad = cargo.filter((item) => item.deck === '主甲板').reduce((sum, item) => sum + item.weight, 0);
  const stability = Math.max(0, 92 - Math.abs(longitudinal - 10.8) * 2.2 - Math.max(0, vertical - 1.75) * 8);
  return {
    total,
    longitudinal,
    vertical,
    deckLoad,
    stability,
    trim: (longitudinal - 10.8) < -0.4 ? '艉倾' : (longitudinal - 10.8) > 0.4 ? '艏倾' : '正平'
  };
}

export function detectConflicts(cargo: Cargo[]) {
  const issues: { id: string; cargoId: string; level: 'high' | 'medium'; title: string; detail: string }[] = [];
  const slots = new Map<string, Cargo>();
  cargo.forEach((item) => {
    const key = `${item.deck}-${item.bay}-${item.row}-${item.tier}`;
    const existing = slots.get(key);
    if (existing) issues.push({ id: `${item.id}-overlap`, cargoId: item.id, level: 'high', title: '货位重叠', detail: `${item.id} 与 ${existing.id} 占用相同二维货位。` });
    slots.set(key, item);
    if (item.hazmat !== '无' && item.deck === '主甲板' && item.row <= 1) issues.push({ id: `${item.id}-hazmat`, cargoId: item.id, level: 'high', title: '危险品隔离不足', detail: `${item.id} 与船体边界距离小于方案要求。` });
    if (item.weight > 100 && item.lashing !== '已绑扎') issues.push({ id: `${item.id}-lashing`, cargoId: item.id, level: 'medium', title: '重大件绑扎未完成', detail: `${item.id} 重量 ${item.weight}t，绑扎状态为“${item.lashing}”。` });
    if (item.type === '集装箱' && item.weight > 30 && item.tier >= 3) issues.push({ id: `${item.id}-stack`, cargoId: item.id, level: 'medium', title: '上层堆重超限', detail: `${item.id} 不应放在第 ${item.tier} 层。` });
  });
  return issues;
}

export type { CargoType };
