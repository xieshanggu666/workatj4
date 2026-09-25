// 知识变更影响评估与发布门禁端到端回归（fake-indexeddb + 真实 store）
// 覆盖：统一治理状态机（评审结论/知识保鲜/未解决缺口/退役关系 四维度准入）→
// 阻断建档（blocked）与阻断原因回写 → 跨角色豁免（负责人豁免保鲜、编辑者豁免缺口）→
// 硬阻断消除后重新评估 → 负责人逐项确认影响（含重新发起时的确认状态恢复）→
// 管理员审批放行（版本发布、问答引用切新版、链接状态回写、放行前复检）/ 驳回/撤回 →
// 管理员回退（正文/引用/链接还原）→ 门禁中编辑锁定、问答/搜索/共享访问只认已发布版、文档删除清理门禁。
// 运行：npm run test:release
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGapStore } from '@/stores/gap'
import { useReleaseStore } from '@/stores/release'
import { useShareStore } from '@/stores/share'
import { useReviewStore } from '@/stores/review'
import { useFreshnessStore } from '@/stores/freshness'
import { useRetirementStore } from '@/stores/retirement'
import { uid, makeToken } from '@/utils/format'
import {
  GATE, RELEASE_STATE, CHECK_KEY, CHECK_STATUS, CHECK_SEVERITY,
  publishedSnapshot, isDocGated, evaluateGateChecks, canSignOffCheck, canRecheckGate
} from '@/utils/release'
import { canEditDoc } from '@/utils/permission'
import { isShareActive } from '@/utils/share'
import { GAP } from '@/utils/gap'
import { FRESH, isFreshTicketOpen } from '@/utils/freshness'
import { RETIRE } from '@/utils/retirement'
import { PUBLISH, REVIEW } from '@/utils/review'
import { docSnapshot } from '@/utils/version'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const kb = useKbStore(pinia)
const auth = useAuthStore(pinia)
const gap = useGapStore(pinia)
const release = useReleaseStore(pinia)
const share = useShareStore(pinia)
const review = useReviewStore(pinia)
const freshness = useFreshnessStore(pinia)
const retirement = useRetirementStore(pinia)

const owner = { id: 'u-owner', name: '文档负责人', role: 'editor', avatar: 'FZ' }
const editor = { id: 'u-editor', name: '其他编辑', role: 'editor', avatar: 'QT' }
const admin = { id: 'u-admin', name: '管理员', role: 'admin', avatar: 'GL' }
const viewer = { id: 'u-viewer', name: '只读', role: 'viewer', avatar: 'ZD' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}
const nowIso = () => new Date().toISOString()

await db.users.bulkAdd([owner, editor, admin, viewer].map((u) => ({ ...u, email: '', title: '' })))

async function mkDoc(extra = {}) {
  const d = {
    id: uid('doc'), title: '门禁文档-' + Math.random().toString(36).slice(2, 7),
    body: '<p>旧正文 Vue 初始化 Dexie 查询 权限模型</p>', categoryId: 'c', tagIds: [], visibility: 'public',
    ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED, activeReviewId: null,
    createdAt: nowIso(), updatedAt: nowIso(),
    versions: [{ version: 1, savedAt: nowIso(), savedBy: owner.id, note: '初始', snapshot: null }],
    ...extra
  }
  d.versions[0].snapshot = docSnapshot(d)
  await db.docs.add(d)
  await kb.reloadDocs()
  return d
}
const getDoc = (id) => db.docs.get(id)

// 直接在库中保存一个新版本（模拟编辑者保存）
async function saveVersion(docId, patch, by) {
  const d = await db.docs.get(docId)
  const now = nowIso()
  const versions = d.versions
  const next = {
    version: versions.length + 1,
    savedAt: now, savedBy: by.id, note: '编辑文档',
    snapshot: {
      title: patch.title ?? d.title,
      body: patch.body ?? d.body,
      categoryId: patch.categoryId ?? d.categoryId,
      tagIds: patch.tagIds ?? d.tagIds,
      visibility: patch.visibility ?? d.visibility
    }
  }
  await db.docs.update(docId, { ...patch, updatedAt: now, versions: [...versions, next] })
  await kb.reloadDocs()
  return next
}

