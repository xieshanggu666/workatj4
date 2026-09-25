import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import { CORRECTION, canCreateCorrection } from '@/utils/correction'
import { canEditContent, GUEST_ID } from '@/utils/permission'

// 知识纠错处置闭环 store：
// 成员在文档详情/问答引用处提交错误并关联文档（submitted）→ 编辑者认领修订（claimed）→
// 修订内容送审（in_review，由 review store 的 submitCorrectionReview 单事务建评审单+锁文档+关联）→
// 管理员审批通过（resolved）：评审事务回写新版本，本 store 的 syncCorrectionTicket 在同事务
// 把新版本号回填纠错单（问答引用经检索动态命中文档，回写后自动指向修订内容）；
// 驳回/撤回评审退回修订中。异常处置：提交人可撤回待处理/修订中的纠错单，
// 修订人可退回需补充信息的纠错单，关联文档被删除时退回待处理并清空关联。
export const useCorrectionStore = defineStore('correction', () => {
  const tickets = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 首次加载自愈「卡在送审中」的历史纠错单（关联评审单已完结/丢失但纠错单未联动）
    await reconcileStuckTickets()
  }

  async function reload() {
    tickets.value = await db.correctionTickets.toArray()
  }

  // 待处理数量（侧边栏角标）
  const openCount = computed(() => tickets.value.filter((t) => t.status === CORRECTION.SUBMITTED).length)

  // 文档上流转中的纠错单（详情页展示与问答引用提示）
  function ticketsOfDoc(docId) {
    return tickets.value
      .filter((t) => t.docId === docId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 文档上是否有流转中纠错单
  function openTicketsOfDoc(docId) {
    return ticketsOfDoc(docId).filter((t) =>
      t.status === CORRECTION.SUBMITTED ||
      t.status === CORRECTION.CLAIMED ||
      t.status === CORRECTION.IN_REVIEW
    )
  }

  // 提交人视角：我提交的纠错单（状态追踪页使用）
  function ticketsCreatedBy(userId) {
    return tickets.value
      .filter((t) => t.createdBy === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 修订人视角：我处理中的纠错单
  function ticketsClaimedBy(userId) {
    return tickets.value
      .filter((t) => t.claimedBy === userId && (t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW))
      .sort((a, b) => new Date(b.claimedAt) - new Date(a.claimedAt))
  }

  // 问答页：某文档上我提交的、仍在流转的纠错单（提问命中该文档时提示可追踪）
  function myOpenTicketForDoc(docId, userId) {
    if (!userId) return null
    return tickets.value.find((t) =>
      t.docId === docId && t.createdBy === userId &&
      (t.status === CORRECTION.SUBMITTED || t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW)
    ) || null
  }

  // 成员提交错误并关联文档。访客不可提交；同一文档同一提交人存在相同描述的在途纠错单时去重。
  async function createTicket({ docId, type, description, expected, source }, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (userId === GUEST_ID || !canCreateCorrection(currentUser)) return { status: 'guest' }
    const desc = String(description || '').trim()
    if (!docId || !desc) return { status: 'invalid' }
    let result = { status: 'error' }
    const now = new Date().toISOString()

    await db.transaction('rw', db.docs, db.correctionTickets, async () => {
      const doc = await db.docs.get(docId)
      if (!doc) { result = { status: 'doc-missing' }; return }
      const dupList = await db.correctionTickets
        .where('docId').equals(docId)
        .filter((t) => t.createdBy === userId &&
          (t.status === CORRECTION.SUBMITTED || t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW))
        .toArray()
      const dup = dupList.find((t) => (t.description || '').trim() === desc)
      if (dup) { result = { status: 'duplicate', ticket: dup }; return }

      const ticket = {
        id: uid('cor'),
        docId,
        type: type || 'other',
        description: desc,
        expected: String(expected || '').trim(),
        // 提交来源：doc 文档详情 / qa 问答引用（便于追踪错误是从哪个入口发现的）
        source: source === 'qa' ? 'qa' : 'doc',
        status: CORRECTION.SUBMITTED,
        createdBy: userId,
        createdAt: now,
        claimedBy: null,
        claimedAt: null,
        reviewId: null,
        resolvedVersion: null, // 审批通过后回填的修订版本号
        resolvedAt: null,
        withdrawnBy: null,
        withdrawnAt: null,
        timeline: [buildTimelineEntry('create', userId, '提交' + (source === 'qa' ? '（来自问答引用）' : '') + '错误：' + desc, now)]
      }
      await db.correctionTickets.add(ticket)
      result = { status: 'ok', ticket }
    })

    await reload()
    return result
  }

  // 编辑者认领：submitted → claimed。事务内复核角色与状态
  async function claimTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }
    if (userId === GUEST_ID || !canEditContent(currentUser?.role)) return { status: 'denied' }

    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.SUBMITTED) { result = { status: 'changed', ticket: t }; return }
      await db.correctionTickets.update(id, {
        status: CORRECTION.CLAIMED,
        claimedBy: userId,
        claimedAt: now,
        timeline: [...(t.timeline || []), buildTimelineEntry('claim', userId, '', now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 取消认领：claimed → submitted
  async function releaseTicket(id, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    if (userId === GUEST_ID || !canEditContent(currentUser?.role)) return { status: 'denied' }

    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.CLAIMED || (t.claimedBy !== userId && !isAdmin)) {
        result = { status: 'denied', ticket: t }; return
      }
      await db.correctionTickets.update(id, {
        status: CORRECTION.SUBMITTED,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('release', userId, '', now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 修订人退回补充信息：claimed → submitted，解除认领（提交人可在追踪页补充说明后再被认领）
  async function returnTicket(id, note, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }

    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status !== CORRECTION.CLAIMED || (t.claimedBy !== userId && !isAdmin)) {
        result = { status: 'denied', ticket: t }; return
      }
      await db.correctionTickets.update(id, {
        status: CORRECTION.SUBMITTED,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('return', userId, note || '错误信息不足，退回提交人补充', now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 提交人（或管理员）撤回纠错单：待处理/修订中 → withdrawn（终态，记录保留）。
  // 送审中需先撤回评审单（见 review store.withdrawReview 的联动），此处拒绝并给出引导状态。
  async function withdrawTicket(id, note, currentUser) {
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === 'admin'
    let result = { status: 'error' }
    if (userId === GUEST_ID) return { status: 'denied' }

    await db.transaction('rw', db.correctionTickets, async () => {
      const t = await db.correctionTickets.get(id)
      if (!t) { result = { status: 'missing' }; return }
      if (t.status === CORRECTION.IN_REVIEW) { result = { status: 'in-review', ticket: t }; return }
      const owner = t.createdBy === userId || isAdmin
      if (!owner || (t.status !== CORRECTION.SUBMITTED && t.status !== CORRECTION.CLAIMED && !isAdmin)) {
        result = { status: 'denied', ticket: t }; return
      }
      await db.correctionTickets.update(id, {
        status: CORRECTION.WITHDRAWN,
        claimedBy: t.status === CORRECTION.CLAIMED ? t.claimedBy : null,
        withdrawnBy: userId,
        withdrawnAt: now,
        timeline: [...(t.timeline || []), buildTimelineEntry('withdraw', userId, note || '', now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 审批/撤回复审事务内联动纠错单（由 review store 在同事务调用，tables 需含 db.correctionTickets）。
  // approve：纠错单置为已解决并回填新版本号（版本内容由 review store 回写文档）；
  // reject ：评审驳回 → 退回修订中，解除评审单关联，修订人可继续修订后重新送审；
  // withdraw：修订人撤回评审 → 同 reject，退回修订中。
  async function syncCorrectionTicket(review, action, note, userId, nowIso) {
    if (!review?.correctionTicketId) return
    const ticket = await db.correctionTickets.get(review.correctionTicketId)
    if (!ticket) return
    // 仅联动「送审中」的纠错单：其它状态说明关联已失效（撤回/文档删除后退回等），不覆盖
    if (ticket.status !== CORRECTION.IN_REVIEW) return

    if (action === 'approve') {
      // 新版本号：评审通过时回写的版本序号（review store 内 versions.length + 1）。
      // 此处以文档库内最新版本数为准（与 review store 同事务，读到的即回写后的数组）
      const doc = await db.docs.get(review.docId)
      const versionNo = Array.isArray(doc?.versions) ? doc.versions.length : null
      await db.correctionTickets.update(ticket.id, {
        status: CORRECTION.RESOLVED,
        resolvedVersion: versionNo,
        resolvedAt: nowIso,
        timeline: [...(ticket.timeline || []), buildTimelineEntry('resolve', userId, '审批通过，已回写新版本' + (versionNo ? ' v' + versionNo : '') + '，问答引用指向修订内容', nowIso)]
      })
    } else {
      const rejected = action === 'reject'
      await db.correctionTickets.update(ticket.id, {
        status: CORRECTION.CLAIMED,
        reviewId: null,
        timeline: [...(ticket.timeline || []), buildTimelineEntry(
          rejected ? 'reject' : 'review-withdraw',
          userId,
          rejected ? ('评审驳回' + (note ? '：' + note : '') + '，退回修订') : '修订人撤回复审，退回修订',
          nowIso
        )]
      })
    }
  }

  // 自愈「卡在送审中」的纠错单：送审中但关联评审单已完结/丢失时按评审结论补齐状态。
  // 与缺口工单同一历史成因（两步式送审），现为单事务送审，不再新增，仅修复存量
  async function reconcileStuckTickets() {
    const stuck = tickets.value.filter((t) => t.status === CORRECTION.IN_REVIEW)
    if (!stuck.length) return
    const now = new Date().toISOString()
    let changed = false
    await db.transaction('rw', db.correctionTickets, db.reviews, db.docs, async () => {
      for (const t of stuck) {
        const review = t.reviewId ? await db.reviews.get(t.reviewId) : null
        if (review && review.status === 'pending') continue
        const fresh = await db.correctionTickets.get(t.id)
        if (!fresh || fresh.status !== CORRECTION.IN_REVIEW) continue
        if (review && review.status === 'approved') {
          const doc = await db.docs.get(t.docId)
          const versionNo = Array.isArray(doc?.versions) ? doc.versions.length : null
          await db.correctionTickets.update(t.id, {
            status: CORRECTION.RESOLVED,
            resolvedVersion: versionNo,
            resolvedAt: review.decidedAt || now,
            timeline: [...(fresh.timeline || []), buildTimelineEntry('resolve', review.decidedBy || 'system', '审批通过，回填修订版本', now)]
          })
        } else {
          const reason = !review
            ? '关联评审单已丢失，退回修订'
            : review.status === 'rejected'
              ? '评审驳回' + (review.decisionNote ? '：' + review.decisionNote : '') + '，退回修订'
              : '评审已撤回，退回修订'
          await db.correctionTickets.update(t.id, {
            status: CORRECTION.CLAIMED,
            reviewId: null,
            timeline: [...(fresh.timeline || []), buildTimelineEntry(review && review.status === 'rejected' ? 'reject' : 'review-withdraw', (review && review.decidedBy) || 'system', reason, now)]
          })
        }
        changed = true
      }
    })
    if (changed) await reload()
  }

  // 删除文档时连带处理：关联纠错单退回待处理并清空文档/评审关联（在 kb.deleteDoc 同事务内调用）
  async function resetTicketsOfDocTx(docId, nowIso) {
    const linked = await db.correctionTickets.where('docId').equals(docId).toArray()
    for (const t of linked) {
      // 已解决/已撤回的终态单保留结论快照，仅清掉文档指针（页面按「文档已删除」展示）
      if (t.status === CORRECTION.RESOLVED || t.status === CORRECTION.WITHDRAWN) {
        await db.correctionTickets.update(t.id, {
          docId: null,
          reviewId: null,
          timeline: [...(t.timeline || []), buildTimelineEntry('reset', 'system', '关联文档已删除，历史记录保留', nowIso)]
        })
        continue
      }
      await db.correctionTickets.update(t.id, {
        status: CORRECTION.SUBMITTED,
        docId: null,
        reviewId: null,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(t.timeline || []), buildTimelineEntry('reset', 'system', '关联文档已删除，纠错单退回待处理', nowIso)]
      })
    }
  }

  async function deleteCorrectionsOfDoc(docId) {
    await db.correctionTickets.where('docId').equals(docId).delete()
    if (loaded.value) await reload()
  }

  return {
    tickets, loaded, loadAll, reload, openCount,
    ticketsOfDoc, openTicketsOfDoc, ticketsCreatedBy, ticketsClaimedBy, myOpenTicketForDoc,
    createTicket, claimTicket, releaseTicket, returnTicket, withdrawTicket,
    syncCorrectionTicket, reconcileStuckTickets, resetTicketsOfDocTx, deleteCorrectionsOfDoc
  }
})
