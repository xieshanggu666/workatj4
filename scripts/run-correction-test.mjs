// 知识纠错处置闭环：端到端冒烟测试（fake-indexeddb + 真实 store）
// 运行：npm run test:correction（esbuild 打包后在 node 中执行）
import 'fake-indexeddb/auto'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { db } from '@/db'
import { useCorrectionStore } from '@/stores/correction'
import { useReviewStore } from '@/stores/review'
import { useKbStore } from '@/stores/kb'
import { CORRECTION } from '@/utils/correction'
import { REVIEW, PUBLISH } from '@/utils/review'

const pinia = createPinia()
createApp({ render: () => null }).use(pinia)
const correction = useCorrectionStore(pinia)
const review = useReviewStore(pinia)
const kb = useKbStore(pinia)

const member = { id: 'u-m', role: 'viewer', name: '只读成员甲' }
const member2 = { id: 'u-m2', role: 'viewer', name: '只读成员乙' }
const editor = { id: 'u-edit', role: 'editor', name: '编辑甲' }
const editor2 = { id: 'u-edit2', role: 'editor', name: '编辑乙' }
const admin = { id: 'u-admin', role: 'admin', name: '管理员' }

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ✅', msg) }
  else { failed++; console.error('  ❌', msg) }
}

async function mkDoc(title, owner = editor) {
  const doc = {
    id: 'doc-' + Math.random().toString(36).slice(2, 8),
    title, body: '<p>旧的错误正文</p>', categoryId: 'c-dev', tagIds: [],
    visibility: 'team', ownerId: owner.id, editors: [owner.id], publishState: PUBLISH.PUBLISHED,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    versions: [{ version: 1, savedAt: new Date().toISOString(), savedBy: owner.id, note: '初始', snapshot: { title, body: '<p>旧的错误正文</p>', categoryId: 'c-dev', tagIds: [], visibility: 'team' } }]
  }
  await db.docs.add(doc)
  await kb.reloadDocs()
  return doc
}

const fixedPatch = (doc) => ({ title: doc.title, body: '<p>修订后的正确正文</p>', categoryId: doc.categoryId, tagIds: [], visibility: 'team' })

// ---------- 1. 成员提交纠错并关联文档 ----------
console.log('\n[1] 只读成员提交错误并关联文档 → submitted')
const doc1 = await mkDoc('有错的手册')
let r = await correction.createTicket({
  docId: doc1.id, type: 'factual', description: '第 1 节结论写反了', expected: '应该是 A 而不是 B', source: 'qa'
}, member)
assert(r.status === 'ok', '纠错单创建成功')
const t1 = r.ticket
assert(t1.status === CORRECTION.SUBMITTED && t1.docId === doc1.id && t1.createdBy === member.id, '状态为待处理且关联文档与提交人')
assert(t1.type === 'factual' && t1.source === 'qa', '错误类型与来源（问答引用）已记录')

// 访客不可提交
r = await correction.createTicket({ docId: doc1.id, description: 'x' }, null)
assert(r.status === 'guest', '访客不能提交纠错')
// 缺描述/文档拒绝
r = await correction.createTicket({ docId: doc1.id, description: '' }, member)
assert(r.status === 'invalid', '缺少错误描述拒绝提交')
r = await correction.createTicket({ docId: 'doc-nope', description: 'x' }, member)
assert(r.status === 'doc-missing', '关联不存在文档拒绝提交')
// 同文档同描述同人去重
r = await correction.createTicket({ docId: doc1.id, type: 'other', description: '第 1 节结论写反了' }, member)
assert(r.status === 'duplicate', '同文档相同描述的在途纠错单去重')

// ---------- 2. 编辑者认领 ----------
console.log('\n[2] 认领：编辑者可认领；只读成员不可；重复认领被拒')
r = await correction.claimTicket(t1.id, member)
assert(r.status === 'denied', '只读成员不能认领')
r = await correction.claimTicket(t1.id, editor)
assert(r.status === 'ok', '编辑者认领成功')
let t1f = await db.correctionTickets.get(t1.id)
assert(t1f.status === CORRECTION.CLAIMED && t1f.claimedBy === editor.id, '纠错单进入修订中并记录修订人')
r = await correction.claimTicket(t1.id, editor2)
assert(r.status === 'changed', '已被认领的单不能重复认领')

