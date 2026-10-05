import { useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  ScrollArea,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Tooltip
} from '@mantine/core';
import {
  IconAlertTriangle,
  IconCheck,
  IconCircleCheck,
  IconCloudUpload,
  IconDownload,
  IconFileExport,
  IconFileImport,
  IconInfoCircle,
  IconLock,
  IconRefresh,
  IconScale,
  IconUsers,
  IconX
} from '@tabler/icons-react';
import type { RootState } from './store';
import {
  acceptComment,
  applyImport,
  clearResolvedConflicts,
  dismissImportError,
  exportReviewPackage,
  failImport,
  rejectComment,
  resolveBillConflict,
  resolveSlotConflict,
  startImport
} from './store';
import {
  FIELD_LABEL,
  formatFieldValue,
  pendingConflictCount,
  type FieldVersion,
  type MergeConflict
} from './merge';
import { buildTerminalDemoPackage } from './demoPackage';
import { PageHeading } from './pageBits';

const SIDE_LABEL = { ship: '船端版', terminal: '码头版', base: '共同基线' } as const;

function downloadText(filename: string, text: string) {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ImportPanel() {
  const state = useSelector((root: RootState) => root.stowage);
  const dispatch = useDispatch();
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingRaw = useRef<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const runImport = (raw: string) => {
    dispatch(startImport());
    // 模拟网络恢复后审阅包上传过程；失败与否都不会改动原草稿
    window.setTimeout(() => dispatch(applyImport({ raw })), 450);
  };

  const readFile = (file: File) => {
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      pendingRaw.current = String(reader.result ?? '');
      runImport(pendingRaw.current);
    };
    reader.onerror = () => dispatch(failImport('文件读取失败，请重新选择审阅包（原草稿未改动）。'));
    reader.readAsText(file);
  };

  const imp = state.importState;
  const importing = imp.status === 'importing';

  return <Card padding="md">
    <div className="panel-title">
      <div><strong>导入对端审阅包</strong><Text size="xs" c="dimmed">网络恢复后导入，按提单逐票三方合并，不覆盖本端修改</Text></div>
      <IconFileImport size={18} />
    </div>
    <Stack gap="sm" mt="md">
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(event) => { const file = event.target.files?.[0]; if (file) readFile(file); event.target.value = ''; }}
      />
      <Group>
        <Button color="teal" leftSection={<IconCloudUpload size={16} />} loading={importing} onClick={() => fileRef.current?.click()}>选择审阅包导入</Button>
        <Button variant="default" leftSection={<IconDownload size={16} />}
          onClick={() => {
            const demo = buildTerminalDemoPackage(state.baseCargo, state.baseCargoFingerprint);
            downloadText(`haiyue-terminal-demo-V${state.planRevision}.json`, demo);
          }}>生成码头端演示包</Button>
      </Group>
      {fileName && imp.status !== 'failed' && <Text size="xs" c="dimmed">最近选择：{fileName}</Text>}

      {imp.status === 'failed' && <Alert color="red" icon={<IconAlertTriangle size={16} />} title="导入失败，原草稿与既有冲突均保留">
        <Stack gap={6} align="flex-start">
          <Text size="sm">{imp.error}</Text>
          <Group gap="xs">
            <Button size="xs" color="red" leftSection={<IconRefresh size={14} />}
              disabled={!pendingRaw.current}
              onClick={() => pendingRaw.current && runImport(pendingRaw.current)}>用同一审阅包重试</Button>
            <Button size="xs" variant="default" leftSection={<IconFileImport size={14} />} onClick={() => fileRef.current?.click()}>改选其他文件</Button>
            <Button size="xs" variant="subtle" color="gray" onClick={() => dispatch(dismissImportError())}>关闭提示</Button>
          </Group>
        </Stack>
      </Alert>}

      {imp.status === 'review' && imp.pkgSummary && <Alert color="teal" icon={<IconCircleCheck size={16} />} title="离线草稿已完成逐票合并">
        <Text size="sm">
          对端方案 V{imp.pkgSummary.planRevision}（基于共同基线 V{imp.pkgSummary.baseRevision}，{imp.pkgSummary.exportedAt || '时间未知'} 导出）已对账：
          自动合并 {imp.pkgSummary.autoMerged.length} 票，新增限制条件 {imp.pkgSummary.addedComments.length} 条，
          待处理冲突 {pendingConflictCount(state.conflicts)} 项。冲突全部处理完前方案不能锁定。
        </Text>
      </Alert>}

      {imp.status === 'idle' && !imp.pkgSummary && <Text size="xs" c="dimmed">支持导入船端 / 码头任一端导出的 JSON 审阅包；导入会先核对方案版本与每票货位指纹。</Text>}
    </Stack>
  </Card>;
}