async function mkCitation(docId, question, version) {
  const c = {
    id: uid('cit'), docId, question, keywords: [], snippet: '', docVersion: version,
    askedBy: viewer.id, score: 5, gateId: null, createdAt: nowIso(), ordinal: 0
  }
  await db.qaCitations.add(c)
  return c
}
async function mkResolvedGap(docId, question) {
  const t = {
    id: uid('gap'), question, detail: '', status: GAP.RESOLVED, createdBy: viewer.id, createdAt: nowIso(),
    claimedBy: owner.id, claimedAt: nowIso(), docId, reviewId: null, groupId: null, resolvedAt: nowIso(),
    timeline: [{ action: 'resolve', by: admin.id, note: '审批通过，答案来源已回填', at: nowIso() }]
  }
  await db.gapTickets.add(t)
  await gap.reload()
  return t
}
// 未解决缺口工单（默认处理中 claimed）
async function mkOpenGap(docId, question, status = GAP.CLAIMED) {
  const t = {
    id: uid('gap'), question, detail: '', status, createdBy: viewer.id, createdAt: nowIso(),
    claimedBy: status === GAP.OPEN ? null : editor.id, claimedAt: status === GAP.OPEN ? null : nowIso(),
    docId: status === GAP.OPEN ? null : docId, reviewId: null, groupId: null,
    timeline: [{ action: status === GAP.OPEN ? 'create' : 'claim', by: editor.id, note: '', at: nowIso() }]
  }
  await db.gapTickets.add(t)
  await gap.reload()
  return t
}
async function mkShare(docId, permission = 'view') {
  const s = {
    id: uid('share'), docId, token: makeToken(), permission,
    createdBy: owner.id, createdAt: nowIso(), expiresAt: null, revokedAt: null
  }
  await db.shares.add(s)
  return s
}

// 把门禁推进到「待负责人确认」（逐项+整体确认）
async function confirmWholeGate(g, confirmer = owner) {
  for (const it of g.impacts) {
    if (it.status === 'pending') {
      const rr = await release.confirmImpact(g.id, it.key, confirmer)
      if (rr.status !== 'ok') throw new Error('confirmImpact 失败: ' + rr.status)
    }
  }
  const rr = await release.confirmGate(g.id, '', confirmer)
  if (rr.status !== 'ok') throw new Error('confirmGate 失败: ' + rr.status)
  return rr
}

// ---------- 0. 纯函数：四维度评估与豁免资格 ----------
console.log('\n[0] 统一治理状态机：四维度评估纯函数')
const d0 = await mkDoc()
let checks = evaluateGateChecks({ doc: d0 }, nowIso())
assert(checks.length === 4 && checks.every((c) => c.status === CHECK_STATUS.PASS), '无任何在途治理事项时四维度全部通过')
assert(checks.map((c) => c.key).join(',') === [CHECK_KEY.REVIEW, CHECK_KEY.FRESH, CHECK_KEY.GAP, CHECK_KEY.RETIRE].join(','), '检查维度顺序：评审/保鲜/缺口/退役')
// 保鲜阻断（到点）
const d0Due = { ...d0, freshness: { cycleDays: 30, nextDueAt: new Date(Date.now() - 1000).toISOString(), activeTicket: null } }
const freshCk = evaluateGateChecks({ doc: d0Due }, nowIso()).find((c) => c.key === CHECK_KEY.FRESH)
assert(freshCk.status === CHECK_STATUS.BLOCKED && freshCk.severity === CHECK_SEVERITY.SOFT && freshCk.blockers[0].id === 'due', '保鲜到点 → 软阻断（due）')
assert(canSignOffCheck(freshCk, { userId: owner.id, role: 'editor', isOwner: true }) === true, '文档负责人可豁免保鲜维度')
assert(canSignOffCheck(freshCk, { userId: editor.id, role: 'editor', isOwner: false }) === false, '非负责编辑者不可豁免保鲜维度')
// 缺口阻断（编辑者可豁免）
const gapCk = evaluateGateChecks({ doc: d0, openGapTickets: [{ id: 'g1', question: 'Q?', status: GAP.CLAIMED }] }, nowIso()).find((c) => c.key === CHECK_KEY.GAP)
assert(gapCk.status === CHECK_STATUS.BLOCKED && canSignOffCheck(gapCk, { userId: editor.id, role: 'editor' }) === true, '未解决缺口 → 软阻断，编辑者可豁免')
assert(canSignOffCheck(gapCk, { userId: viewer.id, role: 'viewer' }) === false, '只读成员不可豁免缺口维度')
// 评审/退役硬阻断不可豁免
const reviewCk = evaluateGateChecks({ doc: d0, openReview: { id: 'r1', status: REVIEW.PENDING } }, nowIso()).find((c) => c.key === CHECK_KEY.REVIEW)
assert(reviewCk.severity === CHECK_SEVERITY.HARD && canSignOffCheck(reviewCk, { userId: admin.id, role: 'admin' }) === false, '评审结论为硬阻断，管理员也不能豁免（须在评审通道处置）')
const retireCk = evaluateGateChecks({ doc: d0, activeRetirement: { id: 'rt1', status: RETIRE.APPROVED } }, nowIso()).find((c) => c.key === CHECK_KEY.RETIRE)
assert(retireCk.status === CHECK_STATUS.BLOCKED && retireCk.severity === CHECK_SEVERITY.HARD, '已退役 → 硬阻断')

