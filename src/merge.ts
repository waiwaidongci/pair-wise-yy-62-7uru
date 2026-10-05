import type { Cargo } from './api';

// 离线草稿三方合并：船端（本地）/ 码头（审阅包）以共同基线版本为祖先逐票合并。
// 只对“货位”和“绑扎”做字段级对账；其他属性不参与覆盖，避免后导入的草稿盖掉本地修改。

export type DraftSide = 'ship' | 'terminal';
export type CommentStatus = '待确认' | '已接受' | '已退回' | '需重新确认';

export type ReviewComment = {
  id: string;
  cargoId: string;
  author: string;
  role: '船长' | '码头' | '货主';
  content: string;
  status: CommentStatus;
  source?: DraftSide;
  // 接受该限制条件时相关货位的指纹；货位一变即失效，需要重新确认
  acceptedFingerprint?: string;
};

export const SLOT_FIELDS = ['deck', 'bay', 'row', 'tier'] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];
export type MergeField = SlotField | 'lashing';
export const MERGE_FIELDS: MergeField[] = [...SLOT_FIELDS, 'lashing'];

export type FieldVersion = {
  field: MergeField;
  base?: string | number;
  local?: string | number;
  incoming?: string | number;
};

export type SlotMember = {
  bill: string;
  cargoId: string;
  changedBy: DraftSide | 'both';
  slot: string;
};

export type MergeConflict = {
  id: string;
  kind: 'bill' | 'slot';
  bill: string;
  cargoId: string;
  slotKey?: string;
  fields: FieldVersion[];
  members?: SlotMember[];
  detail: string;
  status: '待处理' | '已解决';
  resolution?: { side: DraftSide | 'base' | 'auto'; bill?: string; at: string; note?: string };
};

export type ReviewPackage = {
  packageVersion: 1;
  voyageId: string;
  vessel: string;
  planRevision: number;
  baseRevision: number;
  exportedAt: string;
  source: DraftSide;
  baseCargoFingerprint: string;
  fingerprints: Record<string, { slot: string; lashing: string }>;
  cargo: Cargo[];
  comments: ReviewComment[];
};

export type MergeReport = {
  autoMerged: string[];
  addedComments: string[];
  conflicts: number;
};

export type MergeResult = {
  ok: boolean;
  error?: string;
  cargo?: Cargo[];
  comments?: ReviewComment[];
  conflicts?: MergeConflict[];
  pkg?: ReviewPackage;
  report?: MergeReport;
};

// ---- 指纹 ----------------------------------------------------------------

