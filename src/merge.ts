import type { Cargo, ReviewPackage, StowageComment } from './api';

/** 合并冲突：同一提单 / 同一货位 / 同一条限制条件被两边改过且不一致。 */
export type MergeConflict = {
  id: string;
  kind: 'bill' | 'slot' | 'comment';
  status: 'open' | 'resolved';
  cargoId?: string;
  slotKey?: string;
  commentId?: string;
  localVersion?: Cargo;
  remoteVersion?: Cargo;
  localClaimant?: { cargoId: string; version: Cargo };
  remoteClaimant?: { cargoId: string; version: Cargo };
  localComment?: StowageComment;
  remoteComment?: StowageComment;
  resolution?: 'local' | 'remote';
  detail: string;
};

export type MergeResult = {
  cargo: Cargo[];
  comments: StowageComment[];
  conflicts: MergeConflict[];
  acceptedLimits: string[];
};

/** 货位标识：deck/bay/row/tier，用于判断“同一货位”。 */
export function slotKey(c: Cargo): string {
  return `${c.deck}|${c.bay}|${c.row}|${c.tier}`;
}

/** FNV-1a 哈希，输出 8 位十六进制，作为货位指纹。 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 货位指纹：仅由 deck/bay/row/tier 决定（即“货位指纹”）。 */
export function slotFingerprint(c: Cargo): string {
  return fnv1a(slotKey(c));
}

/** 逐票内容指纹：货位 + 绑扎，用于判断该票是否被修改。 */
function cargoFingerprint(c: Cargo): string {
  return fnv1a(`${slotKey(c)}|${c.lashing}`);
}

function changedSince(base: Cargo | undefined, current: Cargo | undefined): boolean {
  if (!current) return false;
  if (!base) return true;
  return cargoFingerprint(base) !== cargoFingerprint(current);
}

/**
 * 离线审阅包 3-way 合并：
 * 以包内 baseline 为共同祖先，逐票（按提单 id）比较船方草稿与码头草稿。
 * - 仅一边改过：采用该版；
 * - 两边都改且一致：采用该版；
 * - 两边都改且不一致：保留两版、列为冲突，货位暂持本地版（后导入不盖掉）；
 * - 两边把不同货物安排进同一货位：列为货位冲突；
 * - 同一条限制条件两边状态不一致：列为评论冲突；
 * - 已接受的限制条件若相关货位发生变化，退回“待确认”重新确认。
 */
