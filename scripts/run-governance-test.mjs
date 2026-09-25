// 知识治理事件与统一待办中心：端到端冒烟测试（fake-indexeddb + 真实 store）
// 运行：npm run test:governance（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useGovernanceStore } from '@/stores/governance'
import { useCorrectionStore } from '@/stores/correction'
import { useReviewStore } from '@/stores/review'
import { useHandoverStore } from '@/stores/handover'
import { useRetirementStore } from '@/stores/retirement'
import { useReleaseStore } from '@/stores/release'
import { useKbStore } from '@/stores/kb'
import { GOV_STATUS, SYNC_STATE } from '@/utils/governance'
import { PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const gov = useGovernanceStore(pinia)
const correction = useCorrectionStore(pinia)
const review = useReviewStore(pinia)
const handover = useHandoverStore(pinia)
const retirement = useRetirementStore(pinia)
const release = useReleaseStore(pinia)
const kb = useKbStore(pinia)

const admin = { id: 'u-admin', role: 'admin', name: '管理员' }
const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: 'editor', name: '编辑乙' }
const member = { id: 'u-m', role: 'viewer', name: '只读甲' }
const viewer2 = { id: 'u-v2', role: 'viewer', name: '只读乙' }

await db.users.bulkAdd([
  { id: 'u-admin', name: '管理员', role: 'admin', email: '' },
  { id: 'u-edit', name: '编辑甲', role: 'editor', email: '' },
  { id: 'u-edit2', name: '编辑乙', role: 'editor', email: '' },
  { id: 'u-m', name: '只读甲', role: 'viewer', email: '' },
  { id: 'u-v2', name: '只读乙', role: 'viewer', email: '' }
])

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

const nowIso = () => new Date().toISOString()
const evByKey = (key) => db.govEvents.where('dedupeKey').equals(key).first()

async function mkDoc(title, owner = editor) {
  const doc = {
    id: 'doc-' + Math.random().toString(36).slice(2, 8),
    title, body: '<p>正文</p>', categoryId: 'c-dev', tagIds: [],
    visibility: 'team', ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: { title, body: '<p>正文</p>', categoryId: 'c-dev', tagIds: [], visibility: 'team' } }]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}