function djb2(input: string) {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

export function slotFingerprint(cargo: Cargo) {
  return djb2([cargo.deck, cargo.bay, cargo.row, cargo.tier].join('|'));
}

export function lashingFingerprint(cargo: Cargo) {
  return djb2(cargo.lashing);
}

export function cargoSetFingerprint(cargo: Cargo[]) {
  const canonical = [...cargo]
    .map((item) => ({ id: item.id, bill: item.bill, deck: item.deck, bay: item.bay, row: item.row, tier: item.tier, lashing: item.lashing }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return djb2(JSON.stringify(canonical));
}

export function slotKey(cargo: Pick<Cargo, SlotField>) {
  return `${cargo.deck}-${cargo.bay}-${cargo.row}-${cargo.tier}`;
}

export function slotLabel(cargo: Pick<Cargo, SlotField>) {
  return `${cargo.deck === '主甲板' ? '主甲板' : '货舱'} Bay ${cargo.bay} / Row ${cargo.row} / Tier ${cargo.tier}`;
}

export const FIELD_LABEL: Record<MergeField, string> = {
  deck: '甲板',
  bay: 'Bay',
  row: 'Row',
  tier: 'Tier',
  lashing: '绑扎'
};

export function formatFieldValue(field: MergeField, value: string | number | undefined) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

// ---- 审阅包 ---------------------------------------------------------------

function isValidCargoShape(item: unknown): item is Cargo {
  if (!item || typeof item !== 'object') return false;
  const c = item as Record<string, unknown>;
  return typeof c.id === 'string' && typeof c.bill === 'string' &&
    (c.deck === '主甲板' || c.deck === '货舱') &&
    ['bay', 'row', 'tier', 'weight'].every((k) => typeof c[k] === 'number' && Number.isFinite(c[k] as number)) &&
    ['已绑扎', '待绑扎', '需复核'].includes(c.lashing as string);
}

function normalizeComment(raw: unknown, fallbackSource: DraftSide): ReviewComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.id !== 'string' || typeof c.cargoId !== 'string' || typeof c.content !== 'string') return null;
  const role = ['船长', '码头', '货主'].includes(c.role as string) ? c.role as ReviewComment['role'] : '码头';
  const status = ['待确认', '已接受', '已退回', '需重新确认'].includes(c.status as string) ? c.status as CommentStatus : '待确认';
  return {
    id: c.id,
    cargoId: c.cargoId,
    author: typeof c.author === 'string' ? c.author : '未知',
    role,
    content: c.content,
    status,
    source: (c.source === 'ship' || c.source === 'terminal') ? c.source : fallbackSource,
    acceptedFingerprint: typeof c.acceptedFingerprint === 'string' ? c.acceptedFingerprint : undefined
  };
}

export function parseReviewPackage(raw: string): { ok: true; pkg: ReviewPackage } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: '审阅包不是合法的 JSON，可能传输不完整，请重新导出后重试。' };
  }
  const obj = parsed as Partial<ReviewPackage> | null;
  if (!obj || typeof obj !== 'object') return { ok: false, error: '审阅包结构为空，无法读取。' };
  if (obj.packageVersion !== 1) return { ok: false, error: `不支持的审阅包版本（${String(obj.packageVersion)}），请双方升级到同一版本后重试。` };
  if (!obj.voyageId || typeof obj.voyageId !== 'string') return { ok: false, error: '审阅包缺少航次编号。' };
  if (typeof obj.planRevision !== 'number' || typeof obj.baseRevision !== 'number') return { ok: false, error: '审阅包缺少方案版本或基线版本号。' };
  if (!Array.isArray(obj.cargo) || obj.cargo.length === 0) return { ok: false, error: '审阅包内没有货位数据。' };
  if (!obj.cargo.every(isValidCargoShape)) return { ok: false, error: '审阅包货位数据字段缺失或越界，已中止导入。' };
  if (!Array.isArray(obj.comments)) return { ok: false, error: '审阅包缺少角色限制条件清单。' };

  const cargo = obj.cargo as Cargo[];
  const fingerprints = (obj.fingerprints ?? {}) as Record<string, { slot: string; lashing: string }>;
  for (const item of cargo) {
    const carried = fingerprints[item.id];
    if (!carried || typeof carried.slot !== 'string' || typeof carried.lashing !== 'string') {
      return { ok: false, error: `提单 ${item.bill} 缺少货位指纹，无法确认数据完整性。` };
    }
    if (carried.slot !== slotFingerprint(item) || carried.lashing !== lashingFingerprint(item)) {
      return { ok: false, error: `提单 ${item.bill} 的货位指纹与包内数据不一致，包可能被改动或损坏，已中止导入。` };
    }
  }

  const comments = obj.comments
    .map((c) => normalizeComment(c, obj.source === 'ship' ? 'ship' : 'terminal'))
    .filter((c): c is ReviewComment => c !== null);

  return {
    ok: true,
    pkg: {
      packageVersion: 1,
      voyageId: obj.voyageId,
      vessel: typeof obj.vessel === 'string' ? obj.vessel : '',
      planRevision: obj.planRevision,
      baseRevision: obj.baseRevision,
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : '',
      source: obj.source === 'ship' ? 'ship' : 'terminal',
      baseCargoFingerprint: typeof obj.baseCargoFingerprint === 'string' ? obj.baseCargoFingerprint : '',
      fingerprints,
      cargo,
      comments
    }
  };
}