export function mergeReviewPackage(
  localCargo: Cargo[],
  localBaseline: Cargo[],
  remotePkg: ReviewPackage,
  localComments: StowageComment[],
  localAcceptedLimits: string[]
): MergeResult {
  const remoteCargo = remotePkg.cargo ?? [];
  const ancestor = remotePkg.baseline && remotePkg.baseline.length ? remotePkg.baseline : localBaseline;

  const baseMap = new Map(ancestor.map((c) => [c.id, c]));
  const localMap = new Map(localCargo.map((c) => [c.id, c]));
  const remoteMap = new Map(remoteCargo.map((c) => [c.id, c]));
  const allIds = new Set<string>([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()]);

  const conflicts: MergeConflict[] = [];
  const mergedCargo: Cargo[] = [];
  const localSlotChanges = new Map<string, string>();
  const remoteSlotChanges = new Map<string, string>();

  allIds.forEach((id) => {
    const b = baseMap.get(id);
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    const lChanged = changedSince(b, l);
    const rChanged = changedSince(b, r);

    if (lChanged && rChanged) {
      if (l && r && cargoFingerprint(l) === cargoFingerprint(r)) {
        mergedCargo.push(l);
      } else {
        conflicts.push({
          id: `MC-bill-${id}`,
          kind: 'bill',
          status: 'open',
          cargoId: id,
          localVersion: l,
          remoteVersion: r,
          detail: `提单 ${(l ?? r)?.bill ?? id} 被船方与码头两边修改且不一致`,
        });
        mergedCargo.push(l ?? r ?? b!);
      }
    } else if (lChanged && l) {
      mergedCargo.push(l);
      if (b && slotKey(l) !== slotKey(b)) localSlotChanges.set(slotKey(l), id);
    } else if (rChanged && r) {
      mergedCargo.push(r);
      if (b && slotKey(r) !== slotKey(b)) remoteSlotChanges.set(slotKey(r), id);
    } else {
      mergedCargo.push(l ?? r ?? b!);
    }
  });

  // 同一货位被两边改过：两边把不同货物安排进同一槽位
  localSlotChanges.forEach((lCargoId, sKey) => {
    const rCargoId = remoteSlotChanges.get(sKey);
    if (rCargoId && rCargoId !== lCargoId) {
      const lVersion = localMap.get(lCargoId)!;
      const rVersion = remoteMap.get(rCargoId)!;
      conflicts.push({
        id: `MC-slot-${sKey}`,
        kind: 'slot',
        status: 'open',
        slotKey: sKey,
        localClaimant: { cargoId: lCargoId, version: lVersion },
        remoteClaimant: { cargoId: rCargoId, version: rVersion },
        detail: `货位 ${sKey} 被两边安排了不同货物（船方 ${lVersion.bill} / 码头 ${rVersion.bill}）`,
      });
      // 货位冲突未决前，暂不采用码头方对该槽位的安排，回退其基线货位
      const idx = mergedCargo.findIndex((c) => c.id === rCargoId);
      if (idx >= 0) mergedCargo[idx] = baseMap.get(rCargoId) ?? mergedCargo[idx];
    }
  });

  // 限制条件合并：同一条评论两边状态/内容不一致 → 冲突
  const remoteComments = remotePkg.comments ?? [];
  const mergedComments: StowageComment[] = [];
  const seen = new Set<string>();
  [...localComments, ...remoteComments].forEach((cm) => {
    if (seen.has(cm.id)) return;
    seen.add(cm.id);
    const lc = localComments.find((x) => x.id === cm.id);
    const rc = remoteComments.find((x) => x.id === cm.id);
    if (lc && rc && (lc.status !== rc.status || lc.content !== rc.content)) {
      conflicts.push({
        id: `MC-comment-${cm.id}`,
        kind: 'comment',
        status: 'open',
        commentId: cm.id,
        localComment: lc,
        remoteComment: rc,
        detail: `限制条件 ${cm.id} 两边状态不一致（船方 ${lc.status} / 码头 ${rc.status}）`,
      });
      mergedComments.push(lc);
    } else {
      mergedComments.push(lc ?? rc ?? cm);
    }
  });

  // 已接受的限制条件，若相关货位发生变化，退回“待确认”重新确认
  const changedSlotIds = new Set<string>();
  mergedCargo.forEach((c) => {
    const b = baseMap.get(c.id);
    if (b && slotKey(c) !== slotKey(b)) changedSlotIds.add(c.id);
  });
  const finalComments = mergedComments.map((cm) =>
    cm.status === '已接受' && changedSlotIds.has(cm.cargoId) ? { ...cm, status: '待确认' as const } : cm
  );

  const mergedAcceptedLimits = Array.from(new Set([...localAcceptedLimits, ...(remotePkg.acceptedLimits ?? [])]));

  return { cargo: mergedCargo, comments: finalComments, conflicts, acceptedLimits: mergedAcceptedLimits };
}