// ---------- 1. 提交门禁的资格与关联收集（无阻断直接进入待确认） ----------
console.log('\n[1] 提交门禁：资格校验与影响项自动关联')
const d1 = await mkDoc()
await saveVersion(d1.id, { body: '<p>新正文 Vue 初始化 Dexie 查询 权限模型 新增鉴权说明</p>' }, editor)
const cit1 = await mkCitation(d1.id, '权限模型里有哪些角色?', 1)
const ticket1 = await mkResolvedGap(d1.id, 'Dexie 怎么进行查询?')
const share1 = await mkShare(d1.id, 'view')

let r = await release.submitGate({ docId: d1.id }, null)
assert(r.status === 'guest', '访客不能提交发布门禁')
r = await release.submitGate({ docId: d1.id }, viewer)
assert(r.status === 'denied', '只读成员不能提交发布门禁')
r = await release.submitGate({ docId: d1.id }, owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_CONFIRM, '无阻断时提交门禁直接进入待确认影响')
const g1 = r.gate
assert(g1.version === 2 && g1.publishedVersion === 1, '门禁记录候选版本 v2 与已发布版本 v1')
assert(g1.checks.length === 4 && g1.checks.every((c) => c.status === CHECK_STATUS.PASS), '门禁单挂载四维度检查结果且全部通过')
const types = g1.impacts.map((it) => it.type).sort()
assert(types.includes('citation') && types.includes('ticket') && types.includes('share'), '自动关联问答引用/已解决缺口工单/共享链接三类影响项')
assert(g1.impacts.every((it) => it.status === 'pending'), '影响项初始均为待确认')
const d1Gated = await getDoc(d1.id)
assert(isDocGated(d1Gated) === true && d1Gated.release.activeGateId === g1.id, '文档进入门禁态并指向在途门禁')
const pub = publishedSnapshot(d1Gated, g1)
assert(pub.body.includes('旧正文') && !pub.body.includes('新增鉴权说明'), '门禁中对外内容快照为已发布 v1（候选不泄露）')
r = await release.submitGate({ docId: d1.id }, owner)
assert(r.status === 'duplicate', '同一文档存在在途门禁时不可重复提交')
assert(canEditDoc(d1Gated, { userId: editor.id, role: 'editor', openGate: g1 }) === false, '门禁中非管理员不可编辑')
assert(canEditDoc(d1Gated, { userId: admin.id, role: 'admin', openGate: g1 }) === true, '门禁中管理员仍可编辑')
const resEditShare = await share.createShare(d1.id, 'edit', 0, editor)
assert(resEditShare.status === 'denied', '门禁中禁止生成可编辑共享链接')

const d2 = await mkDoc()
r = await release.submitGate({ docId: d2.id }, owner)
assert(r.status === 'no-change', '没有新于发布版的版本时提交门禁被拒绝（no-change）')

// ---------- 2. 阻断建档：未解决缺口（软阻断）+ 编辑者豁免 ----------
console.log('\n[2] 未解决缺口阻断：建档 blocked、原因回写、编辑者豁免放行')
const dGap = await mkDoc({ editors: [owner.id, editor.id] })
await saveVersion(dGap.id, { body: '<p>缺口阻断文档 新内容</p>' }, editor)
const gapOpen = await mkOpenGap(dGap.id, '还有个没解决的问题?', GAP.CLAIMED)
r = await release.submitGate({ docId: dGap.id }, editor)
assert(r.status === 'blocked' && r.gate.status === GATE.BLOCKED, '存在未解决缺口时门禁建立为 blocked')
const gGap = r.gate
const gapCheck = gGap.checks.find((c) => c.key === CHECK_KEY.GAP)
assert(gapCheck.status === CHECK_STATUS.BLOCKED && gapCheck.blockers.some((b) => b.id === gapOpen.id), '缺口维度阻断原因定位到具体工单')
assert(isDocGated(await getDoc(dGap.id)), '阻断态同样锁定文档（对外仍为已发布版）')
// 阻断原因回写到工单 timeline
const gapOpenAfter = await db.gapTickets.get(gapOpen.id)
assert(gapOpenAfter.timeline.some((t) => t.action === 'gate-blocked' && t.gateId === gGap.id), '阻断原因回写到缺口工单时间线')
// 只读/负责人（非编辑角色身份）不能豁免缺口？owner 角色是 editor 且是 owner——gap roles=[admin,editor]，owner 也是 editor 角色，可豁免
assert(canSignOffCheck(gapCheck, { userId: viewer.id, role: 'viewer' }) === false, '只读成员无豁免按钮资格')
r = await release.signOffCheck(gGap.id, CHECK_KEY.FRESH, '', editor)
assert(r.status === 'denied', '对通过维度豁免被拒绝')
// 阻断态不能确认影响
r = await release.confirmGate(gGap.id, '', owner)
assert(r.status === 'denied', '阻断态门禁不可进行影响确认')
// 编辑者豁免缺口维度 → 全部通过 → 待确认
r = await release.signOffCheck(gGap.id, CHECK_KEY.GAP, '本次发布不涉及该工单答案', editor)
assert(r.status === 'ok' && r.cleared === true && r.gate.status === GATE.PENDING_CONFIRM, '编辑者豁免缺口维度后进入影响确认')
const gGap2 = release.gateById(gGap.id)
const gapCheck2 = gGap2.checks.find((c) => c.key === CHECK_KEY.GAP)
assert(gapCheck2.status === CHECK_STATUS.PASS && gapCheck2.waiver?.by === editor.id, '缺口维度记录豁免人与说明')
await release.withdrawGate(gGap.id, editor)