function ExportPanel() {
  const state = useSelector((root: RootState) => root.stowage);
  return <Card padding="md">
    <div className="panel-title">
      <div><strong>导出本方审阅包</strong><Text size="xs" c="dimmed">离港前船、码头各留一份，离线期间各自修改</Text></div>
      <IconFileExport size={18} />
    </div>
    <Stack gap={8} mt="md">
      <SimpleGrid cols={2} spacing="xs">
        <div className="mini-stat"><span>本方方案版本</span><strong>V{state.planRevision}</strong></div>
        <div className="mini-stat"><span>共同基线版本</span><strong>V{state.baseRevision}</strong></div>
        <div className="mini-stat" style={{ gridColumn: '1 / -1' }}><span>货位指纹（基线集合）</span><strong style={{ fontFamily: 'monospace' }}>{state.baseCargoFingerprint}</strong></div>
      </SimpleGrid>
      <Button color="teal" variant="light" leftSection={<IconDownload size={16} />}
        onClick={() => downloadText(`haiyue-ship-review-V${state.planRevision}.json`, exportReviewPackage('ship'))}>导出船端审阅包（JSON）</Button>
      <Text size="xs" c="dimmed">包内含方案版本、基线版本、每票货位 / 绑扎指纹及角色限制条件，导入端会先验指纹再逐票合并。</Text>
    </Stack>
  </Card>;
}

function FieldDiffRow({ fv }: { fv: FieldVersion }) {
  return <Table.Tr>
    <Table.Td>{FIELD_LABEL[fv.field]}</Table.Td>
    <Table.Td><Text size="sm" c="dimmed">{formatFieldValue(fv.field, fv.base)}</Text></Table.Td>
    <Table.Td className={fv.local !== fv.base ? 'diff-ship' : ''}>{formatFieldValue(fv.field, fv.local)}</Table.Td>
    <Table.Td className={fv.incoming !== fv.base ? 'diff-terminal' : ''}>{formatFieldValue(fv.field, fv.incoming)}</Table.Td>
  </Table.Tr>;
}

function BillConflictCard({ conflict }: { conflict: MergeConflict }) {
  const dispatch = useDispatch();
  const resolved = conflict.status === '已解决';
  return <Card padding="md" className={`merge-conflict ${resolved ? 'resolved' : ''}`}>
    <Group justify="space-between" mb={8}>
      <Group gap="sm">
        <ThemeIcon color={resolved ? 'teal' : 'orange'} variant="light"><IconScale size={16} /></ThemeIcon>
        <div><strong>{conflict.bill}</strong>
          <Text size="xs" c="dimmed">同一提单两边都改过 · {conflict.fields.map((f) => FIELD_LABEL[f.field]).join('、')}</Text>
        </div>
      </Group>
      {resolved
        ? <Badge color="teal" leftSection={<IconCheck size={12} />}>已解决</Badge>
        : <Badge color="orange">待处理</Badge>}
    </Group>
    <Table withTableBorder={false} verticalSpacing={4} className="diff-table">
      <Table.Thead><Table.Tr><Table.Th>字段</Table.Th><Table.Th>共同基线</Table.Th><Table.Th className="diff-ship-h">船端版</Table.Th><Table.Th className="diff-terminal-h">码头版</Table.Th></Table.Tr></Table.Thead>
      <Table.Tbody>{conflict.fields.map((fv) => <FieldDiffRow key={fv.field} fv={fv} />)}</Table.Tbody>
    </Table>
    {resolved
      ? <Text size="xs" c="teal" mt={8}>{conflict.resolution?.note ?? '已按所选版本解决'} · {conflict.resolution?.at}</Text>
      : <Group gap="xs" mt="sm">
        <Button size="xs" color="teal" onClick={() => dispatch(resolveBillConflict({ id: conflict.id, side: 'ship' }))}>采用船端版</Button>
        <Button size="xs" color="indigo" variant="light" onClick={() => dispatch(resolveBillConflict({ id: conflict.id, side: 'terminal' }))}>采用码头版</Button>
        <Tooltip label="该票所有冲突字段回到共同基线 V4 的取值"><Button size="xs" variant="default" onClick={() => dispatch(resolveBillConflict({ id: conflict.id, side: 'base' }))}>退回基线</Button></Tooltip>
      </Group>}
  </Card>;
}

