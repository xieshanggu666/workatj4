// 知识治理事件与统一待办中心：端到端冒烟测试（fake-indexeddb + 真实 store）
// 覆盖：六类事件汇聚 / 去重 / 角色分派 / 认领 / 转交 / 一键回写原流程 / 源推进自动闭环 /
//      源回退重开 / 失败与重试 / 超时升级 / 源撤销自动关闭
// 运行：npm run test:governance（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useGovernanceStore } from '@/stores/governance'
import { useReviewStore } from '@/stores/review'
import { useCorrectionStore } from '@/stores/correction'
import { useHandoverStore } from '@/stores/handover'
import { useRetirementStore } from '@/stores/retirement'
import { useKbStore } from '@/stores/kb'
import { GOV, dedupeKeyOf, canActOnEvent, isActionable } from '@/utils/governance'
import { PUBLISH } from '@/utils/review'
import { CORRECTION } from '@/utils/correction'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const gov = useGovernanceStore(pinia)
const review = useReviewStore(pinia)
const correction = useCorrectionStore(pinia)
const handover = useHandoverStore(pinia)
const retirement = useRetirementStore(pinia)
const kb = useKbStore(pinia)

const member = { id: 'u-m', role: 'viewer', name: '只读成员' }
const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

// 交接发起会校验接任者是注册用户：预置成员表
await db.users.bulkAdd([member, editor, editor2, admin].map((u) => ({ ...u, email: '', avatar: u.name[0] })))

