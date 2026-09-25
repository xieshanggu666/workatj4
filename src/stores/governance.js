import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { buildTimelineEntry } from '@/utils/review'
import {
  GOV, GOV_TYPE, GOV_STAGE, ASSIGN_ROLE,
  dedupeKeyOf, calcDueAt, slaOf, isActionable, canActOnEvent, canTransferEvent, canReceiveTransfer, failReasonLabel
} from '@/utils/governance'
import { GUEST_ID, ROLE } from '@/utils/permission'
import { REVIEW } from '@/utils/review'
import { CORRECTION } from '@/utils/correction'
import { FRESH } from '@/utils/freshness'
import { HO_ITEM } from '@/utils/handover'
import { RETIRE } from '@/utils/retirement'
import { GATE } from '@/utils/release'
import { useReviewStore } from './review'
import { useCorrectionStore } from './correction'
import { useHandoverStore } from './handover'
import { useRetirementStore } from './retirement'
import { useReleaseStore } from './release'

// 知识治理事件与统一待办中心 store：
// 汇聚六类治理流程（评审/纠错/保鲜/交接/退役/发布门禁）的待办事件——
// syncEvents 扫描各源流程的在途单据，按「类型+源单+阶段」去重生成待办（dedupeKey 唯一），
// 按角色（admin/editor/any）或精确到人分派；源流程推进后事件自动闭环（done/cancelled），
// 源回退（如纠错退回待处理）时事件重开并累计 attempts。
// 可回写事件（审批/认领/确认/放行）在待办中心一键执行：completeEvent 调用原流程 store 动作
// （源动作自带事务与权限复核），成功即回写原流程状态并把结论/writeback 记录到事件；
// 失败（并发变化/资格收回）置为 failed，retryEvent 可重试。
// 超时治理：每类事件按 SLA 计算 dueAt，sweepTimeouts 到期标红并升级管理员督办。
export const useGovernanceStore = defineStore('governance', () => {
  const events = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    events.value = await db.governanceEvents.toArray()
  }

  const entry = buildTimelineEntry

  // ---------- 汇聚：从六个源流程收集「应有待办」 ----------
  // 返回 { desired: [...], sources: {...} }；desired 每项含 type/stage/refId/dedupeKey/分派信息
  async function collectDesired() {
    const [reviews, corrections, freshes, handovers, retirements, gates, docs] = await Promise.all([
      db.reviews.toArray(),
      db.correctionTickets.toArray(),
      db.freshnessTickets.toArray(),
      db.handovers.toArray(),
      db.retirements.toArray(),
      db.releaseGates.toArray(),
      db.docs.toArray()
    ])
    const titleOf = (docId) => (docs.find((d) => d.id === docId) || {}).title || '已删除文档'
    const desired = []
    const push = (type, stage, refId, docId, title, assigneeRole, assigneeId, meta) => {
      desired.push({
        type, stage, refId, docId: docId || null, title,
        assigneeRole, assigneeId: assigneeId || null,
        meta: meta || {},
        dedupeKey: dedupeKeyOf(type, refId, stage, assigneeId)
      })
    }

    // 评审：待审批 → 管理员
    for (const r of reviews) {
      if (r.status !== REVIEW.PENDING) continue
      push(GOV_TYPE.REVIEW, GOV_STAGE.APPROVE, r.id, r.docId,
        '评审待审批：《' + titleOf(r.docId) + '》', ASSIGN_ROLE.ADMIN, null)
    }
    // 纠错：待处理 → 编辑者认领；修订中 → 修订人（跳转处理）
    for (const t of corrections) {
      if (t.status === CORRECTION.SUBMITTED) {
        push(GOV_TYPE.CORRECTION, GOV_STAGE.CLAIM, t.id, t.docId,
          '纠错待认领：' + (t.description || '').slice(0, 40), ASSIGN_ROLE.EDITOR, null)
      } else if (t.status === CORRECTION.CLAIMED) {
        push(GOV_TYPE.CORRECTION, GOV_STAGE.REVISE, t.id, t.docId,
          '纠错修订中：' + (t.description || '').slice(0, 40), ASSIGN_ROLE.EDITOR, t.claimedBy)
      }
    }
    // 保鲜：待整改/已驳回待整改 → 编辑者（跳转处理，送审后由评审待办接管）
    for (const t of freshes) {
      if (t.status === FRESH.OPEN || t.status === FRESH.REJECTED) {
        push(GOV_TYPE.FRESHNESS, GOV_STAGE.FIX, t.id, t.docId,
          '保鲜待整改：《' + titleOf(t.docId) + '》（第 ' + (t.round || 1) + ' 轮复核）', ASSIGN_ROLE.EDITOR, null)
      }
    }
    // 交接：逐篇待确认（按接任者分组，精确到人）/ 已确认待批准 → 管理员
    for (const h of handovers) {
      const items = h.items || []
      const byTo = {}
      for (const it of items) {
        if (it.status !== HO_ITEM.PENDING_CONFIRM || !it.toUserId) continue
        ;(byTo[it.toUserId] = byTo[it.toUserId] || []).push(it)
      }
      for (const [toUserId, list] of Object.entries(byTo)) {
        push(GOV_TYPE.HANDOVER, GOV_STAGE.CONFIRM, h.id, null,
          '交接待确认：' + list.length + ' 篇文档（《' + (list[0].title || '') + '》' + (list.length > 1 ? ' 等' : '') + '）',
          ASSIGN_ROLE.ANY, toUserId, { docIds: list.map((i) => i.docId) })
      }
      const confirmed = items.filter((it) => it.status === HO_ITEM.CONFIRMED)
      if (confirmed.length) {
        push(GOV_TYPE.HANDOVER, GOV_STAGE.APPROVE, h.id, null,
          '交接待批准：' + confirmed.length + ' 篇待转移', ASSIGN_ROLE.ADMIN, null,
          { docIds: confirmed.map((i) => i.docId) })
      }
    }
    // 退役：待审批 → 管理员
    for (const r of retirements) {
      if (r.status !== RETIRE.PENDING) continue
      push(GOV_TYPE.RETIREMENT, GOV_STAGE.APPROVE, r.id, r.docId,
        '退役待审批：《' + (r.docTitle || titleOf(r.docId)) + '》', ASSIGN_ROLE.ADMIN, null)
    }
    // 发布门禁：待负责人确认影响（精确到人，跳转逐项确认）/ 待管理员审批放行
    for (const g of gates) {
      if (g.status === GATE.PENDING_CONFIRM) {
        push(GOV_TYPE.RELEASE, GOV_STAGE.CONFIRM, g.id, g.docId,
          '发布门禁待确认影响：《' + titleOf(g.docId) + '》v' + (g.version || '?'), ASSIGN_ROLE.ANY, g.ownerId)
      } else if (g.status === GATE.PENDING_APPROVAL) {
        push(GOV_TYPE.RELEASE, GOV_STAGE.APPROVE, g.id, g.docId,
          '发布门禁待审批：《' + titleOf(g.docId) + '》v' + (g.version || '?'), ASSIGN_ROLE.ADMIN, null)
      }
    }

    return {
      desired,
      sources: {
        reviews: Object.fromEntries(reviews.map((r) => [r.id, r])),
        corrections: Object.fromEntries(corrections.map((t) => [t.id, t])),
        freshes: Object.fromEntries(freshes.map((t) => [t.id, t])),
        handovers: Object.fromEntries(handovers.map((h) => [h.id, h])),
        retirements: Object.fromEntries(retirements.map((r) => [r.id, r])),
        gates: Object.fromEntries(gates.map((g) => [g.id, g]))
      }
    }
  }

  // 事件不再被源流程需要时，判定闭环方式（done：源已推进 / cancelled：源已撤销）
  // 返回 { disp, result, note, by }；无法判定时返回 cancelled（兜底，源单据丢失）
  function dispositionOf(ev, sources) {
    const done = (result, note, by) => ({ disp: GOV.DONE, result, note, by: by || 'system' })
    const cancel = (result, note, by) => ({ disp: GOV.CANCELLED, result, note, by: by || 'system' })
    if (ev.type === GOV_TYPE.REVIEW) {
      const r = sources.reviews[ev.refId]
      if (!r) return cancel('missing', '源评审单已删除')
      if (r.status === REVIEW.APPROVED) return done('approved', '评审已审批通过', r.decidedBy)
      if (r.status === REVIEW.REJECTED) return done('rejected', '评审已驳回', r.decidedBy)
      if (r.status === REVIEW.WITHDRAWN) return cancel('withdrawn', '评审已撤回')
    } else if (ev.type === GOV_TYPE.CORRECTION) {
      const t = sources.corrections[ev.refId]
      if (!t) return cancel('missing', '源纠错单已删除')
      if (ev.stage === GOV_STAGE.CLAIM) {
        if (t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW) return done('claimed', '纠错单已被认领', t.claimedBy)
        if (t.status === CORRECTION.RESOLVED) return done('resolved', '纠错单已解决', t.claimedBy)
        if (t.status === CORRECTION.WITHDRAWN) return cancel('withdrawn', '纠错单已撤回')
      } else if (ev.stage === GOV_STAGE.REVISE) {
        if (t.status === CORRECTION.IN_REVIEW) return done('submitted', '修订已送审', t.claimedBy)
        if (t.status === CORRECTION.RESOLVED) return done('resolved', '纠错单已解决', t.claimedBy)
        if (t.status === CORRECTION.SUBMITTED) return cancel('returned', '纠错单已退回待处理')
        if (t.status === CORRECTION.WITHDRAWN) return cancel('withdrawn', '纠错单已撤回')
      }
    } else if (ev.type === GOV_TYPE.FRESHNESS) {
      const t = sources.freshes[ev.refId]
      if (!t) return cancel('missing', '源复核单已删除')
      if (t.status === FRESH.SUBMITTED) return done('submitted', '复核已送审（转评审待办）')
      if (t.status === FRESH.APPROVED) return done('approved', '复核已通过')
      if (t.status === FRESH.CANCELLED) return cancel('cancelled', '保鲜已关闭，复核单作废')
    } else if (ev.type === GOV_TYPE.HANDOVER) {
      const h = sources.handovers[ev.refId]
      if (!h) return cancel('missing', '源交接单已删除')
      const items = h.items || []
      if (ev.stage === GOV_STAGE.CONFIRM) {
        const mine = items.filter((it) => (ev.meta?.docIds || []).includes(it.docId))
        if (mine.some((it) => it.status === HO_ITEM.CONFIRMED || it.status === HO_ITEM.COMPLETED)) return done('confirmed', '接任者已确认接收')
        return cancel('closed', '交接篇目已谢绝/取消')
      }
      if (ev.stage === GOV_STAGE.APPROVE) {
        if (items.some((it) => it.status === HO_ITEM.COMPLETED)) return done('approved', '交接已批准执行', h.decidedBy)
        return cancel('closed', '交接单已驳回/取消', h.decidedBy)
      }
    } else if (ev.type === GOV_TYPE.RETIREMENT) {
      const r = sources.retirements[ev.refId]
      if (!r) return cancel('missing', '源退役单已删除')
      if (r.status === RETIRE.APPROVED) return done('approved', '退役已批准生效', r.decidedBy)
      if (r.status === RETIRE.REJECTED) return done('rejected', '退役已驳回', r.decidedBy)
      if (r.status === RETIRE.CANCELLED || r.status === RETIRE.REVOKED) return cancel(r.status, '退役申请已撤销', r.decidedBy)
    } else if (ev.type === GOV_TYPE.RELEASE) {
      const g = sources.gates[ev.refId]
      if (!g) return cancel('missing', '源门禁单已删除')
      if (ev.stage === GOV_STAGE.CONFIRM) {
        if (g.status === GATE.PENDING_APPROVAL || g.status === GATE.RELEASED || g.status === GATE.REJECTED || g.status === GATE.ROLLED_BACK) {
          return done('confirmed', '负责人已确认全部影响', g.confirmedBy)
        }
        if (g.status === GATE.WITHDRAWN) return cancel('withdrawn', '门禁已撤回')
        if (g.status === GATE.BLOCKED) return cancel('blocked', '门禁复检被阻断，待重新评估')
      } else if (ev.stage === GOV_STAGE.APPROVE) {
        if (g.status === GATE.RELEASED || g.status === GATE.ROLLED_BACK) return done('released', '门禁已放行发布', g.decidedBy)
        if (g.status === GATE.REJECTED) return done('rejected', '门禁已驳回', g.decidedBy)
        if (g.status === GATE.WITHDRAWN) return cancel('withdrawn', '门禁已撤回')
        if (g.status === GATE.BLOCKED) return cancel('blocked', '门禁复检被阻断，待重新评估')
      }
    }
    return cancel('missing', '源流程状态无法识别，关闭待办')
  }

  // ---------- 汇聚引擎：扫描源流程 → 去重建单 / 更新 / 闭环 / 重开 ----------
  // 单事务读写事件表；源表只读快照。重复执行幂等（dedupeKey 去重），可安全高频调用。
  async function syncEvents() {
    await loadAll()
    const now = new Date().toISOString()
    const { desired, sources } = await collectDesired()
    let created = 0
    let closed = 0
    let reopened = 0

    await db.transaction('rw', db.governanceEvents, async () => {
      const existing = await db.governanceEvents.toArray()
      const byKey = new Map(existing.map((e) => [e.dedupeKey, e]))
      const desiredKeys = new Set(desired.map((d) => d.dedupeKey))

      // ① 应有待办：新建 / 更新分派信息 / 终态重开
      for (const d of desired) {
        const cur = byKey.get(d.dedupeKey)
        if (!cur) {
          await db.governanceEvents.add({
            id: uid('gov'),
            type: d.type,
            stage: d.stage,
            refId: d.refId,
            docId: d.docId,
            title: d.title,
            status: GOV.OPEN,
            assigneeRole: d.assigneeRole,
            assigneeId: d.assigneeId,
            dedupeKey: d.dedupeKey,
            meta: d.meta,
            attempts: 0,
            timedOut: false,
            escalated: false,
            dueAt: calcDueAt(d.type, now),
            createdAt: now,
            claimedBy: null,
            claimedAt: null,
            doneBy: null,
            doneAt: null,
            result: null,
            failReason: '',
            failBy: null,
            failAt: null,
            writeback: null,
            timeline: [entry('create', 'system', '从' + d.type + '流程汇聚生成', now)]
          })
          created++
          continue
        }
        if (cur.status === GOV.OPEN || cur.status === GOV.CLAIMED || cur.status === GOV.FAILED) {
          // 在途事件：同步标题/分派/元数据（源流程侧变更，如交接篇目增减）。
          // 已超时升级的事件保留升级后的分派角色（管理员督办不被汇聚覆盖，重开时才重置）
          const patch = {}
          if (cur.title !== d.title) patch.title = d.title
          if (!cur.escalated && cur.assigneeRole !== d.assigneeRole) patch.assigneeRole = d.assigneeRole
          if (cur.assigneeId !== d.assigneeId) patch.assigneeId = d.assigneeId
          if (JSON.stringify(cur.meta || {}) !== JSON.stringify(d.meta || {})) patch.meta = d.meta
          if (Object.keys(patch).length) await db.governanceEvents.update(cur.id, patch)
          continue
        }
        // ② 终态（done/cancelled）但源再次进入该阶段：重开（源回退重试语义），累计 attempts
        await db.governanceEvents.update(cur.id, {
          title: d.title,
          status: GOV.OPEN,
          assigneeRole: d.assigneeRole,
          assigneeId: d.assigneeId,
          meta: d.meta,
          attempts: (cur.attempts || 0) + 1,
          timedOut: false,
          escalated: false,
          dueAt: calcDueAt(d.type, now),
          claimedBy: null,
          claimedAt: null,
          doneBy: null,
          doneAt: null,
          result: null,
          failReason: '',
          failBy: null,
          failAt: null,
          writeback: null,
          timeline: [...(cur.timeline || []), entry('reopen', 'system', '源流程回退，待办重开（第 ' + ((cur.attempts || 0) + 1) + ' 次）', now)]
        })
        reopened++
      }

      // ③ 在途事件不再被源流程需要：按源状态闭环（done/cancelled）
      for (const ev of existing) {
        if (ev.status !== GOV.OPEN && ev.status !== GOV.CLAIMED && ev.status !== GOV.FAILED) continue
        if (desiredKeys.has(ev.dedupeKey)) continue
        const disp = dispositionOf(ev, sources)
        await db.governanceEvents.update(ev.id, {
          status: disp.disp,
          doneBy: disp.disp === GOV.DONE ? disp.by : null,
          doneAt: now,
          result: disp.result,
          timeline: [...(ev.timeline || []), entry(disp.disp === GOV.DONE ? 'sync-done' : 'sync-cancel', disp.by, disp.note, now)]
        })
        closed++
      }
    })

    if (created || closed || reopened) await reload()
    return { created, closed, reopened }
  }

  // ---------- 超时治理：SLA 到期标红并升级管理员督办 ----------
  async function sweepTimeouts(nowIso) {
    await loadAll()
    const now = nowIso || new Date().toISOString()
    let swept = 0
    await db.transaction('rw', db.governanceEvents, async () => {
      const list = await db.governanceEvents.toArray()
      for (const ev of list) {
        if (ev.status !== GOV.OPEN && ev.status !== GOV.CLAIMED) continue
        if (ev.timedOut || !ev.dueAt) continue
        if (new Date(ev.dueAt).getTime() > new Date(now).getTime()) continue
        const patch = {
          timedOut: true,
          escalated: true,
          timeline: [...(ev.timeline || []), entry('timeout', 'system', '超过处理时限（SLA ' + slaOf(ev.type) + ' 小时），升级管理员督办', now)]
        }
        // 角色分派类事件超时后升级为管理员待办；精确到人的事件保留原指派人，仅加升级标记
        if (!ev.assigneeId) patch.assigneeRole = ASSIGN_ROLE.ADMIN
        await db.governanceEvents.update(ev.id, patch)
        swept++
      }
    })
    if (swept) await reload()
    return swept
  }

  // ---------- 认领 / 释放 / 转交 ----------
  async function claimEvent(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const now = new Date().toISOString()
    let result = { status: 'error' }
    await db.transaction('rw', db.governanceEvents, async () => {
      const ev = await db.governanceEvents.get(id)
      if (!ev) { result = { status: 'missing' }; return }
      if (ev.status !== GOV.OPEN) { result = { status: 'changed', event: ev }; return }
      // 事务内复核分派门槛：访客/越权角色不可认领
      if (!canActOnEvent(ev, currentUser)) { result = { status: userId === GUEST_ID ? 'guest' : 'denied' }; return }
      await db.governanceEvents.update(id, {
        status: GOV.CLAIMED,
        claimedBy: userId,
        claimedAt: now,
        timeline: [...(ev.timeline || []), entry('claim', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 释放认领：claimed → open（认领人本人或管理员）
  async function releaseEvent(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === ROLE.ADMIN
    const now = new Date().toISOString()
    let result = { status: 'error' }
    await db.transaction('rw', db.governanceEvents, async () => {
      const ev = await db.governanceEvents.get(id)
      if (!ev) { result = { status: 'missing' }; return }
      if (ev.status !== GOV.CLAIMED || (ev.claimedBy !== userId && !isAdmin)) {
        result = { status: 'denied', event: ev }; return
      }
      await db.governanceEvents.update(id, {
        status: GOV.OPEN,
        claimedBy: null,
        claimedAt: null,
        timeline: [...(ev.timeline || []), entry('release', userId, '', now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // 转交：把待办指派给满足角色门槛的另一成员（claimed by 目标人）。
  // 精确到人的事件（接任者/负责人/修订人由源流程决定）不可转交。
  async function transferEvent(id, targetUser, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const now = new Date().toISOString()
    let result = { status: 'error' }
    await db.transaction('rw', db.governanceEvents, async () => {
      const ev = await db.governanceEvents.get(id)
      if (!ev) { result = { status: 'missing' }; return }
      if (ev.assigneeId) { result = { status: 'locked', event: ev }; return }
      if (!canTransferEvent(ev, currentUser)) { result = { status: 'denied', event: ev }; return }
      if (!canReceiveTransfer(ev, targetUser)) { result = { status: 'bad-target' }; return }
      await db.governanceEvents.update(id, {
        status: GOV.CLAIMED,
        claimedBy: targetUser.id,
        claimedAt: now,
        timeline: [...(ev.timeline || []), entry('transfer', userId, '转交给 ' + targetUser.name + (note ? '：' + note : ''), now)]
      })
      result = { status: 'ok' }
    })
    await reload()
    return result
  }

  // ---------- 回写原流程 ----------
  // 执行源流程动作（源 store 自带事务与权限复核）；返回源动作的 result
  async function executeWriteback(ev, action, note, currentUser) {
    const review = useReviewStore()
    const correction = useCorrectionStore()
    const handover = useHandoverStore()
    const retirement = useRetirementStore()
    const release = useReleaseStore()
    const decision = action === 'reject' ? 'reject' : 'approve'
    switch (ev.type + ':' + ev.stage) {
      case GOV_TYPE.REVIEW + ':' + GOV_STAGE.APPROVE:
        return review.decideReview(ev.refId, decision, note, currentUser)
      case GOV_TYPE.CORRECTION + ':' + GOV_STAGE.CLAIM:
        return correction.claimTicket(ev.refId, currentUser)
      case GOV_TYPE.HANDOVER + ':' + GOV_STAGE.CONFIRM: {
        // 事务外重读交接单，确认当前仍待本人确认的篇（并发变化时源动作兜底拒绝）
        const h = await db.handovers.get(ev.refId)
        const docIds = (h?.items || [])
          .filter((it) => it.toUserId === currentUser.id && it.status === HO_ITEM.PENDING_CONFIRM)
          .map((it) => it.docId)
        if (!docIds.length) return { status: 'changed' }
        return handover.confirmHandover(ev.refId, docIds, currentUser)
      }
      case GOV_TYPE.HANDOVER + ':' + GOV_STAGE.APPROVE: {
        const h = await db.handovers.get(ev.refId)
        const docIds = (h?.items || []).filter((it) => it.status === HO_ITEM.CONFIRMED).map((it) => it.docId)
        if (!docIds.length) return { status: 'changed' }
        return handover.decideHandover(ev.refId, docIds, decision, note, currentUser)
      }
      case GOV_TYPE.RETIREMENT + ':' + GOV_STAGE.APPROVE:
        return retirement.decideRetirement(ev.refId, decision, note, currentUser)
      case GOV_TYPE.RELEASE + ':' + GOV_STAGE.APPROVE:
        return release.decideGate(ev.refId, decision, note, currentUser)
      default:
        return { status: 'not-actionable' }
    }
  }

  // 一键处理：在待办中心直接执行原流程动作并回写状态。
  // 成功：事件 done，writeback 记录回写动作；随后 syncEvents 联动其他事件闭环。
  // 失败：事件 failed + failReason，可 retryEvent 重试。
  async function completeEvent(id, action, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === ROLE.ADMIN
    const ev = await db.governanceEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (ev.status !== GOV.OPEN && ev.status !== GOV.CLAIMED) return { status: 'changed', event: ev }
    if (!isActionable(ev)) return { status: 'not-actionable', event: ev }
    // 处理资格：已认领需本人或管理员；未认领需满足分派门槛（执行即认领）
    const allowed = ev.status === GOV.CLAIMED
      ? ev.claimedBy === userId || isAdmin
      : canActOnEvent(ev, currentUser)
    if (!allowed) return { status: userId === GUEST_ID ? 'guest' : 'denied' }

    const res = await executeWriteback(ev, action, note, currentUser)
    const now = new Date().toISOString()
    const fresh = await db.governanceEvents.get(id)
    if (res.status === 'ok') {
      await db.governanceEvents.update(id, {
        status: GOV.DONE,
        claimedBy: fresh.claimedBy || userId,
        claimedAt: fresh.claimedAt || now,
        doneBy: userId,
        doneAt: now,
        result: action || 'done',
        failReason: '',
        writeback: {
          target: ev.type + ':' + ev.refId,
          action: action || 'done',
          by: userId,
          at: now,
          note: note || ''
        },
        timeline: [...(fresh.timeline || []), entry('complete', userId, '一键回写原流程（' + (action || 'done') + '）' + (note ? '：' + note : ''), now)]
      })
      // 源状态已推进：联动汇聚（本事件相关阶段闭环、下一阶段待办生成）
      await syncEvents()
      await reload()
      return { status: 'ok', result: res }
    }
    // 回写失败：源流程拒绝了本次动作（并发变化/资格收回/前置未满足），置 failed 待重试
    await db.governanceEvents.update(id, {
      status: GOV.FAILED,
      failReason: res.status || 'error',
      failBy: userId,
      failAt: now,
      timeline: [...(fresh.timeline || []), entry('fail', userId, failReasonLabel(res.status), now)]
    })
    await reload()
    return { status: 'failed', reason: res.status, result: res }
  }

  // 失败重试：仅 failed 事件；重新执行回写动作，attempts 累计。
  // 成功 → done；仍失败 → 保持 failed 并更新失败原因。
  async function retryEvent(id, action, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const isAdmin = currentUser?.role === ROLE.ADMIN
    const ev = await db.governanceEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (ev.status !== GOV.FAILED) return { status: 'changed', event: ev }
    if (!canActOnEvent(ev, currentUser) && !isAdmin) {
      return { status: userId === GUEST_ID ? 'guest' : 'denied' }
    }

    const res = await executeWriteback(ev, action, note, currentUser)
    const now = new Date().toISOString()
    const fresh = await db.governanceEvents.get(id)
    const attempts = (fresh.attempts || 0) + 1
    const retryEntry = entry('retry', userId, '第 ' + attempts + ' 次重试', now)
    if (res.status === 'ok') {
      await db.governanceEvents.update(id, {
        status: GOV.DONE,
        attempts,
        doneBy: userId,
        doneAt: now,
        result: action || 'done',
        failReason: '',
        failBy: null,
        failAt: null,
        writeback: {
          target: ev.type + ':' + ev.refId,
          action: action || 'done',
          by: userId,
          at: now,
          note: note || ''
        },
        timeline: [...(fresh.timeline || []), retryEntry, entry('complete', userId, '重试成功，已回写原流程（' + (action || 'done') + '）', now)]
      })
      await syncEvents()
      await reload()
      return { status: 'ok', result: res }
    }
    await db.governanceEvents.update(id, {
      status: GOV.FAILED,
      attempts,
      failReason: res.status || 'error',
      failBy: userId,
      failAt: now,
      timeline: [...(fresh.timeline || []), retryEntry, entry('fail', userId, failReasonLabel(res.status), now)]
    })
    await reload()
    return { status: 'failed', reason: res.status, result: res }
  }

  // ---------- 视图查询 ----------
  function eventOf(id) {
    return events.value.find((e) => e.id === id) || null
  }

  // 当前用户可见的待办（待处理/处理中/待重试）
  function todosFor(user) {
    if (!user || !user.id) return []
    const isAdmin = user.role === ROLE.ADMIN
    return events.value
      .filter((ev) => {
        if (ev.status === GOV.DONE || ev.status === GOV.CANCELLED) return false
        if (ev.status === GOV.CLAIMED) return ev.claimedBy === user.id || isAdmin
        if (ev.status === GOV.FAILED) return ev.failBy === user.id || isAdmin || canActOnEvent(ev, user)
        // open：满足分派门槛，或超时升级后管理员可见
        return canActOnEvent(ev, user) || (ev.escalated && isAdmin)
      })
      .sort((a, b) => {
        // 超时优先，其次按截止时间
        const ao = a.timedOut ? 0 : 1
        const bo = b.timedOut ? 0 : 1
        if (ao !== bo) return ao - bo
        return new Date(a.dueAt || a.createdAt) - new Date(b.dueAt || b.createdAt)
      })
  }

  // 侧边栏角标：当前用户待处理数（open + claimed，不含 failed）
  function pendingCountFor(user) {
    if (!user || !user.id) return 0
    return todosFor(user).filter((ev) => ev.status === GOV.OPEN || ev.status === GOV.CLAIMED).length
  }

  const openCount = computed(() => events.value.filter((e) => e.status === GOV.OPEN || e.status === GOV.CLAIMED).length)
  const failedCount = computed(() => events.value.filter((e) => e.status === GOV.FAILED).length)
  const overdueCount = computed(() => events.value.filter((e) => e.timedOut && (e.status === GOV.OPEN || e.status === GOV.CLAIMED)).length)

  return {
    events, loaded, loadAll, reload,
    syncEvents, sweepTimeouts,
    claimEvent, releaseEvent, transferEvent, completeEvent, retryEvent,
    eventOf, todosFor, pendingCountFor,
    openCount, failedCount, overdueCount
  }
})
