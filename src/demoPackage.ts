import type { Cargo } from './api';
import { buildReviewPackage, slotFingerprint } from './merge';

// 演示用：基于船端共同基线 V4 构造一份“码头端”离线草稿，
// 覆盖同票两边同改、单边改、货位挤占、已接受限制失效四类场景。
export function buildTerminalDemoPackage(base: Cargo[], baseCargoFingerprint: string): string {
  const find = (id: string) => {
    const item = base.find((c) => c.id === id);
    if (!item) throw new Error(`演示基线缺少 ${id}`);
    return { ...item };
  };

  const c214 = find('BL-88214'); // 码头未改
  const c219 = find('BL-88219'); // 两边同改：船端 Bay13/需复核，码头 Bay14/已绑扎
  c219.bay = 14;
  c219.lashing = '已绑扎';
  const c231 = find('BL-88231'); // 码头单边改到 Bay12 Row4 Tier2，与 88214 同货位
  c231.bay = 12; c231.row = 4; c231.tier = 2;
  const c240 = find('BL-88240'); // 码头未改（船端单边提到 Tier2，自动取船端）
  const c247 = find('BL-88247'); // 两边同改：船端 Bay15/Row0，码头 Bay12/Row3
  c247.bay = 12; c247.row = 3;
  const c254 = find('BL-88254'); // 码头单边改散货货位 → CM-23 接受过的限制需重新确认
  c254.bay = 6;

  const acceptedAt = slotFingerprint(find('BL-88254'));
  void acceptedAt;

  const pkg = buildReviewPackage({
    voyageId: 'V-2609-17',
    vessel: '海岳轮',
    planRevision: 5,
    baseRevision: 4,
    baseCargoFingerprint,
    cargo: [c214, c219, c231, c240, c247, c254],
    comments: [
      { id: 'CM-21', cargoId: 'BL-88219', author: '港方配载', role: '码头', content: '危险品箱与船员生活区保持隔离，请在最终图中标注危险品隔离线。', status: '待确认', source: 'terminal' },
      { id: 'CM-23', cargoId: 'BL-88254', author: '货主代表', role: '货主', content: '釜山港卸货前不得覆盖散货舱口，已接受当前安排。', status: '已接受', source: 'terminal', acceptedFingerprint: slotFingerprint(base.find((c) => c.id === 'BL-88254')!) },
      { id: 'CM-31', cargoId: 'BL-88247', author: '港方配载', role: '码头', content: '码头岸吊作业半径要求重大件移至 Bay12 Row3，请船端复核绑扎方案。', status: '待确认', source: 'terminal' }
    ],
    source: 'terminal',
    exportedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  });
  return JSON.stringify(pkg, null, 2);
}