export function buildReviewPackage(input: {
  voyageId: string;
  vessel: string;
  planRevision: number;
  baseRevision: number;
  baseCargoFingerprint: string;
  cargo: Cargo[];
  comments: ReviewComment[];
  source: DraftSide;
  exportedAt: string;
}): ReviewPackage {
  return {
    packageVersion: 1,
    voyageId: input.voyageId,
    vessel: input.vessel,
    planRevision: input.planRevision,
    baseRevision: input.baseRevision,
    exportedAt: input.exportedAt,
    source: input.source,
    baseCargoFingerprint: input.baseCargoFingerprint,
    fingerprints: Object.fromEntries(input.cargo.map((c) => [c.id, { slot: slotFingerprint(c), lashing: lashingFingerprint(c) }])),
    cargo: input.cargo.map((c) => ({ ...c })),
    comments: input.comments.map((c) => ({ ...c }))
  };
}

// ---- 三方合并 -------------------------------------------------------------

function changedBySide(base: Cargo | undefined, local: Cargo | undefined, incoming: Cargo | undefined, field: MergeField) {
  const bv = base?.[field];
  const lv = local?.[field];
  const iv = incoming?.[field];
  const localChanged = local !== undefined && lv !== bv;
  const incomingChanged = incoming !== undefined && iv !== bv;
  return { bv, lv, iv, localChanged, incomingChanged };
}

/** 已接受的限制条件：相关货位指纹变化时一律转“需重新确认”。 */
export function invalidateAcceptedComments(comments: ReviewComment[], cargo: Cargo[]) {
  const byId = new Map(cargo.map((c) => [c.id, c]));
  comments.forEach((comment) => {
    if (comment.status !== '已接受' || !comment.acceptedFingerprint) return;
    const related = byId.get(comment.cargoId);
    if (related && slotFingerprint(related) !== comment.acceptedFingerprint) comment.status = '需重新确认';
  });
}

/** 根据当前货位重新核对“货位被两边各放一票”类冲突：解除的自动关闭，新产生的补登。 */
export function syncSlotConflicts(cargo: Cargo[], base: Cargo[], conflicts: MergeConflict[], at: string): MergeConflict[] {
  const next = conflicts.map((c) => ({ ...c, fields: c.fields.map((f) => ({ ...f })), members: c.members?.map((m) => ({ ...m })) }));
  const occupancy = new Map<string, Cargo[]>();
  cargo.forEach((item) => {
    const key = slotKey(item);
    const list = occupancy.get(key) ?? [];
    list.push(item);
    occupancy.set(key, list);
  });

  next.forEach((conflict) => {
    if (conflict.kind !== 'slot' || !conflict.slotKey) return;
    const members = occupancy.get(conflict.slotKey) ?? [];
    if (members.length <= 1 && conflict.status === '待处理') {
      conflict.status = '已解决';
      conflict.resolution = { side: 'auto', at, note: '关联货位冲突解除，本项自动关闭' };
      return;
    }
    if (members.length >= 2) {
      conflict.members = members.map((m) => {
        const previous = conflict.members?.find((p) => p.cargoId === m.id);
        const baseRec = base.find((b) => b.bill === m.bill);
        const changedBy: DraftSide | 'both' = previous?.changedBy ?? (baseRec && slotKey(baseRec) !== slotKey(m) ? 'terminal' : 'both');
        return { bill: m.bill, cargoId: m.id, changedBy, slot: slotLabel(m) };
      });
      conflict.detail = buildSlotDetail(members);
    }
  });

  next
    .filter((c) => c.kind === 'slot' && c.status === '待处理')
    .forEach((c) => {
      const members = occupancy.get(c.slotKey!) ?? [];
      if (members.length <= 1) {
        c.status = '已解决';
        c.resolution = { side: 'auto', at, note: '关联货位冲突解除，本项自动关闭' };
      }
    });

  const tracked = new Set(next.filter((c) => c.kind === 'slot').map((c) => c.slotKey));
  occupancy.forEach((members, key) => {
    if (members.length <= 1 || tracked.has(key)) return;
    next.push({
      id: `CF-slot-${key}`,
      kind: 'slot',
      bill: members[0].bill,
      cargoId: members[0].id,
      slotKey: key,
      fields: SLOT_FIELDS.map((field) => ({ field })),
      // 导入后的本地编辑均发生在船端
      members: members.map((m) => ({ bill: m.bill, cargoId: m.id, changedBy: 'ship' as DraftSide, slot: slotLabel(m) })),
      detail: buildSlotDetail(members),
      status: '待处理'
    });
  });

  return next;
}