// ---------- 3. 修订送审（复用评审通道，单事务）----------
console.log('\n[3] 修订送审：建评审单 + 锁文档 + 纠错单送审中，同事务')
r = await review.submitCorrectionReview(t1.id, doc1.id, fixedPatch(doc1), '修正结论', editor)
assert(r.status === 'ok', '纠错修订送审成功')
const rev1 = r.review
assert(rev1.correctionTicketId === t1.id, '评审单携带纠错单关联')
t1f = await db.correctionTickets.get(t1.id)
assert(t1f.status === CORRECTION.IN_REVIEW && t1f.reviewId === rev1.id, '纠错单进入送审中并关联评审单')
const doc1Locked = await db.docs.get(doc1.id)
assert(doc1Locked.publishState === PUBLISH.IN_REVIEW && doc1Locked.activeReviewId === rev1.id, '文档进入评审中并锁定')
assert(doc1Locked.body === '<p>旧的错误正文</p>', '锁定期间旧内容继续可见，修订不提前泄露')

// 并发保护：送审后再次送审被拒（单据已非本人修订中）
r = await review.submitCorrectionReview(t1.id, doc1.id, fixedPatch(doc1), '', editor)
assert(r.status === 'ticket-changed', '非修订中状态的纠错单不能再次送审')
// 同文档重复评审单拦截
const doc2 = await mkDoc('另一本手册', editor2)
const tOther = (await correction.createTicket({ docId: doc2.id, description: '也有错' }, member2)).ticket
await correction.claimTicket(tOther.id, editor2)
r = await review.submitCorrectionReview(tOther.id, doc1.id, fixedPatch(doc1), '', editor2)
assert(r.status === 'duplicate', '文档已有流转中评审单时送审被拒')

// ---------- 4. 审批通过 → 回写新版本 + 问答引用回写 ----------
console.log('\n[4] 管理员审批通过 → 回写新版本、纠错单回填版本号并结案')
r = await review.decideReview(rev1.id, 'approve', '修正准确', admin)
assert(r.status === 'ok', '审批通过')
const doc1Fixed = await db.docs.get(doc1.id)
assert(doc1Fixed.body === '<p>修订后的正确正文</p>', '修订内容已回写文档（问答检索随即命中新内容）')
assert(doc1Fixed.publishState === PUBLISH.PUBLISHED && !doc1Fixed.activeReviewId, '文档解除评审锁定')
assert(doc1Fixed.versions.length === 2, '追加了新版本（v2）')
const v2 = doc1Fixed.versions[1]
assert(v2.note.includes('纠错') && v2.correction?.ticketId === t1.id && v2.reviewStatus === REVIEW.APPROVED, '版本记录带纠错修订与审批标记')
t1f = await db.correctionTickets.get(t1.id)
assert(t1f.status === CORRECTION.RESOLVED && t1f.resolvedVersion === 2 && !!t1f.resolvedAt, '纠错单已解决并回填修订版本号 v2')

// 非管理员不能审批
const tForDeny = (await correction.createTicket({ docId: doc2.id, description: '权限审批测试' }, member)).ticket
await correction.claimTicket(tForDeny.id, editor2)
const revDeny = (await review.submitCorrectionReview(tForDeny.id, doc2.id, fixedPatch(doc2), '', editor2)).review
r = await review.decideReview(revDeny.id, 'approve', '', editor2)
assert(r.status === 'denied', '非管理员审批被拒绝')

// ---------- 5. 驳回 → 退回修订中，可修订后重新送审 ----------
console.log('\n[5] 审批驳回 → 纠错单退回修订中；重新送审后可通过')
r = await review.decideReview(revDeny.id, 'reject', '改得不对', admin)
assert(r.status === 'ok', '驳回成功')
let td = await db.correctionTickets.get(tForDeny.id)
assert(td.status === CORRECTION.CLAIMED && !td.reviewId, '纠错单退回修订中并解除评审单关联')
const doc2Unlocked = await db.docs.get(doc2.id)
assert(doc2Unlocked.publishState === PUBLISH.PUBLISHED, '驳回后文档解锁且内容不变')
assert(doc2Unlocked.body === '<p>旧的错误正文</p>', '驳回不改文档内容')
// 重新送审 → 通过
const revDeny2 = (await review.submitCorrectionReview(tForDeny.id, doc2.id, fixedPatch(doc2), '二次修订', editor2)).review
r = await review.decideReview(revDeny2.id, 'approve', '', admin)
assert(r.status === 'ok', '二次送审审批通过')
td = await db.correctionTickets.get(tForDeny.id)
assert(td.status === CORRECTION.RESOLVED && td.resolvedVersion === 2, '重新送审通过后结案并回填 v2')