async function mkDoc(title, owner = editor) {
  const doc = {
    id: 'doc-' + Math.random().toString(36).slice(2, 8),
    title, body: '<p>正文</p>', categoryId: 'c-dev', tagIds: [],
    visibility: 'team', ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    versions: [{ version: 1, savedAt: new Date().toISOString(), savedBy: owner.id, note: '初始', snapshot: { title, body: '<p>正文</p>', categoryId: 'c-dev', tagIds: [], visibility: 'team' } }]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}
const patchOf = (doc, body) => ({ title: doc.title, body: body || '<p>新正文</p>', categoryId: doc.categoryId, tagIds: [], visibility: 'team' })
const evOf = async (key) => (await db.governanceEvents.toArray()).find((e) => e.dedupeKey === key)

// ---------- 1. 汇聚六类治理事件 ----------
console.log('\n[1] 汇聚：评审/纠错/保鲜/交接/退役/发布门禁 → 统一待办')
const doc1 = await mkDoc('评审文档')
const doc2 = await mkDoc('纠错文档')
const doc3 = await mkDoc('保鲜文档')
const doc4 = await mkDoc('交接文档')
const doc5 = await mkDoc('退役旧文档')
const doc6 = await mkDoc('退役替代文档')
const doc7 = await mkDoc('门禁文档')

await review.submitReview(doc1.id, patchOf(doc1), '普通修订送审', editor)
const corTicket = (await correction.createTicket({ docId: doc2.id, type: 'factual', description: '参数说明写错了', source: 'doc' }, member)).ticket
await db.freshnessTickets.add({
  id: 'ft-1', docId: doc3.id, status: 'open', round: 1, dueAt: new Date().toISOString(),
  createdAt: new Date().toISOString(), ruleSource: 'doc', cycleDays: 90, timeline: []
})
const ho = (await handover.initiateHandover({ items: [{ docId: doc4.id, toUserId: editor2.id }], note: '工作交接' }, editor)).handover
const ret = (await retirement.initiateRetirement({ docId: doc5.id, replacementDocId: doc6.id, reason: '内容已被新文档替代' }, editor)).retirement
await db.releaseGates.add({
  id: 'gate-confirm', docId: doc7.id, status: 'pending_confirm', submittedBy: editor.id, ownerId: editor.id,
  version: 2, publishedVersion: 1, impacts: [], checks: {}, createdAt: new Date().toISOString(), timeline: []
})
await db.releaseGates.add({
  id: 'gate-approve', docId: doc7.id, status: 'pending_approval', submittedBy: editor.id, ownerId: editor.id,
  version: 2, publishedVersion: 1, impacts: [], checks: {},
  candidateSnapshot: patchOf(doc7), publishedSnapshot: { title: doc7.title, body: '<p>正文</p>', categoryId: 'c-dev', tagIds: [], visibility: 'team' },
  createdAt: new Date().toISOString(), timeline: []
})

let r = await gov.syncEvents()
assert(r.created === 7, '首次汇聚生成 7 条待办事件（实际 ' + r.created + '）')
const all = await db.governanceEvents.toArray()
const byKey = Object.fromEntries(all.map((e) => [e.dedupeKey, e]))
const reviewKey = all.find((e) => e.type === 'review')?.dedupeKey
assert(!!byKey[reviewKey] && byKey[reviewKey].assigneeRole === 'admin' && byKey[reviewKey].stage === 'approve', '评审事件：待审批 · 分派管理员')
assert(!!byKey[dedupeKeyOf('correction', corTicket.id, 'claim')] && byKey[dedupeKeyOf('correction', corTicket.id, 'claim')].assigneeRole === 'editor', '纠错事件：待认领 · 分派编辑者')
assert(!!byKey[dedupeKeyOf('freshness', 'ft-1', 'fix')], '保鲜事件：待整改')
const hoConfirm = byKey[dedupeKeyOf('handover', ho.id, 'confirm', editor2.id)]
assert(!!hoConfirm && hoConfirm.assigneeId === editor2.id, '交接事件：待确认 · 精确分派接任者')
assert(!!byKey[dedupeKeyOf('retirement', ret.id, 'approve')], '退役事件：待审批')
assert(!!byKey[dedupeKeyOf('release', 'gate-confirm', 'confirm', editor.id)] && !isActionable(byKey[dedupeKeyOf('release', 'gate-confirm', 'confirm', editor.id)]), '门禁事件：待确认影响（跳转处理型）')
assert(!!byKey[dedupeKeyOf('release', 'gate-approve', 'approve')] && isActionable(byKey[dedupeKeyOf('release', 'gate-approve', 'approve')]), '门禁事件：待审批（可一键回写）')
assert(all.every((e) => e.status === GOV.OPEN && e.dueAt), '全部事件为待处理并带 SLA 截止点')

// ---------- 2. 去重 ----------
console.log('\n[2] 去重：重复汇聚不产生重复待办')
r = await gov.syncEvents()
assert(r.created === 0, '重复汇聚新建 0 条（dedupeKey 去重）')
assert((await db.governanceEvents.toArray()).length === 7, '事件总数保持 7 条')

// ---------- 3. 角色分派与认领 ----------
console.log('\n[3] 认领：按角色分派校验；认领/释放')
const corClaimKey = dedupeKeyOf('correction', corTicket.id, 'claim')
r = await gov.claimEvent(byKey[reviewKey].id, member)
assert(r.status === 'denied', '只读成员不能认领管理员待办')
r = await gov.claimEvent(byKey[corClaimKey].id, member)
assert(r.status === 'denied', '只读成员不能认领编辑者待办')
r = await gov.claimEvent(byKey[corClaimKey].id, editor)
assert(r.status === 'ok', '编辑者认领纠错待办成功')
let ev = await evOf(corClaimKey)
assert(ev.status === GOV.CLAIMED && ev.claimedBy === editor.id, '事件进入处理中并记录认领人')
r = await gov.claimEvent(byKey[corClaimKey].id, editor2)
assert(r.status === 'changed', '已认领事件不能重复认领')
r = await gov.releaseEvent(byKey[corClaimKey].id, editor2)
assert(r.status === 'denied', '非认领人不能释放')
r = await gov.releaseEvent(byKey[corClaimKey].id, editor)
assert(r.status === 'ok', '认领人释放成功，回到待处理')

// ---------- 4. 转交 ----------
console.log('\n[4] 转交：角色门槛校验；指定到人的事件不可转交')
r = await gov.transferEvent(byKey[corClaimKey].id, member, '', editor)
assert(r.status === 'bad-target', '纠错待办不能转交给只读成员（角色门槛）')
r = await gov.transferEvent(byKey[corClaimKey].id, editor2, '', editor)
assert(r.status === 'ok', '编辑者之间转交成功')
ev = await evOf(corClaimKey)
assert(ev.status === GOV.CLAIMED && ev.claimedBy === editor2.id, '转交后由目标成员处理')
r = await gov.transferEvent(hoConfirm.id, editor, '', admin)
assert(r.status === 'locked', '指定接任者的交接确认事件不可转交')

// ---------- 5. 一键回写：评审审批 ----------
console.log('\n[5] 一键回写：待办中心直接审批评审单，回写原流程')
r = await gov.completeEvent(byKey[reviewKey].id, 'approve', '内容无误', admin)
assert(r.status === 'ok', '管理员在待办中心一键审批通过')
const doc1After = await db.docs.get(doc1.id)
assert(doc1After.body === '<p>新正文</p>' && doc1After.publishState === PUBLISH.PUBLISHED, '原流程已回写：文档发布新内容并解锁')
ev = await evOf(reviewKey)
assert(ev.status === GOV.DONE && ev.result === 'approve' && ev.doneBy === admin.id, '事件已完成并记录结论')
assert(ev.writeback && ev.writeback.target === 'review:' + ev.refId && ev.writeback.action === 'approve', 'writeback 记录回写目标与动作')
const reviewRec = await db.reviews.get(ev.refId)
assert(reviewRec.status === 'approved' && reviewRec.decisionNote === '内容无误', '评审单已审批并留痕审批意见')

// ---------- 6. 一键回写：纠错认领 → 源推进自动生成下一阶段待办 ----------
console.log('\n[6] 回写纠错认领；源推进后修订待办自动生成')
r = await gov.completeEvent(byKey[corClaimKey].id, 'claim', '', editor2)
assert(r.status === 'ok', '编辑乙在待办中心一键认领纠错单')
const corAfter = await db.correctionTickets.get(corTicket.id)
assert(corAfter.status === CORRECTION.CLAIMED && corAfter.claimedBy === editor2.id, '原流程已回写：纠错单进入修订中')
ev = await evOf(corClaimKey)
assert(ev.status === GOV.DONE && ev.result === 'claim', '认领待办已完成')
const reviseKey = dedupeKeyOf('correction', corTicket.id, 'revise', editor2.id)
ev = await evOf(reviseKey)
assert(!!ev && ev.status === GOV.OPEN && ev.assigneeId === editor2.id, '源推进后自动生成「修订中」待办并指派修订人')
assert(!isActionable(ev), '修订待办为跳转处理型（需到原流程修订送审）')

// ---------- 7. 交接确认回写 → 批准事件生成；失败 → 重试成功 ----------
console.log('\n[7] 交接确认回写；批准事件失败重试')
r = await gov.completeEvent(hoConfirm.id, 'confirm', '', editor2)
assert(r.status === 'ok', '接任者在待办中心一键确认接收')
const hoAfter = await db.handovers.get(ho.id)
assert(hoAfter.items[0].status === 'confirmed', '原流程已回写：交接篇目已确认')
const hoApproveKey = dedupeKeyOf('handover', ho.id, 'approve')
ev = await evOf(hoApproveKey)
assert(!!ev && ev.status === GOV.OPEN && ev.assigneeRole === 'admin', '确认后自动生成「待批准」待办（管理员）')

// 模拟并发变化：库中篇目被改回待确认 → 一键批准被源流程拒绝 → 事件 failed
const hoApproveId = (await evOf(hoApproveKey)).id
await db.handovers.update(ho.id, { items: hoAfter.items.map((it) => ({ ...it, status: 'pending_confirm' })) })
r = await gov.completeEvent(hoApproveId, 'approve', '', admin)
assert(r.status === 'failed' && r.reason === 'changed', '并发变化导致回写失败，事件标记 failed')
ev = await evOf(hoApproveKey)
assert(ev.status === GOV.FAILED && ev.failReason === 'changed', '失败原因已记录（changed）')
// 恢复源状态后重试成功
await db.handovers.update(ho.id, { items: hoAfter.items.map((it) => ({ ...it, status: 'confirmed' })) })
r = await gov.retryEvent(hoApproveId, 'approve', '确认无误', admin)
assert(r.status === 'ok', '失败重试成功')
ev = await evOf(hoApproveKey)
assert(ev.status === GOV.DONE && ev.attempts === 1 && ev.writeback?.action === 'approve', '重试后完成并累计重试次数')
const hoDone = await db.handovers.get(ho.id)
assert(hoDone.items[0].status === 'completed', '原流程已回写：交接篇目完成转移')
const doc4After = await db.docs.get(doc4.id)
assert(doc4After.ownerId === editor2.id, '文档所有权已转移给接任者')

// ---------- 8. 超时升级 ----------
console.log('\n[8] 超时：SLA 到期标红并升级管理员督办')
const freshKey = dedupeKeyOf('freshness', 'ft-1', 'fix')
await db.governanceEvents.update(byKey[freshKey].id, { dueAt: new Date(Date.now() - 3600 * 1000).toISOString() })
const swept = await gov.sweepTimeouts()
assert(swept === 1, '超时扫描命中 1 条待办')
ev = await evOf(freshKey)
assert(ev.timedOut && ev.escalated && ev.assigneeRole === 'admin', '超时后升级：分派角色提升为管理员')
assert(!canActOnEvent(ev, editor) && canActOnEvent(ev, admin), '升级后仅管理员可处理')
assert((ev.timeline || []).some((t) => t.action === 'timeout'), '超时升级留痕')
const swept2 = await gov.sweepTimeouts()
assert(swept2 === 0, '重复扫描不重复升级')

// ---------- 9. 源回退：纠错退回待处理 → 认领待办重开 ----------
console.log('\n[9] 源回退重开：纠错单退回待处理 → 认领待办重开并累计次数')
await correction.returnTicket(corTicket.id, '请补充错误位置', editor2)
r = await gov.syncEvents()
ev = await evOf(corClaimKey)
assert(ev.status === GOV.OPEN && ev.attempts === 1 && !ev.claimedBy, '认领待办已重开（attempts=1）')
assert((ev.timeline || []).some((t) => t.action === 'reopen'), '重开留痕')
ev = await evOf(reviseKey)
assert(ev.status === GOV.CANCELLED, '修订待办随源回退自动关闭')

// ---------- 10. 源撤销自动关闭 ----------
console.log('\n[10] 源撤销：退役申请撤销 → 待办自动关闭')
const retKey = dedupeKeyOf('retirement', ret.id, 'approve')
await retirement.cancelRetirement(ret.id, editor)
r = await gov.syncEvents()
ev = await evOf(retKey)
assert(ev.status === GOV.CANCELLED && ev.result === 'cancelled', '退役待办随申请撤销自动关闭')

// ---------- 11. 发布门禁一键驳回 ----------
console.log('\n[11] 发布门禁：待办中心一键驳回，回写门禁状态')
const gateApproveKey = dedupeKeyOf('release', 'gate-approve', 'approve')
r = await gov.completeEvent((await evOf(gateApproveKey)).id, 'reject', '影响面过大', admin)
assert(r.status === 'ok', '管理员一键驳回门禁')
const gateAfter = await db.releaseGates.get('gate-approve')
assert(gateAfter.status === 'rejected' && gateAfter.decisionNote === '影响面过大', '原流程已回写：门禁已驳回并留痕')
ev = await evOf(gateApproveKey)
assert(ev.status === GOV.DONE && ev.result === 'reject', '门禁待办已完成')

// ---------- 12. 跳转处理型事件不可一键回写 ----------
console.log('\n[12] 跳转处理型：门禁确认影响不可在待办中心一键执行')
const gateConfirmKey = dedupeKeyOf('release', 'gate-confirm', 'confirm', editor.id)
r = await gov.completeEvent((await evOf(gateConfirmKey)).id, 'confirm', '', editor)
assert(r.status === 'not-actionable', '确认影响需前往原流程逐项处理')

// ---------- 13. 视角查询 ----------
console.log('\n[13] 视角：todosFor / pendingCountFor')
await gov.reload()
const adminTodos = gov.todosFor(admin)
assert(adminTodos.some((e) => e.dedupeKey === freshKey), '管理员可见超时升级的保鲜待办')
const editorTodos = gov.todosFor(editor)
assert(!editorTodos.some((e) => e.dedupeKey === freshKey), '编辑者不再可见已升级的保鲜待办')
assert(editorTodos.some((e) => e.dedupeKey === corClaimKey), '编辑者可见重开的纠错认领待办')
assert(typeof gov.pendingCountFor(admin) === 'number' && gov.pendingCountFor(admin) >= 1, '角标计数可用')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