function buildSlotDetail(members: Cargo[]) {
  return `货位 ${slotLabel(members[0])} 同时被 ${members.map((m) => m.bill).join('、')} 占用，需要决定保留哪一票，其余退回基线货位。`;
}

function movedBy(member: Cargo, baseMap: Map<string, Cargo>, localMap: Map<string, Cargo>, incomingMap: Map<string, Cargo>): DraftSide | 'both' {
  const baseRec = baseMap.get(member.bill);
  const localRec = localMap.get(member.bill);
  const incomingRec = incomingMap.get(member.bill);
  const byShip = !!localRec && (!baseRec || slotKey(localRec) !== slotKey(baseRec));
  const byTerminal = !!incomingRec && (!baseRec || slotKey(incomingRec) !== slotKey(baseRec));
  if (byShip && byTerminal) return 'both';
  if (byShip) return 'ship';
  if (byTerminal) return 'terminal';
  return 'both';
}

function withSlotConflict(
  conflicts: MergeConflict[],
  key: string,
  members: Cargo[],
  baseMap: Map<string, Cargo>,
  localMap: Map<string, Cargo>,
  incomingMap: Map<string, Cargo>
) {
  if (conflicts.some((c) => c.kind === 'slot' && c.slotKey === key)) return;
  conflicts.push({
    id: `CF-slot-${key}`,
    kind: 'slot',
    bill: members[0].bill,
    cargoId: members[0].id,
    slotKey: key,
    fields: SLOT_FIELDS.map((field) => ({ field })),
    members: members.map((m) => ({ bill: m.bill, cargoId: m.id, changedBy: movedBy(m, baseMap, localMap, incomingMap), slot: slotLabel(m) })),
    detail: buildSlotDetail(members),
    status: '待处理'
  });
}

export type MergeInput = {
  voyageId: string;
  local: Cargo[];
  localComments: ReviewComment[];
  base: Cargo[];
  pkg: ReviewPackage;
  now: string;
};