/** 按用户选择解决单个冲突，返回新的 cargo/comments/conflicts。 */
export function resolveConflict(
  conflicts: MergeConflict[],
  conflictId: string,
  resolution: 'local' | 'remote',
  cargo: Cargo[],
  comments: StowageComment[],
  baseline: Cargo[]
): { cargo: Cargo[]; comments: StowageComment[]; conflicts: MergeConflict[] } {
  const idx = conflicts.findIndex((c) => c.id === conflictId);
  if (idx < 0) return { cargo: cargo.slice(), comments: comments.slice(), conflicts: conflicts.slice() };
  const conflict = conflicts[idx];
  const nextCargo = cargo.slice();
  const nextComments = comments.slice();

  if (conflict.kind === 'bill' && conflict.cargoId) {
    const version = resolution === 'local' ? conflict.localVersion : conflict.remoteVersion;
    const i = nextCargo.findIndex((c) => c.id === conflict.cargoId);
    if (i >= 0 && version) nextCargo[i] = version;
  } else if (conflict.kind === 'slot' && conflict.localClaimant && conflict.remoteClaimant) {
    if (resolution === 'local') {
      const li = nextCargo.findIndex((c) => c.id === conflict.localClaimant!.cargoId);
      if (li >= 0) nextCargo[li] = conflict.localClaimant.version;
      const ri = nextCargo.findIndex((c) => c.id === conflict.remoteClaimant!.cargoId);
      if (ri >= 0) nextCargo[ri] = baseline.find((c) => c.id === conflict.remoteClaimant!.cargoId) ?? nextCargo[ri];
    } else {
      const ri = nextCargo.findIndex((c) => c.id === conflict.remoteClaimant!.cargoId);
      if (ri >= 0) nextCargo[ri] = conflict.remoteClaimant.version;
      const li = nextCargo.findIndex((c) => c.id === conflict.localClaimant!.cargoId);
      if (li >= 0) nextCargo[li] = baseline.find((c) => c.id === conflict.localClaimant!.cargoId) ?? nextCargo[li];
    }
  } else if (conflict.kind === 'comment' && conflict.commentId) {
    const version = resolution === 'local' ? conflict.localComment : conflict.remoteComment;
    const i = nextComments.findIndex((c) => c.id === conflict.commentId);
    if (i >= 0 && version) nextComments[i] = version;
  }

  const nextConflicts = conflicts.map((c) =>
    c.id === conflictId ? { ...c, status: 'resolved' as const, resolution } : c
  );
  return { cargo: nextCargo, comments: nextComments, conflicts: nextConflicts };
}

/** 从当前草稿构建离线审阅包（携带方案版本与逐票货位指纹）。 */
export function buildReviewPackage(
  state: {
    cargo: Cargo[];
    baseline: Cargo[];
    planRevision: number;
    baselineRevision: number;
    comments: StowageComment[];
    acceptedLimits: string[];
  },
  source: '船方' | '码头'
): ReviewPackage {
  const fingerprints: Record<string, string> = {};
  state.cargo.forEach((c) => {
    fingerprints[c.id] = slotFingerprint(c);
  });
  return {
    packageId: `PKG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    source,
    vessel: '海岳轮',
    voyageId: 'V-2609-17',
    planRevision: state.planRevision,
    exportedAt: new Date().toISOString(),
    baselineRevision: state.baselineRevision,
    baseline: state.baseline.map((c) => ({ ...c })),
    cargo: state.cargo.map((c) => ({ ...c })),
    fingerprints,
    comments: state.comments.map((c) => ({ ...c })),
    acceptedLimits: state.acceptedLimits.slice(),
  };
}

/** 校验审阅包基本结构，不合法时抛出错误（导入失败、可重试）。 */
export function validateReviewPackage(pkg: unknown): ReviewPackage {
  if (!pkg || typeof pkg !== 'object') throw new Error('审阅包内容不是有效 JSON 对象');
  const p = pkg as Partial<ReviewPackage>;
  if (!Array.isArray(p.cargo)) throw new Error('审阅包缺少 cargo（货物清单）');
  if (!Array.isArray(p.baseline)) throw new Error('审阅包缺少 baseline（对账基线）');
  if (typeof p.planRevision !== 'number') throw new Error('审阅包缺少 planRevision（方案版本）');
  if (!p.fingerprints || typeof p.fingerprints !== 'object') throw new Error('审阅包缺少 fingerprints（货位指纹）');
  return p as ReviewPackage;
}