// ---------- 3. 阻断建档：知识保鲜到点（软阻断）+ 负责人豁免 ----------
console.log('\n[3] 知识保鲜阻断：负责人豁免 / 外部消除后重新评估')
const dFresh = await mkDoc()
await saveVersion(dFresh.id, { body: '<p>保鲜阻断文档 新内容</p>' }, owner)
await freshness.setFreshCycle(dFresh.id, 30, owner)
// 手动把到期点拨到过去，模拟周期到点（尚未生成复核单）
await db.docs.update(dFresh.id, { 'freshness.nextDueAt': new Date(Date.now() - 60000).toISOString() })
await kb.reloadDocs()
r = await release.submitGate({ docId: dFresh.id }, owner)
assert(r.status === 'blocked', '保鲜到点时门禁建立为 blocked')
const gFresh = r.gate
const freshCheck = gFresh.checks.find((c) => c.key === CHECK_KEY.FRESH)
assert(freshCheck.status === CHECK_STATUS.BLOCKED && freshCheck.blockers[0].id === 'due', '保鲜维度阻断原因为周期到点')
// 编辑者不能豁免保鲜；重新评估时仍阻断
r = await release.signOffCheck(gFresh.id, CHECK_KEY.FRESH, '', editor)
assert(r.status === 'denied', '非负责编辑者不可豁免保鲜维度')
r = await release.recheckGate(gFresh.id, owner)
assert(r.status === 'ok' && r.cleared === false, '未处置时重新评估仍阻断')
// 关闭保鲜（负责人权限）消除阻断 → 重新评估通过
await freshness.disableFreshness(dFresh.id, owner)
r = await release.recheckGate(gFresh.id, owner)
assert(r.status === 'ok' && r.cleared === true && r.gate.status === GATE.PENDING_CONFIRM, '外部消除保鲜阻断后重新评估进入影响确认')
assert(release.gateById(gFresh.id).checks.find((c) => c.key === CHECK_KEY.FRESH).status === CHECK_STATUS.PASS, '保鲜维度复检为通过（无豁免）')
await release.withdrawGate(gFresh.id, owner)

// 保鲜复核单阻断 + 负责人豁免路径
const dFresh2 = await mkDoc()
await saveVersion(dFresh2.id, { body: '<p>保鲜复核单阻断 新内容</p>' }, owner)
await db.freshnessTickets.add({
  id: uid('fresh'), docId: dFresh2.id, status: FRESH.OPEN, round: 3, dueAt: nowIso(),
  ruleSource: 'doc', cycleDays: 30, createdAt: nowIso(), timeline: []
})
r = await release.submitGate({ docId: dFresh2.id }, owner)
assert(r.status === 'blocked' && r.gate.checks.find((c) => c.key === CHECK_KEY.FRESH).blockers[0].id.startsWith('fresh'), '流转中保鲜复核单阻断')
const gFresh2 = r.gate
const ftAfter = await db.freshnessTickets.toCollection().last()
assert(ftAfter.timeline.some((t) => t.action === 'gate-blocked' && t.gateId === gFresh2.id), '阻断原因回写到保鲜复核单时间线')
r = await release.signOffCheck(gFresh2.id, CHECK_KEY.FRESH, '确认本轮修订已覆盖保鲜要求', owner)
assert(r.status === 'ok' && r.cleared && r.gate.status === GATE.PENDING_CONFIRM, '文档负责人可豁免保鲜复核单阻断')
await release.withdrawGate(gFresh2.id, owner)