export function mergeDrafts(input: MergeInput): MergeResult {
  const { voyageId, local, localComments, base, pkg, now } = input;

  if (pkg.voyageId !== voyageId) return { ok: false, error: `审阅包属于航次 ${pkg.voyageId}，与当前航次 ${voyageId} 不符，已中止导入。` };
  if (pkg.baseCargoFingerprint && cargoSetFingerprint(base) !== pkg.baseCargoFingerprint) {
    return { ok: false, error: `审阅包基线为 V${pkg.baseRevision}，与本地共同基线不一致（指纹不符），无法对账，请先同步基线。` };
  }

  const byBill = (list: Cargo[]) => new Map(list.map((c) => [c.bill, c]));
  const baseMap = byBill(base);
  const localMap = byBill(local);
  const incomingMap = byBill(pkg.cargo);
  const bills = Array.from(new Set([...baseMap.keys(), ...localMap.keys(), ...incomingMap.keys()])).sort();

  const merged: Cargo[] = [];
  const conflicts: MergeConflict[] = [];
  const autoMerged: string[] = [];

  bills.forEach((bill) => {
    const baseRec = baseMap.get(bill);
    const localRec = localMap.get(bill);
    const incomingRec = incomingMap.get(bill);
    // 新增票（基线没有）：单边直接收，两边都有且不同再按提单冲突处理
    if (!baseRec) {
      if (localRec && incomingRec) {
        const pending = MERGE_FIELDS.filter((field) => localRec[field] !== incomingRec[field])
          .map((field) => ({ field, local: localRec[field], incoming: incomingRec[field] }));
        merged.push({ ...localRec });
        if (pending.length) conflicts.push({
          id: `CF-bill-${bill}`, kind: 'bill', bill, cargoId: localRec.id,
          fields: pending, detail: `新票 ${bill} 船端与码头版本不一致。`, status: '待处理'
        });
        return;
      }
      merged.push({ ...(localRec ?? incomingRec)! });
      if (!localRec && incomingRec) autoMerged.push(bill);
      return;
    }

    const record: Cargo = { ...(localRec ?? incomingRec)! };
    const pending: FieldVersion[] = [];
    let localTouched = false;
    let incomingTouched = false;

    MERGE_FIELDS.forEach((field) => {
      const { bv, lv, iv, localChanged, incomingChanged } = changedBySide(baseRec, localRec, incomingRec, field);
      if (!localChanged && !incomingChanged) {
        record[field] = bv as never;
      } else if (localChanged && !incomingChanged) {
        record[field] = lv as never;
        localTouched = true;
      } else if (!localChanged && incomingChanged) {
        record[field] = iv as never;
        incomingTouched = true;
      } else if (lv === iv) {
        record[field] = lv as never;
        localTouched = true;
        incomingTouched = true;
      } else {
        // 两边都改且改得不同：保留船端现值占位，两版同时挂出冲突
        record[field] = lv as never;
        pending.push({ field, base: bv, local: lv, incoming: iv });
      }
    });

    if (pending.length) {
      conflicts.push({
        id: `CF-bill-${bill}`,
        kind: 'bill',
        bill,
        cargoId: record.id,
        fields: pending,
        detail: `提单 ${bill} 被船端和码头同时修改，已保留两版，逐项选择后生效。`,
        status: '待处理'
      });
    } else if (localTouched || incomingTouched) {
      autoMerged.push(bill);
    }
    merged.push(record);
  });

  // 货位冲突：单边自动合并后两票落到同一货位
  const occupancy = new Map<string, Cargo[]>();
  merged.forEach((item) => {
    const key = slotKey(item);
    const list = occupancy.get(key);
    if (list) list.push(item);
    else occupancy.set(key, [item]);
  });
  occupancy.forEach((members, key) => {
    if (members.length <= 1) return;
    withSlotConflict(conflicts, key, members, baseMap, localMap, incomingMap);
  });
  // 货位冲突：以当前货位重扫，解除的自动关闭、后续编辑新产生的补登
  const withSlot = syncSlotConflicts(merged, base, conflicts, now);

  // 角色限制条件按 id 并集；码头新增的意见进船端，状态以船端为准
  const comments: ReviewComment[] = localComments.map((c) => ({ ...c }));
  const known = new Set(comments.map((c) => c.id));
  const addedComments: string[] = [];
  pkg.comments.forEach((incoming) => {
    if (known.has(incoming.id)) return;
    comments.push({ ...incoming, source: incoming.source ?? 'terminal' });
    known.add(incoming.id);
    addedComments.push(incoming.id);
  });
  comments.forEach((c) => { if (!c.source) c.source = 'ship'; });
  // 无论限制来自哪一端，货位已经和接受时不同就要重新确认
  invalidateAcceptedComments(comments, merged);

  return {
    ok: true,
    cargo: merged,
    comments,
    conflicts: withSlot,
    pkg,
    report: { autoMerged, addedComments, conflicts: withSlot.filter((c) => c.status === '待处理').length }
  };
}

export function pendingConflictCount(conflicts: MergeConflict[]) {
  return conflicts.filter((c) => c.status === '待处理').length;
}