// 发布门禁目标文档：v1 已发布、v2 为候选版本（当前字段即 v2 内容）
async function mkGateDoc(title, owner = editor) {
  const v1 = { title, body: '<p>旧版</p>', categoryId: 'c-dev', tagIds: [], visibility: 'team' }
  const v2 = { title, body: '<p>新版内容</p>', categoryId: 'c-dev', tagIds: [], visibility: 'team' }
  const doc = {
    id: 'doc-' + Math.random().toString(36).slice(2, 8),
    title, body: v2.body, categoryId: 'c-dev', tagIds: [],
    visibility: 'team', ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [
      { version: 1, savedAt: nowIso(), savedBy: owner.id, note: 'v1', snapshot: v1 },
      { version: 2, savedAt: nowIso(), savedBy: owner.id, note: 'v2', snapshot: v2 }
    ]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}

// ---------- 1. 汇聚：六类治理流程的在途事件统一建档 ----------
console.log('\n[1] 汇聚：评审/纠错/保鲜/交接/退役/发布门禁事件统一建档')
const d1 = await mkDoc('纠错目标文档', editor2)
const t1 = (await correction.createTicket({ docId: d1.id, type: 'factual', description: '第 2 节参数写错', source: 'doc' }, member)).ticket

const d2 = await mkDoc('评审目标文档', editor)
const rev1 = (await review.submitReview(d2.id, { title: d2.title, body: '<p>修订</p>', categoryId: d2.categoryId, tagIds: [], visibility: 'team' }, '内容更新', editor)).review

const d3 = await mkDoc('保鲜目标文档', editor2)
await db.freshnessTickets.add({
  id: 'fr-gov-1', docId: d3.id, round: 1, status: 'open', cycleDays: 30,
  ruleSource: 'doc', policyId: null, dueAt: new Date(Date.now() - 86400000).toISOString(),
  reviewId: null, submittedBy: null, submittedAt: null, decidedBy: null, decidedAt: null,
  decisionNote: '', createdAt: nowIso(), timeline: []
})

const d4 = await mkDoc('交接目标文档', editor)
const ho1 = (await handover.initiateHandover({ items: [{ docId: d4.id, toUserId: editor2.id }], revokeMode: 'keep', note: '岗位调整' }, editor)).handover

const d5 = await mkDoc('退役旧文档', editor)
const d6 = await mkDoc('退役替代文档', editor)
const rt1 = (await retirement.initiateRetirement({ docId: d5.id, replacementDocId: d6.id, reason: '内容过时' }, editor)).retirement

const d7 = await mkGateDoc('门禁目标文档', editor)
const gate1 = (await release.submitGate({ docId: d7.id, note: 'v2 发布' }, editor)).gate

await gov.loadAll() // 首次加载即汇聚

const evCorrection = await evByKey('correction:' + t1.id + ':claim')
assert(evCorrection && evCorrection.status === GOV_STATUS.OPEN && evCorrection.assigneeRole === 'editor', '纠错「待认领」事件建档（编辑者角色池）')
const evReview = await evByKey('review:' + rev1.id + ':approve')
assert(evReview && evReview.assigneeRole === 'admin', '评审「待审批」事件建档（管理员角色池）')
const evFresh = await evByKey('freshness:fr-gov-1:revise')
assert(evFresh && evFresh.assigneeId === editor2.id, '保鲜「待整改」事件建档（分派给文档负责人）')
const evHo = await evByKey('handover:' + ho1.id + ':' + d4.id + ':confirm')
assert(evHo && evHo.assigneeId === editor2.id, '交接「待确认」事件建档（分派给接任者）')
const evRt = await evByKey('retirement:' + rt1.id + ':approve')
assert(evRt && evRt.assigneeRole === 'admin', '退役「待审批」事件建档（管理员角色池）')
const evGate = await evByKey('release:' + gate1.id + ':confirm')
assert(evGate && evGate.assigneeId === editor.id, '门禁「待确认影响」事件建档（分派给负责人）')
assert(evReview.dueAt && new Date(evReview.dueAt) > new Date(), '待办携带按来源 SLA 计算的到期点')

// ---------- 2. 去重：重复汇聚不产生重复待办 ----------
console.log('\n[2] 去重：同一源单据同一步骤只存在一条在途待办')
const countBefore = (await db.govEvents.toArray()).length
await gov.syncAll()
await gov.syncAll()
const allAfter = await db.govEvents.toArray()
assert(allAfter.length === countBefore, '重复汇聚待办总数不变（' + countBefore + ' 条）')
const keys = allAfter.map((e) => e.dedupeKey)
assert(new Set(keys).size === keys.length, 'dedupeKey 全局唯一')

// ---------- 3. 认领 + 回写原流程 ----------
console.log('\n[3] 认领：待办动作回写原流程（纠错状态机直写 / 源单据联动留痕）')
let r = await gov.claimEvent(evCorrection.id, editor)
assert(r.status === 'ok', '编辑者认领纠错「待认领」待办')
let t1f = await db.correctionTickets.get(t1.id)
assert(t1f.status === 'claimed' && t1f.claimedBy === editor.id, '回写原流程：纠错单已被编辑甲认领（状态机直写）')
let e1 = await evByKey('correction:' + t1.id + ':claim')
assert(e1.status === GOV_STATUS.DONE && e1.syncState === SYNC_STATE.SYNCED, '「待认领」待办随源流程推进自动办结')
const evRevise = await evByKey('correction:' + t1.id + ':revise')
assert(evRevise && evRevise.status === GOV_STATUS.OPEN && evRevise.assigneeId === editor.id, '派生下一步待办：「待送审」分派给修订人')

r = await gov.claimEvent(evReview.id, admin)
assert(r.status === 'ok', '管理员认领评审待办')
const rev1f = await db.reviews.get(rev1.id)
assert((rev1f.timeline || []).some((x) => x.action === 'gov'), '回写原流程：评审单 timeline 追加治理联动留痕')
const evReview2 = await db.govEvents.get(evReview.id)
assert(evReview2.status === GOV_STATUS.CLAIMED && evReview2.claimedBy === admin.id, '评审待办已认领（源流程未推进，保持跟进）')

r = await gov.claimEvent(evGate.id, editor)
assert(r.status === 'ok', '负责人认领门禁待办')
const gate1f = await db.releaseGates.get(gate1.id)
assert((gate1f.timeline || []).some((x) => x.action === 'gov'), '回写原流程：门禁单 timeline 追加联动留痕')

// ---------- 4. 转交 + 回写 ----------
console.log('\n[4] 转交：已认领待办转交他人，纠错单认领关系同步回写')
r = await gov.claimEvent(evRevise.id, editor)
assert(r.status === 'ok', '修订人认领「待送审」待办')
r = await gov.transferEvent(evRevise.id, member.id, '', editor)
assert(r.status === 'bad-target', '纠错修订待办不能转交给只读成员')
r = await gov.transferEvent(evRevise.id, editor2.id, '我休假，麻烦跟进', editor)
assert(r.status === 'ok', '转交给编辑乙成功')
t1f = await db.correctionTickets.get(t1.id)
assert(t1f.claimedBy === editor2.id, '回写原流程：纠错单修订人已转给编辑乙')
const t1Actions = (t1f.timeline || []).map((x) => x.action)
assert(t1Actions.includes('release') && t1Actions.filter((a) => a === 'claim').length >= 2, '纠错单留痕：释放原修订人 + 新修订人认领')
const evRevise2 = await db.govEvents.get(evRevise.id)
assert(evRevise2.claimedBy === editor2.id && evRevise2.syncState === SYNC_STATE.SYNCED, '待办处理人与回写状态同步')

// ---------- 5. 分派：管理员改派角色池/指定成员 ----------
console.log('\n[5] 分派：仅管理员可分派；手动分派不被汇聚覆盖')
r = await gov.assignEvent(evRt.id, { assigneeId: member.id }, '', editor)
assert(r.status === 'denied', '非管理员不能分派')
r = await gov.assignEvent(evRt.id, { assigneeId: member.id }, '请跟进退役审批材料', admin)
assert(r.status === 'ok', '管理员分派退役待办给指定成员')
const evRt2 = await db.govEvents.get(evRt.id)
assert(evRt2.assigneeId === member.id && evRt2.assignedManually === true, '分派生效并标记手动分派')
const rt1f = await db.retirements.get(rt1.id)
assert((rt1f.timeline || []).some((x) => x.action === 'gov'), '回写原流程：退役单 timeline 追加分派留痕')
await gov.syncAll()
const evRt3 = await db.govEvents.get(evRt.id)
assert(evRt3.assigneeId === member.id, '手动分派不被后续汇聚覆盖')

// ---------- 6. 超时：SLA 到点升级标记（幂等） ----------
console.log('\n[6] 超时：越过处置时限的待办升级标记，重复扫描不重复标记')
await db.govEvents.update(evFresh.id, { dueAt: new Date(Date.now() - 3600000).toISOString() })
await gov.sweepOverdue()
const evFresh2 = await db.govEvents.get(evFresh.id)
assert(!!evFresh2.escalatedAt, '越过 SLA 的待办升级标记')
const overdueMarks = (evFresh2.timeline || []).filter((x) => x.action === 'overdue').length
await gov.sweepOverdue()
const evFresh3 = await db.govEvents.get(evFresh.id)
assert((evFresh3.timeline || []).filter((x) => x.action === 'overdue').length === overdueMarks, '超时升级幂等（不重复标记）')
assert(gov.overdueCount >= 1, '超时计数可用（' + gov.overdueCount + ' 条已超时）')

// ---------- 7. 重试：回写失败挂起 → 条件解除后重放 ----------
console.log('\n[7] 重试：回写失败挂起 pendingAction，条件解除后重放恢复')
// 7a 暂时失败（角色不足）→ 角色升级后重试成功
const d8 = await mkDoc('重试目标文档', editor)
const t4 = (await correction.createTicket({ docId: d8.id, description: '重试场景错误' }, member)).ticket
await gov.syncAll()
const ev4 = await evByKey('correction:' + t4.id + ':claim')
r = await gov.assignEvent(ev4.id, { assigneeId: member.id }, '', admin)
assert(r.status === 'ok', '管理员分派纠错待办给只读成员')
r = await gov.claimEvent(ev4.id, member)
assert(r.status === 'sync-failed', '只读成员认领：回写被源流程拒绝，待办挂起待重试')
let ev4f = await db.govEvents.get(ev4.id)
assert(ev4f.syncState === SYNC_STATE.FAILED && ev4f.pendingAction?.type === 'claim' && ev4f.attempts >= 1, '回写失败挂起 pendingAction（待重放的认领动作）')
await gov.syncAll()
ev4f = await db.govEvents.get(ev4.id)
assert(ev4f.syncState === SYNC_STATE.FAILED && ev4f.status === GOV_STATUS.OPEN, '失败待办不被汇聚覆盖或办结')
await db.users.update(member.id, { role: 'editor' }) // 角色升级为编辑者
r = await gov.retryEvent(ev4.id, { id: member.id, role: 'editor' })
assert(r.status === 'ok', '条件解除后重试成功，回写恢复')
const t4f = await db.correctionTickets.get(t4.id)
assert(t4f.status === 'claimed' && t4f.claimedBy === member.id, '重试回写：纠错单已由原操作人认领')
ev4f = await db.govEvents.get(ev4.id)
assert(ev4f.status === GOV_STATUS.DONE && ev4f.syncState === SYNC_STATE.SYNCED, '重试成功后待办随源流程办结')

// 7b 源流程分叉 → 重试时取消待办
const d9 = await mkDoc('分叉目标文档', editor)
const t5 = (await correction.createTicket({ docId: d9.id, description: '分叉场景错误' }, member)).ticket
await gov.syncAll()
const ev5 = await evByKey('correction:' + t5.id + ':claim')
await gov.assignEvent(ev5.id, { assigneeId: viewer2.id }, '', admin)
r = await gov.claimEvent(ev5.id, viewer2)
assert(r.status === 'sync-failed', '分叉场景：认领回写先失败挂起')
r = await correction.claimTicket(t5.id, editor)
assert(r.status === 'ok', '编辑者直接在纠错中心认领同一纠错单（源流程分叉）')
r = await gov.retryEvent(ev5.id, viewer2)
assert(r.status === 'diverged', '重试发现源流程已分叉')
const ev5f = await db.govEvents.get(ev5.id)
assert(ev5f.status === GOV_STATUS.CANCELLED, '分叉待办已取消（纠错单仍在纠错中心流转）')

// ---------- 8. 源流程推进 → 待办自动办结 ----------
console.log('\n[8] 回写联动：源流程办结后待办自动关闭')
r = await review.decideReview(rev1.id, 'approve', '通过', admin)
assert(r.status === 'ok', '管理员审批通过评审单')
await gov.syncAll()
const evReview3 = await db.govEvents.get(evReview.id)
assert(evReview3.status === GOV_STATUS.DONE, '评审待办随审批办结')
assert((evReview3.timeline || []).some((x) => x.action === 'done'), '自动办结留痕')

const revC = (await review.submitCorrectionReview(t1.id, d1.id, { title: d1.title, body: '<p>修订后</p>', categoryId: d1.categoryId, tagIds: [], visibility: 'team' }, '修订完成', editor2)).review
r = await review.decideReview(revC.id, 'approve', '', admin)
assert(r.status === 'ok', '纠错修订审批通过')
await gov.syncAll()
const t1Done = await db.correctionTickets.get(t1.id)
assert(t1Done.status === 'resolved', '纠错单已解决')
const evRevise3 = await db.govEvents.get(evRevise.id)
assert(evRevise3.status === GOV_STATUS.DONE, '纠错「待送审」待办随解决办结')

r = await handover.confirmHandover(ho1.id, [d4.id], editor2)
assert(r.status === 'ok', '接任者确认交接')
await gov.syncAll()
const evHo2 = await db.govEvents.get(evHo.id)
assert(evHo2.status === GOV_STATUS.DONE, '交接「待确认」事件随确认办结')
const evHoApprove = await evByKey('handover:' + ho1.id + ':' + d4.id + ':approve')
assert(evHoApprove && evHoApprove.status === GOV_STATUS.OPEN && evHoApprove.assigneeRole === 'admin', '派生交接「待批准」事件（管理员角色池）')

// ---------- 9. 权限：角色与访客约束 ----------
console.log('\n[9] 权限：非分派对象/访客/非管理员约束')
r = await gov.claimEvent(evFresh.id, viewer2)
assert(r.status === 'denied', '非分派对象不能认领他人待办')
r = await gov.claimEvent(evFresh.id, null)
assert(r.status === 'guest', '访客不能认领')
r = await gov.assignEvent(evFresh.id, { assigneeRole: 'editor' }, '', editor2)
assert(r.status === 'denied', '非管理员不能分派')
r = await gov.cancelEvent(evFresh.id, '', editor2)
assert(r.status === 'denied', '非管理员不能取消待办')

// ---------- 10. 角标：按角色/成员统计待处理数 ----------
console.log('\n[10] 角标：pendingCountFor 按分派统计')
assert(gov.pendingCountFor(member.id, 'editor') >= 1, '指定分派的待办计入本人角标（退役审批材料）')
assert(gov.pendingCountFor(editor2.id, 'editor') >= 1, '负责人待办计入角标（保鲜整改）')
assert(gov.pendingCountFor(admin.id, 'admin') >= 1, '管理员角色池待办计入角标（交接批准）')
assert(gov.pendingCountFor(viewer2.id, 'viewer') === 0, '无分派的只读成员角标为 0')

// ---------- 11. 取消待办：管理员取消，源流程继续 ----------
console.log('\n[11] 取消：管理员取消待办，源流程不受影响且不被汇聚复活')
r = await gov.cancelEvent(evFresh.id, '纳入下季度统一整改', admin)
assert(r.status === 'ok', '管理员取消保鲜待办')
const evFresh4 = await db.govEvents.get(evFresh.id)
assert(evFresh4.status === GOV_STATUS.CANCELLED, '待办已取消')
const fr1f = await db.freshnessTickets.get('fr-gov-1')
assert((fr1f.timeline || []).some((x) => x.action === 'gov'), '取消动作在源单据留痕')
await gov.syncAll()
const evFresh5 = await db.govEvents.get(evFresh.id)
assert(evFresh5.status === GOV_STATUS.CANCELLED, '取消的待办不被汇聚复活')

// ---------- 12. 时间线全程留痕 ----------
console.log('\n[12] 待办 timeline 全程留痕')
const full = await db.govEvents.get(evRevise.id)
const actions = (full.timeline || []).map((e) => e.action)
assert(['create', 'claim', 'sync-ok', 'transfer', 'done'].every((a) => actions.includes(a)), '完整链路动作均留痕：' + actions.join('/'))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