// ---------- 4. 硬阻断：评审结论 → 评审中前置拒绝；门禁流转中新发起评审则放行前复检阻断 ----------
console.log('\n[4] 评审结论硬阻断：提交前置拒绝 + 流转中新增评审在放行前复检拦截')
const dRev = await mkDoc()
await saveVersion(dRev.id, { body: '<p>评审阻断 候选内容</p>' }, owner)
// 管理员发起一张内容评审单
const rr0 = await review.submitReview(dRev.id, {
  title: (await getDoc(dRev.id)).title,
  body: '<p>评审阻断 候选内容</p>',
  categoryId: 'c', tagIds: [], visibility: 'public'
}, '先评审', admin)
assert(rr0.status === 'ok', '管理员发起评审单成功')
r = await release.submitGate({ docId: dRev.id }, admin)
assert(r.status === 'in-review', '评审中的文档提交门禁被前置拒绝（in-review）')
// 管理员驳回评审解除占用
await review.decideReview(rr0.review.id, 'reject', '先不走评审', admin)

// 门禁在待审批阶段，流转中新发起评审 → 放行前复检退回 blocked，且不可豁免
const dRev2 = await mkDoc()
await saveVersion(dRev2.id, { body: '<p>流转中新增评审 新内容</p>' }, admin)
r = await release.submitGate({ docId: dRev2.id }, admin)
assert(r.status === 'ok', '无阻断时提交成功')
const gRev2 = r.gate
await confirmWholeGate(gRev2, admin)
// 待审批阶段新发起一张评审单（管理员通道，评审与门禁并存由复检拦截）
const rrMid = await review.submitReview(dRev2.id, {
  title: (await getDoc(dRev2.id)).title,
  body: '<p>流转中新增评审 新内容</p>',
  categoryId: 'c', tagIds: [], visibility: 'public'
}, '门禁中补评审', admin)
assert(rrMid.status === 'ok', '门禁待审批期间可发起评审单')
r = await release.decideGate(gRev2.id, 'approve', '', admin)
assert(r.status === 'blocked' && r.gate.status === GATE.BLOCKED, '放行前复检发现评审单，退回 blocked')
const midRevCheck = release.gateById(gRev2.id).checks.find((c) => c.key === CHECK_KEY.REVIEW)
assert(midRevCheck.status === CHECK_STATUS.BLOCKED && midRevCheck.severity === CHECK_SEVERITY.HARD, '评审维度为硬阻断')
r = await release.signOffCheck(gRev2.id, CHECK_KEY.REVIEW, '', admin)
assert(r.status === 'denied', '评审硬阻断不可豁免')
// 管理员驳回该评审 → 复检通过 → 重新确认放行
await review.decideReview(rrMid.review.id, 'reject', '撤回补评审', admin)
r = await release.recheckGate(gRev2.id, admin)
assert(r.status === 'ok' && r.cleared && r.gate.status === GATE.PENDING_CONFIRM, '评审结案后复检通过回到影响确认')
await confirmWholeGate(release.gateById(gRev2.id), admin)
r = await release.decideGate(gRev2.id, 'approve', '', admin)
assert(r.status === 'ok' && r.gate.status === GATE.RELEASED, '评审阻断消除后审批放行成功')

// ---------- 5. 硬阻断：退役关系（已退役 / 退役审批中 / 作为替代文档） ----------
console.log('\n[5] 退役关系硬阻断：撤销退役/审批结案后复检通过')
const dRet = await mkDoc()
await saveVersion(dRet.id, { body: '<p>退役阻断 新内容</p>' }, owner)
// 直接落一条生效退役（doc.retirement 同步）
const retId = uid('ret')
await db.retirements.add({
  id: retId, docId: dRet.id, docTitle: dRet.title, replacementDocId: d1.id, replacementTitle: '替',
  status: RETIRE.APPROVED, initiatedBy: owner.id, decidedBy: admin.id, createdAt: nowIso(), decidedAt: nowIso(),
  reason: '', timeline: []
})
await db.docs.update(dRet.id, { retirement: { id: retId, status: RETIRE.APPROVED, replacementDocId: d1.id } })
await kb.reloadDocs()
await retirement.reload()
r = await release.submitGate({ docId: dRet.id }, admin)
assert(r.status === 'denied', '已退役文档只读归档，管理员也不可提交门禁')

// 退役审批中（pending）→ 硬阻断建档
const dRet2 = await mkDoc()
await saveVersion(dRet2.id, { body: '<p>退役审批中 新内容</p>' }, owner)
const ret2Id = uid('ret')
await db.retirements.add({
  id: ret2Id, docId: dRet2.id, docTitle: dRet2.title, replacementDocId: d1.id, replacementTitle: '替',
  status: RETIRE.PENDING, initiatedBy: owner.id, createdAt: nowIso(), reason: '', timeline: []
})
await retirement.reload()
r = await release.submitGate({ docId: dRet2.id }, owner)
assert(r.status === 'blocked' && r.gate.checks.find((c) => c.key === CHECK_KEY.RETIRE).blockers[0].id === ret2Id, '退役审批中 → 门禁阻断并定位退役单')
const gRet2 = r.gate
// 撤销退役申请后复检通过
await retirement.cancelRetirement(ret2Id, owner)
r = await release.recheckGate(gRet2.id, owner)
assert(r.status === 'ok' && r.cleared && r.gate.status === GATE.PENDING_CONFIRM, '退役申请撤销后复检通过')
await release.withdrawGate(gRet2.id, owner)