function SlotConflictCard({ conflict }: { conflict: MergeConflict }) {
  const dispatch = useDispatch();
  const resolved = conflict.status === '已解决';
  return <Card padding="md" className={`merge-conflict slot ${resolved ? 'resolved' : ''}`}>
    <Group justify="space-between" mb={6}>
      <Group gap="sm">
        <ThemeIcon color={resolved ? 'teal' : 'red'} variant="light"><IconAlertTriangle size={16} /></ThemeIcon>
        <div><strong>同一货位被两边各放一票</strong><Text size="xs" c="dimmed">{conflict.detail}</Text></div>
      </Group>
      {resolved ? <Badge color="teal" leftSection={<IconCheck size={12} />}>已解决</Badge> : <Badge color="red">待处理</Badge>}
    </Group>
    <Stack gap={6} mt={4}>
      {conflict.members?.map((member) => <Group key={member.cargoId} justify="space-between" className="slot-member">
        <Group gap={8}>
          <Badge size="sm" variant="light" color={member.changedBy === 'ship' ? 'teal' : member.changedBy === 'terminal' ? 'indigo' : 'orange'}>
            {member.changedBy === 'ship' ? '船端移动' : member.changedBy === 'terminal' ? '码头移动' : '双方移动'}
          </Badge>
          <Text size="sm" fw={700}>{member.bill}</Text>
          <Text size="xs" c="dimmed">{member.slot}</Text>
        </Group>
        {!resolved && <Button size="compact-xs" color="teal" onClick={() => dispatch(resolveSlotConflict({ id: conflict.id, keepBill: member.bill }))}>保留此票</Button>}
      </Group>)}
    </Stack>
    {resolved && <Text size="xs" c="teal" mt={8}>{conflict.resolution?.note} · {conflict.resolution?.at}</Text>}
  </Card>;
}

function ReconfirmPanel() {
  const comments = useSelector((root: RootState) => root.stowage.comments);
  const cargo = useSelector((root: RootState) => root.stowage.cargo);
  const dispatch = useDispatch();
  const stale = comments.filter((c) => c.status === '需重新确认');
  if (!stale.length) return null;
  return <Card padding="md" mt="md" className="reconfirm-card">
    <div className="panel-title">
      <div><strong>已接受限制条件需重新确认</strong><Text size="xs" c="dimmed">相关货位在合并后发生变化，原接受已失效</Text></div>
      <Badge color="orange" leftSection={<IconUsers size={13} />}>{stale.length} 项</Badge>
    </div>
    <Stack gap={8} mt="md">
      {stale.map((comment) => {
        const related = cargo.find((c) => c.id === comment.cargoId);
        return <div className="limit-row" key={comment.id}>
          <div>
            <Text size="xs" fw={700}>{comment.author} · {comment.role} · {related?.bill ?? comment.cargoId}</Text>
            <Text size="xs" c="dimmed">{comment.content}</Text>
            {related && <Text size="xs" c="orange">当前货位：Bay {related.bay} / Row {related.row} / Tier {related.tier}（{related.deck}），与接受时不一致</Text>}
          </div>
          <Group gap={6}>
            <Button size="compact-xs" color="teal" onClick={() => dispatch(acceptComment(comment.id))}>重新确认</Button>
            <Button size="compact-xs" variant="default" onClick={() => dispatch(rejectComment(comment.id))}>退回</Button>
          </Group>
        </div>;
      })}
    </Stack>
  </Card>;
}