// ---------- 6. 修订人撤回评审 → 退回修订中 ----------
console.log('\n[6] 送审后修订人撤回评审 → 退回修订中')
const doc3 = await mkDoc('撤回手册', editor)
const tW = (await correction.createTicket({ docId: doc3.id, description: '撤回测试错误' }, member)).ticket
await correction.claimTicket(tW.id, editor)
const revW = (await review.submitCorrectionReview(tW.id, doc3.id, fixedPatch(doc3), '', editor)).review
r = await review.withdrawReview(revW.id, editor)
assert(r.status === 'ok', '撤回评审成功')
let tw = await db.correctionTickets.get(tW.id)
assert(tw.status === CORRECTION.CLAIMED && !tw.reviewId, '纠错单退回修订中')
const doc3Unlocked = await db.docs.get(doc3.id)
assert(doc3Unlocked.publishState === PUBLISH.PUBLISHED, '撤回后文档解锁')

// ---------- 7. 异常撤回：提交人撤回待处理/修订中 ----------
console.log('\n[7] 异常撤单：提交人可撤回待处理与修订中；送审中走先撤评审')
const doc4 = await mkDoc('撤回手册二', editor)
const tWd1 = (await correction.createTicket({ docId: doc4.id, description: '提交人撤回-待处理' }, member)).ticket
r = await correction.withdrawTicket(tWd1.id, '', member)
assert(r.status === 'ok', '提交人撤回待处理纠错单')
let twd = await db.correctionTickets.get(tWd1.id)
assert(twd.status === CORRECTION.WITHDRAWN && twd.withdrawnBy === member.id && !!twd.withdrawnAt, '纠错单为已撤回终态并记录撤回人/时间')

const tWd2 = (await correction.createTicket({ docId: doc4.id, description: '提交人撤回-修订中' }, member)).ticket
await correction.claimTicket(tWd2.id, editor)
r = await correction.withdrawTicket(tWd2.id, '误报', member)
assert(r.status === 'ok', '提交人撤回修订中纠错单')
twd = await db.correctionTickets.get(tWd2.id)
assert(twd.status === CORRECTION.WITHDRAWN, '修订中纠错单撤回成功（认领记录保留）')
// 他人不能撤回
const tWd3 = (await correction.createTicket({ docId: doc4.id, description: '他人撤回测试' }, member)).ticket
r = await correction.withdrawTicket(tWd3.id, '', member2)
assert(r.status === 'denied', '非提交人/管理员不能撤回他人纠错单')
// 管理员可代为撤回
r = await correction.withdrawTicket(tWd3.id, '', admin)
assert(r.status === 'ok', '管理员可代为撤回任意在途纠错单')
// 送审中需先撤评审
const tWd4 = (await correction.createTicket({ docId: doc3.id, description: '送审中撤回测试' }, member2)).ticket
await correction.claimTicket(tWd4.id, editor)
const revWd4 = (await review.submitCorrectionReview(tWd4.id, doc3.id, fixedPatch(doc3), '', editor)).review
r = await correction.withdrawTicket(tWd4.id, '', member2)
assert(r.status === 'in-review', '送审中不能直接撤单，需先撤回评审')
r = await review.withdrawReview(revWd4.id, editor)
assert(r.status === 'ok', '先撤回评审单')
r = await correction.withdrawTicket(tWd4.id, '', member2)
assert(r.status === 'ok', '评审撤回后提交人可撤回纠错单')

// ---------- 8. 修订人退回补充信息 ----------
console.log('\n[8] 修订人退回：claimed → submitted，解除认领')
const doc5 = await mkDoc('退回手册', editor)
const tRet = (await correction.createTicket({ docId: doc5.id, description: '描述不清的错误' }, member)).ticket
await correction.claimTicket(tRet.id, editor)
r = await correction.returnTicket(tRet.id, '请补充错误所在段落', editor)
assert(r.status === 'ok', '修订人退回成功')
const tret = await db.correctionTickets.get(tRet.id)
assert(tret.status === CORRECTION.SUBMITTED && !tret.claimedBy, '纠错单退回待处理并解除认领')
assert((tret.timeline || []).some((e) => e.action === 'return'), '退回动作留痕')
// 可被再次认领
r = await correction.claimTicket(tRet.id, editor2)
assert(r.status === 'ok', '补充后可被其他编辑者再次认领')
// 取消认领
r = await correction.releaseTicket(tRet.id, editor2)
assert(r.status === 'ok', '取消认领成功')
const tret2 = await db.correctionTickets.get(tRet.id)
assert(tret2.status === CORRECTION.SUBMITTED && !tret2.claimedBy, '取消认领后回到待处理')