// ---------- 6. 负责人确认影响 → 待管理员审批 ----------
console.log('\n[6] 负责人逐项确认影响并整体确认')
r = await release.confirmGate(g1.id, '', editor)
assert(r.status === 'denied', '非负责人不能整体确认影响')
r = await release.confirmGate(g1.id, '', owner)
assert(r.status === 'unconfirmed', '影响项未逐项确认时整体确认被拒绝')
for (const it of g1.impacts) {
  const rr = await release.confirmImpact(g1.id, it.key, owner)
  assert(rr.status === 'ok', '负责人逐项确认：' + it.type)
}
const g1b = release.gateById(g1.id)
assert(g1b.impacts.every((it) => it.status === 'confirmed'), '全部影响项已确认')
const rrDup = await release.confirmImpact(g1.id, g1b.impacts[0].key, owner)
assert(rrDup.status === 'changed', '已确认影响项不可重复确认')
r = await release.confirmGate(g1.id, '影响可接受', owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_APPROVAL, '整体确认后进入待管理员审批')

// ---------- 7. 管理员驳回 + 重新发起时影响状态恢复 ----------
console.log('\n[7] 管理员驳回 → 重新发起门禁时恢复已确认影响')
const d3 = await mkDoc()
await saveVersion(d3.id, { body: '<p>d3 新内容 鉴权链路更新</p>' }, owner)
await mkCitation(d3.id, '鉴权如何设计?', 1)
r = await release.submitGate({ docId: d3.id }, owner)
const g3 = r.gate
await confirmWholeGate(g3, owner)
r = await release.decideGate(g3.id, 'reject', '内容需补充', editor)
assert(r.status === 'denied', '非管理员不能审批门禁')
r = await release.decideGate(g3.id, 'reject', '内容需补充', admin)
assert(r.status === 'ok' && r.gate.status === GATE.REJECTED, '管理员驳回门禁')
const d3After = await getDoc(d3.id)
assert(!isDocGated(d3After), '驳回后文档解除门禁态')
assert(d3After.body.includes('旧正文') && !d3After.body.includes('鉴权链路更新'), '驳回后正文恢复/保持已发布旧版，候选内容作废')
const v3Badge = d3After.versions.find((v) => v.version === 2)?.gate?.status
assert(v3Badge === GATE.REJECTED, '候选版本记录回写「门禁驳回」标记')
const g3After = release.gateById(g3.id)
assert(g3After.impacts.every((it) => it.status === 'pending'), '驳回后影响项状态还原为待确认')

// 修订后重新发起：同一引用影响项应自动恢复为已确认
await saveVersion(d3.id, { body: '<p>d3 修订后 鉴权链路更新 补充说明</p>' }, owner)
r = await release.submitGate({ docId: d3.id }, owner)
assert(r.status === 'ok', '驳回后修订可重新发起门禁')
const g3r = r.gate
assert(g3r.restoredFromGateId === g3.id, '新门禁记录恢复来源为上轮门禁')
assert(g3r.impacts.some((it) => it.status === 'confirmed' && it.restoredFromGateId === g3.id), '重新发起后上轮已确认影响自动恢复确认态（状态恢复）')
assert(g3r.timeline.some((t) => t.action === 'impact-restore'), '状态恢复写入门禁时间线')
r = await release.confirmGate(g3r.id, '', owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_APPROVAL, '恢复确认后无需逐项重认，可直接整体确认')
r = await release.decideGate(g3r.id, 'reject', '仍需修改', admin)
assert(r.status === 'ok', '再次驳回成功（供后续撤回场景清理）')