export function OfflineMerge() {
  const state = useSelector((root: RootState) => root.stowage);
  const dispatch = useDispatch();
  const pending = state.conflicts.filter((c) => c.status === '待处理');
  const resolved = state.conflicts.filter((c) => c.status === '已解决');
  const billConflicts = pending.filter((c) => c.kind === 'bill');
  const slotConflicts = pending.filter((c) => c.kind === 'slot');
  const canLock = pending.length === 0;

  return <div className="page">
    <PageHeading
      eyebrow={`OFFLINE RECONCILE / 基线 V${state.baseRevision} → 草稿 V${state.planRevision}`}
      title="离线草稿合并与冲突对账"
      description="审阅包带方案版本与货位指纹；导入时按提单逐票三方合并，同一提单或货位两边都改过的保留两版并列冲突。"
      actions={pending.length > 0
        ? <Tooltip label="冲突全部处理并复核后才能锁定方案"><Button color="gray" leftSection={<IconLock size={16} />} disabled>{pending.length} 项冲突阻断锁定</Button></Tooltip>
        : <Badge size="lg" color="teal" leftSection={<IconCheck size={15} />}>无待处理冲突，可锁定</Badge>}
    />

    {pending.length > 0 && <div className="warning-banner"><IconAlertTriangle size={18} /><strong>{pending.length} 项合并冲突待处理</strong><span>{billConflicts.length} 项提单冲突、{slotConflicts.length} 项货位冲突；处理完成前不能锁定配载方案。</span></div>}

    <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md" mb="md">
      <ExportPanel />
      <ImportPanel />
    </SimpleGrid>

    {state.conflicts.length === 0
      ? <Card padding="lg" className="empty-merge">
        <Stack align="center" gap={6}>
          <ThemeIcon size={42} radius="xl" color="teal" variant="light"><IconInfoCircle size={22} /></ThemeIcon>
          <Text fw={700}>暂无合并冲突</Text>
          <Text size="xs" c="dimmed">导入码头或另一台终端导出的审阅包后，系统会按提单逐票对账并在此列出需要人工决定的两版差异。可点“生成码头端演示包”再导入体验。</Text>
        </Stack>
      </Card>
      : <Stack gap="md">
        {billConflicts.map((conflict) => <BillConflictCard key={conflict.id} conflict={conflict} />)}
        {slotConflicts.map((conflict) => <SlotConflictCard key={conflict.id} conflict={conflict} />)}
        {resolved.length > 0 && <Card padding="md">
          <Group justify="space-between">
            <Group gap="8"><IconCircleCheck size={16} color="teal" /><Text size="sm">已解决 {resolved.length} 项（货位后续再变化时会自动重开）</Text></Group>
            <Button size="xs" variant="default" rightSection={<IconX size={13} />} onClick={() => dispatch(clearResolvedConflicts())}>清除已解决记录</Button>
          </Group>
          <ScrollArea.Autosize mah={180} mt="sm">
            <Stack gap={4}>
              {resolved.map((conflict) => <Text key={conflict.id} size="xs" c="dimmed">{conflict.kind === 'bill' ? `提单 ${conflict.bill}` : '货位冲突'} · {conflict.resolution?.note ?? '已解决'} · {conflict.resolution?.at}</Text>)}
            </Stack>
          </ScrollArea.Autosize>
        </Card>}
      </Stack>}

    <ReconfirmPanel />

    {!canLock && <Alert mt="md" color="orange" icon={<IconLock size={16} />} title="方案锁定被阻断">
      还有 {pending.length} 项冲突未处理；请在上方逐票选择船端版、码头版或退回基线，货位冲突需指定保留票。全部解决后才能锁定配载方案。
    </Alert>}
  </div>;
}