// ---------- 9. 关联文档删除 → 退回待处理并清空关联 ----------
console.log('\n[9] 文档删除联动：在途单退回待处理清空关联；终态单保留结论')
const doc6 = await mkDoc('将删除的手册', editor)
const tDel1 = (await correction.createTicket({ docId: doc6.id, description: '在途单-待处理' }, member)).ticket
const tDel2 = (await correction.createTicket({ docId: doc6.id, description: '在途单-修订中' }, member2)).ticket
await correction.claimTicket(tDel2.id, editor)
const tDel3 = (await correction.createTicket({ docId: doc6.id, description: '已解决单' }, member)).ticket
await correction.claimTicket(tDel3.id, editor)
const revDel3 = (await review.submitCorrectionReview(tDel3.id, doc6.id, fixedPatch(doc6), '', editor)).review
await review.decideReview(revDel3.id, 'approve', '', admin)
await kb.deleteDoc(doc6.id, admin)
const d1 = await db.correctionTickets.get(tDel1.id)
const d2 = await db.correctionTickets.get(tDel2.id)
const d3 = await db.correctionTickets.get(tDel3.id)
assert(d1.status === CORRECTION.SUBMITTED && !d1.docId, '待处理单清空文档指针（本就是待处理）')
assert(d2.status === CORRECTION.SUBMITTED && !d2.docId && !d2.claimedBy, '修订中单退回待处理并清空文档/认领关联')
assert(d3.status === CORRECTION.RESOLVED && !d3.docId && d3.resolvedVersion === 2, '已解决终态单保留结论仅清空文档指针')

// ---------- 10. 原提交人状态追踪 ----------
console.log('\n[10] 提交人视角追踪：ticketsCreatedBy / myOpenTicketForDoc')
await correction.reload()
const mine = correction.ticketsCreatedBy(member.id)
assert(mine.length >= 5, '提交人可查到自己提交的全部纠错单（' + mine.length + '）')
assert(mine.every((t) => t.createdBy === member.id), '追踪列表只含本人提交')
const editing = correction.ticketsClaimedBy(editor2.id)
assert(Array.isArray(editing), '修订人视角列表可用')
const reopened = await db.correctionTickets.get(tRet.id) // 当前待处理、doc5 仍存在
const open = correction.myOpenTicketForDoc(doc5.id, member.id)
assert(open && open.id === tRet.id, 'myOpenTicketForDoc 返回文档上本人的在途纠错单')
assert(correction.myOpenTicketForDoc(doc5.id, member2.id) === null, '他人的在途单不命中')

// ---------- 11. 时间线全程留痕 ----------
console.log('\n[11] timeline 全程留痕')
const full = await db.correctionTickets.get(t1.id)
const actions = (full.timeline || []).map((e) => e.action)
assert(['create', 'claim', 'submit', 'resolve'].every((a) => actions.includes(a)), '完整链路动作均留痕：' + actions.join('/'))

// ---------- 12. 卡单自愈 ----------
console.log('\n[12] 存量卡在送审中的纠错单首次加载自愈')
const doc7 = await mkDoc('自愈手册', editor)
const tHeal = (await correction.createTicket({ docId: doc7.id, description: '自愈测试' }, member)).ticket
await correction.claimTicket(tHeal.id, editor)
const revHeal = (await review.submitCorrectionReview(tHeal.id, doc7.id, fixedPatch(doc7), '', editor)).review
// 模拟历史脏数据：评审单已审批通过，但纠错单未联动（老两步式送审并发审批的产物）
await db.reviews.update(revHeal.id, { status: REVIEW.APPROVED, decidedBy: admin.id, decidedAt: new Date().toISOString() })
// 新 pinia + store 实例（loaded=false），首次加载触发自愈
import { setActivePinia } from 'pinia'
const pinia2 = createPinia()
createApp({ render: () => null }).use(pinia2)
setActivePinia(pinia2)
const correctionFresh = useCorrectionStore()
await correctionFresh.loadAll()
const healed = await db.correctionTickets.get(tHeal.id)
assert(healed.status === CORRECTION.RESOLVED, '卡在送审中（评审已通过）的纠错单自愈为已解决')

console.log(`\n结果：${passed} 通过，${failed} 失败`)
process.exit(failed ? 1 : 0)