// ---------- 8. 编辑者撤回 ----------
console.log('\n[8] 编辑者撤回门禁（含阻断态撤回）')
const d4 = await mkDoc()
await saveVersion(d4.id, { body: '<p>d4 新内容</p>' }, owner)
r = await release.submitGate({ docId: d4.id }, owner)
const g4 = r.gate
r = await release.withdrawGate(g4.id, editor)
assert(r.status === 'denied', '非发起人不能撤回他人门禁')
r = await release.withdrawGate(g4.id, owner)
assert(r.status === 'ok' && r.gate.status === GATE.WITHDRAWN, '发起人可撤回门禁')
const d4After = await getDoc(d4.id)
assert(!isDocGated(d4After) && d4After.body.includes('旧正文'), '撤回后解除门禁且正文保持已发布版')
await saveVersion(d4.id, { body: '<p>d4 更新后再次送门禁 新内容</p>' }, owner)
r = await release.submitGate({ docId: d4.id }, owner)
assert(r.status === 'ok', '撤回后可再次提交门禁')
await release.withdrawGate(r.gate.id, owner)
// 阻断态也可撤回
await mkOpenGap(d4.id, '撤回阻断工单?', GAP.OPEN)
// open 工单 docId 为 null，直接挂上
const openT = await db.gapTickets.toCollection().last()
await db.gapTickets.update(openT.id, { docId: d4.id })
await gap.reload()
await saveVersion(d4.id, { body: '<p>d4 阻断态撤回 新内容</p>' }, owner)
r = await release.submitGate({ docId: d4.id }, owner)
assert(r.status === 'blocked', '缺口阻断态门禁建立')
r = await release.withdrawGate(r.gate.id, owner)
assert(r.status === 'ok' && r.gate.status === GATE.WITHDRAWN, '阻断态门禁可由发起人撤回')

// ---------- 9. 审批放行：版本发布 + 问答引用切新版 + 链接状态回写 ----------
console.log('\n[9] 管理员审批放行：回写版本发布、引用与链接状态')
r = await release.decideGate(g1.id, 'approve', '', editor)
assert(r.status === 'denied', '非管理员不能放行门禁')
r = await release.decideGate(g1.id, 'approve', '同意发布', admin)
assert(r.status === 'ok' && r.gate.status === GATE.RELEASED, '管理员审批放行成功')
const d1Rel = await getDoc(d1.id)
assert(d1Rel.body.includes('新增鉴权说明') && !d1Rel.body.includes('旧正文'), '放行后候选 v2 内容回写文档对外可见')
assert(!isDocGated(d1Rel) && d1Rel.release.state === RELEASE_STATE.NORMAL && d1Rel.release.publishedVersion === 2, '文档解除门禁态，已发布版本指向 v2')
const v2 = d1Rel.versions.find((v) => v.version === 2)
assert(v2.gate?.status === GATE.RELEASED, '版本记录回写「门禁放行」标记')
const cit1After = await db.qaCitations.get(cit1.id)
assert(cit1After.docVersion === 2 && cit1After.gateId === g1.id, '关联问答引用回写为新版本 v2')
const share1After = await db.shares.get(share1.id)
assert(isShareActive(share1After) && share1After.gateId === g1.id && share1After.gateVersion === 2, '共享链接保持有效并回写已同步的新版本')
const ticket1After = await db.gapTickets.get(ticket1.id)
assert(ticket1After.status === GAP.RESOLVED && ticket1After.docId === d1.id, '缺口工单状态与答案来源不变')
assert(ticket1After.timeline.some((t) => t.action === 'version-publish'), '缺口工单留有「版本发布」痕迹')
const g1Rel = release.gateById(g1.id)
assert(g1Rel.impacts.every((it) => it.status === 'released'), '全部影响项回写为已随版本发布')
assert(g1Rel.effects.releasedCitationIds.includes(cit1.id), '门禁结果记录已切换的引用')
assert(g1Rel.effects.syncedShareIds.includes(share1.id), '门禁结果记录已同步的链接')

// ---------- 10. 放行前复检：审批期间保鲜到点 → 退回阻断态 ----------
console.log('\n[10] 放行前最终复检：新出现阻断时退回 blocked')
const dRe = await mkDoc()
await freshness.setFreshCycle(dRe.id, 30, owner)
await saveVersion(dRe.id, { body: '<p>复检阻断文档 新内容</p>' }, owner)
r = await release.submitGate({ docId: dRe.id }, owner)
assert(r.status === 'ok', '提交时保鲜未到点，检查通过')
const gRe = r.gate
await confirmWholeGate(gRe, owner)
// 审批期间保鲜到点
await db.docs.update(dRe.id, { 'freshness.nextDueAt': new Date(Date.now() - 1000).toISOString() })
await kb.reloadDocs()
r = await release.decideGate(gRe.id, 'approve', '', admin)
assert(r.status === 'blocked' && r.gate.status === GATE.BLOCKED, '放行前复检发现保鲜阻断，门禁退回 blocked')
const reCheck = release.gateById(gRe.id).checks.find((c) => c.key === CHECK_KEY.FRESH)
assert(reCheck.status === CHECK_STATUS.BLOCKED, '门禁保鲜维度复检为阻断')
// 负责人外部处置：关闭保鲜 → 重新评估通过（豁免后状态为 pending_confirm，影响仍为已确认）
await freshness.disableFreshness(dRe.id, owner)
r = await release.recheckGate(gRe.id, owner)
assert(r.status === 'ok' && r.gate.status === GATE.PENDING_CONFIRM, '保鲜阻断外部消除并复检通过，回到影响确认')
r = await release.confirmGate(gRe.id, '', owner)
assert(r.status === 'ok', '影响仍为已确认，可直接再次提交审批')
r = await release.decideGate(gRe.id, 'approve', '', admin)
assert(r.status === 'ok' && r.gate.status === GATE.RELEASED, '阻断解除后审批放行成功')

// ---------- 11. 回退已放行版本 + 回退后重新发布的状态恢复 ----------
console.log('\n[11] 管理员回退：正文/引用/链接状态还原，重新发布恢复确认')
r = await release.rollbackGate(g1.id, '', owner)
assert(r.status === 'denied', '非管理员不能回退版本')
r = await release.rollbackGate(g1.id, '发现严重问题', admin)
assert(r.status === 'ok' && r.gate.status === GATE.ROLLED_BACK, '管理员回退成功')
const d1Rb = await getDoc(d1.id)
assert(d1Rb.body.includes('旧正文') && !d1Rb.body.includes('新增鉴权说明'), '回退后正文恢复到 v1')
assert(d1Rb.release.publishedVersion === 1, '已发布版本恢复指向 v1')
const v2Rb = d1Rb.versions.find((v) => v.version === 2)
assert(v2Rb.gate?.status === GATE.ROLLED_BACK, '被回退版本记录回写「已回退」标记')
const cit1Rb = await db.qaCitations.get(cit1.id)
assert(cit1Rb.docVersion === 1, '问答引用恢复到旧版本 v1')
const share1Rb = await db.shares.get(share1.id)
assert(isShareActive(share1Rb) && !share1Rb.gateId, '共享链接仍有效且发布同步标记已清除')
const g1Rb = release.gateById(g1.id)
assert(g1Rb.impacts.every((it) => it.status === 'reverted'), '影响项回写为已随回退还原')
// 回退后重新发起门禁：上轮已生效影响恢复确认态（先保存修订后的新版本）
await saveVersion(d1.id, { body: '<p>新正文 新增鉴权说明 二次发布</p>' }, owner)
r = await release.submitGate({ docId: d1.id }, owner)
assert(r.status === 'ok', '回退后可重新发起门禁')
assert(r.gate.impacts.some((it) => it.status === 'confirmed' && it.restoredFromGateId === g1.id), '回退后重新发布恢复上轮影响确认状态')
await release.withdrawGate(r.gate.id, owner)

// ---------- 12. store 查询与角标 ----------
console.log('\n[12] store 查询与角标（含阻断待办）')
assert(release.openGateOfDoc(d1.id) === null, '已结案门禁不再被视为在途门禁')
const d5 = await mkDoc({ ownerId: owner.id, editors: [owner.id, editor.id] })
await saveVersion(d5.id, { body: '<p>d5 新内容 待确认</p>' }, editor)
r = await release.submitGate({ docId: d5.id }, editor)
assert(r.status === 'ok', '协作编辑者可对协作文档提交门禁')
assert(release.pendingConfirmFor(owner.id, 'editor').length >= 1, '负责人视角有待确认门禁')
assert(release.pendingConfirmFor(editor.id, 'editor').length === 0, '非负责人看不到他人待确认门禁')
assert(release.pendingApprovalFor('admin').length === 0, '当前无待审批门禁')
assert(release.pendingCountFor(owner.id, 'editor') >= 1, '负责人侧栏角标计数正确')
await release.withdrawGate(r.gate.id, editor)
// 阻断待办：缺口阻断时编辑者可见
await mkOpenGap(d5.id, '角标工单?', GAP.CLAIMED)
const t5 = (await db.gapTickets.where('docId').equals(d5.id).toArray())[0]
await saveVersion(d5.id, { body: '<p>d5 阻断待办</p>' }, editor)
r = await release.submitGate({ docId: d5.id }, editor)
assert(r.status === 'blocked', '缺口阻断门禁建立')
assert(release.blockedFor(editor.id, 'editor').some((g) => g.id === r.gate.id), '编辑者可见缺口阻断待办')
assert(release.pendingCountFor(editor.id, 'editor') >= 1, '阻断待办计入侧栏角标')

// ---------- 13. 删除带在途门禁的文档 ----------
console.log('\n[13] 删除文档联动关闭门禁与清理引用')
const del = await kb.deleteDoc(d5.id, admin)
assert(del.status === 'ok', '管理员删除带在途门禁的文档成功')
const g5 = release.gatesOfDoc(d5.id)[0]
assert(g5 && g5.status === GATE.WITHDRAWN && g5.timeline.some((t) => t.action === 'doc-delete'), '在途门禁随文档删除关闭并留痕')
const citCount = await db.qaCitations.where('docId').equals(d5.id).count()
assert(citCount === 0, '问答引用记录随文档清理')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
