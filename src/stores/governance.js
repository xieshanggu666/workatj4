import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { CORRECTION } from '@/utils/correction'
import { GUEST_ID, roleLabel } from '@/utils/permission'
import {
  GOV_KIND, GOV_STATUS, SYNC_STATE, SLA_HOURS,
  isGovEventOpen, canClaimEvent, canAssignEvent, canTransferEvent, canTransferTarget,
  canRetryEvent, canCancelEvent, deriveGovEvents,
  govKindLabel, govStageLabel, buildGovEntry
} from '@/utils/governance'
import { useCorrectionStore } from './correction'

// 知识治理事件与统一待办中心 store：
// ① 汇聚（syncAll）：从六个治理流程的源单据（评审/纠错/保鲜/交接/退役/发布门禁）派生
//    「期望待办」，按 dedupeKey 去重建档——同一源单据同一步骤只存在一条在途待办；
//    源流程推进后对应待办自动办结，源记录删除则取消；回写失败挂起的待办不被汇聚覆盖。
// ② 分派：建档时按来源步骤落到角色池（管理员/编辑者）或指定成员（负责人/接任者/修订人）；
//    管理员可手动改派（assignEvent），已认领待办可由认领人/管理员转交（transferEvent）。
// ③ 回写原流程：待办动作先回写再落状态——纠错待办的认领/转交直接驱动纠错单状态机
//    （claimTicket/releaseTicket），其余来源向源单据 timeline 追加「治理待办联动」留痕；
//    回写失败挂起 pendingAction（syncState=failed），可由 retryEvent 重放，源流程已分叉则取消待办。
// ④ 超时：每条待办按来源 SLA 生成到期点，响应式时钟到点扫描升级标记（幂等，escalatedAt 只写一次）。
export const useGovernanceStore = defineStore('governance', () => {
  const events = ref([])
  const loaded = ref(false)
  // 响应式当前时间：超时判定与调度器统一以它为准（与保鲜同一套响应式时钟模式）
  const now = ref(new Date())
  let overdueTimer = null
  const MAX_TIMER_DELAY = 2147483647

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
    // 首次加载汇聚一次（幂等）并扫描超时
    await syncAll()
    await sweepOverdue()
  }

  async function reload() {
    events.value = await db.govEvents.toArray()
    now.value = new Date()
  }

  const sorted = computed(() =>
    [...events.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  const openEvents = computed(() => sorted.value.filter((e) => isGovEventOpen(e)))

  // 当前用户可处置的在途待办：我认领的 / 指定分派给我的 / 命中我角色池的
  function actionableFor(userId, role) {
    if (!userId || userId === GUEST_ID) return []
    return sorted.value.filter((e) => {
      if (!isGovEventOpen(e)) return false
      if (e.claimedBy === userId) return true
      if (e.status !== GOV_STATUS.OPEN) return false
      if (e.assigneeId) return e.assigneeId === userId
      return !!e.assigneeRole && e.assigneeRole === role
    })
  }

  // 侧栏角标：待我处理的治理待办数
  function pendingCountFor(userId, role) {
    return actionableFor(userId, role).length
  }

  // 已超时未办结数量（视图角标）
  const overdueCount = computed(() =>
    events.value.filter((e) => isGovEventOpen(e) && e.dueAt && new Date(e.dueAt) <= now.value).length
  )

  const failedCount = computed(() => events.value.filter((e) => e.syncState === SYNC_STATE.FAILED).length)

  function eventById(id) {
    return events.value.find((e) => e.id === id) || null
  }

  // ---- ① 汇聚引擎：派生期望待办 → 去重建档/刷新 → 源流程推进自动办结 ----
  async function syncAll() {
    const nowIso = new Date().toISOString()
    await db.transaction(
      'rw',
      db.govEvents, db.reviews, db.correctionTickets, db.freshnessTickets,
      db.handovers, db.retirements, db.releaseGates, db.gapTickets, db.docs,
      async () => {
        const [reviews, corrections, freshnessTickets, handovers, retirements, gates, gapTickets, docs] = await Promise.all([
          db.reviews.toArray(), db.correctionTickets.toArray(), db.freshnessTickets.toArray(),
          db.handovers.toArray(), db.retirements.toArray(), db.releaseGates.toArray(),
          db.gapTickets.toArray(), db.docs.toArray()
        ])
        const desired = deriveGovEvents(
          { reviews, corrections, freshnessTickets, handovers, retirements, gates, gapTickets, docs },
          nowIso
        )
        const desiredKeys = new Set(desired.map((d) => d.dedupeKey))
        const existing = await db.govEvents.toArray()
        const byKey = new Map(existing.map((e) => [e.dedupeKey, e]))

        // 期望待办：无则建档（去重），有则刷新投影字段
        for (const d of desired) {
          const cur = byKey.get(d.dedupeKey)
          if (!cur) {
            await db.govEvents.add({
              id: uid('gv'),
              kind: d.kind,
              stage: d.stage,
              dedupeKey: d.dedupeKey,
              title: d.title,
              summary: d.summary,
              docId: d.docId || null,
              docTitle: d.docTitle || '',
              refId: d.refId,
              refKey: d.refKey || null,
              assigneeRole: d.assigneeRole || null,
              assigneeId: d.assigneeId || null,
              assignedManually: false,
              status: GOV_STATUS.OPEN,
              claimedBy: null,
              claimedAt: null,
              dueAt: new Date(new Date(nowIso).getTime() + (SLA_HOURS[d.kind] || 72) * 3600 * 1000).toISOString(),
              escalatedAt: null,
              syncState: SYNC_STATE.NONE,
              attempts: 0,
              lastError: '',
              pendingAction: null,
              createdAt: nowIso,
              updatedAt: nowIso,
              doneAt: null,
              doneReason: '',
              timeline: [buildGovEntry('create', 'system',
                '治理引擎汇聚建档，按「' + govKindLabel(d.kind) + ' · ' + govStageLabel(d.stage) + '」分派', nowIso)]
            })
            continue
          }
          if (!isGovEventOpen(cur)) continue // 已办结/取消：历史留痕不复活
          if (cur.syncState === SYNC_STATE.FAILED) continue // 回写失败挂起：待重试/取消，不被汇聚覆盖
          const patch = {
            title: d.title,
            summary: d.summary,
            docId: d.docId || null,
            docTitle: d.docTitle || '',
            updatedAt: nowIso
          }
          // 待处理且未手动分派：跟随源流程的最新分派（如负责人变更）；手动分派/已认领不动
          if (cur.status === GOV_STATUS.OPEN && !cur.assignedManually) {
            patch.assigneeRole = d.assigneeRole || null
            patch.assigneeId = d.assigneeId || null
          }
          await db.govEvents.update(cur.id, patch)
        }

        // 期望之外的在途待办：源流程已推进 → 自动办结；源记录已删除 → 取消
        for (const e of existing) {
          if (!isGovEventOpen(e)) continue
          if (desiredKeys.has(e.dedupeKey)) continue
          if (e.syncState === SYNC_STATE.FAILED) {
            // 回写失败挂起：仅源记录彻底删除才取消；源流程推进的分叉由重试判定
            const exists = await sourceExistsTx(e)
            if (!exists) {
              await db.govEvents.update(e.id, {
                status: GOV_STATUS.CANCELLED,
                syncState: SYNC_STATE.NONE,
                pendingAction: null,
                lastError: '',
                updatedAt: nowIso,
                doneAt: nowIso,
                doneReason: '源记录已删除',
                timeline: [...(e.timeline || []), buildGovEntry('cancel', 'system', '源记录已删除，待办取消', nowIso)]
              })
            }
            continue
          }
          await db.govEvents.update(e.id, {
            status: GOV_STATUS.DONE,
            updatedAt: nowIso,
            doneAt: nowIso,
            doneReason: '源流程已推进，待办自动办结',
            timeline: [...(e.timeline || []), buildGovEntry('done', 'system', '源流程已推进，待办自动办结', nowIso)]
          })
        }
      }
    )
    await reload()
    scheduleOverdue()
  }

  // ---- ④ 超时扫描：越过 SLA 到期点的在途待办升级标记（幂等，escalatedAt 只写一次）----
  async function sweepOverdue() {
    now.value = new Date()
    const nowDate = now.value
    const nowIso = nowDate.toISOString()
    let changed = false
    await db.transaction('rw', db.govEvents, async () => {
      const list = await db.govEvents.where('status').anyOf(GOV_STATUS.OPEN, GOV_STATUS.CLAIMED).toArray()
      for (const e of list) {
        if (!e.dueAt || e.escalatedAt) continue
        if (new Date(e.dueAt) > nowDate) continue
        await db.govEvents.update(e.id, {
          escalatedAt: nowIso,
          updatedAt: nowIso,
          timeline: [...(e.timeline || []), buildGovEntry('overdue', 'system',
            '超出处置时限（SLA ' + (SLA_HOURS[e.kind] || 72) + ' 小时），已升级标记', nowIso)]
        })
        changed = true
      }
    })
    if (changed) await reload()
    scheduleOverdue()
  }

  // 调度下一次到点唤醒：仅看「在途且未升级」的待办，到点推进时钟 → sweepOverdue 升级标记
  function scheduleOverdue() {
    if (overdueTimer) { clearTimeout(overdueTimer); overdueTimer = null }
    let next = Infinity
    for (const e of events.value) {
      if (!isGovEventOpen(e) || !e.dueAt || e.escalatedAt) continue
      const t = new Date(e.dueAt).getTime()
      if (t > Date.now() && t < next) next = t
    }
    if (next === Infinity) return
    const delay = Math.min(Math.max(next - Date.now(), 0) + 50, MAX_TIMER_DELAY)
    overdueTimer = setTimeout(onOverdueTick, delay)
  }

  async function onOverdueTick() {
    overdueTimer = null
    now.value = new Date()
    await sweepOverdue()
  }

  // ---- ③ 待办动作：认领 / 分派 / 转交 / 重试 / 取消（先回写原流程，再落待办状态）----

  // 认领：待处理 → 已认领。纠错「待认领」事件直接回写纠错单为已认领；其余来源写联动留痕。
  async function claimEvent(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    if (userId === GUEST_ID) return { status: 'guest' }
    const ev = await db.govEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (!canClaimEvent(ev, { id: userId, role })) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const action = {
      type: 'claim',
      actor: { id: userId, role },
      patch: { status: GOV_STATUS.CLAIMED, claimedBy: userId, claimedAt: nowIso },
      traceNote: '治理待办 ' + ev.id + ' 已认领，处理人跟进中'
    }
    const res = await executeAction(id, action, buildGovEntry('claim', userId, '', nowIso))
    await syncAll()
    return res
  }

  // 管理员分派：待处理待办改派到角色池或指定成员（手动分派后不再跟随源流程的自动分派）
  // target: { assigneeRole } 或 { assigneeId }
  async function assignEvent(id, target, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (userId === GUEST_ID) return { status: 'guest' }
    const ev = await db.govEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (!canAssignEvent(ev, currentUser)) return { status: 'denied' }
    let assigneeRole = null
    let assigneeId = null
    let label = ''
    if (target?.assigneeId) {
      const u = await db.users.get(target.assigneeId)
      if (!u) return { status: 'bad-target' }
      assigneeId = u.id
      label = '指定成员 ' + u.name
    } else if (target?.assigneeRole) {
      assigneeRole = target.assigneeRole
      label = '角色池「' + roleLabel(assigneeRole) + '」'
    } else {
      return { status: 'bad-target' }
    }
    const nowIso = new Date().toISOString()
    const action = {
      type: 'assign',
      actor: { id: userId, role: currentUser?.role || null },
      patch: { assigneeRole, assigneeId, assignedManually: true },
      traceNote: '治理待办 ' + ev.id + ' 已分派（' + label + '）'
    }
    const res = await executeAction(id, action, buildGovEntry('assign', userId, label + (note ? '：' + note : ''), nowIso))
    await syncAll()
    return res
  }

  // 转交：已认领待办交给其他成员跟进。纠错「待送审」事件的转交回写纠错单认领关系
  // （原修订人释放 → 新修订人认领，部分完成的重放可续跑）。
  async function transferEvent(id, targetUserId, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    if (userId === GUEST_ID) return { status: 'guest' }
    const ev = await db.govEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (!canTransferEvent(ev, { id: userId, role })) return { status: 'denied' }
    const target = await db.users.get(targetUserId)
    if (!canTransferTarget(ev, target, userId)) return { status: 'bad-target' }
    const nowIso = new Date().toISOString()
    const fromUserId = ev.claimedBy
    const fromUser = fromUserId ? await db.users.get(fromUserId) : null
    const action = {
      type: 'transfer',
      actor: { id: userId, role },
      fromUserId,
      fromActor: { id: fromUserId, role: fromUser?.role || null },
      targetId: target.id,
      targetActor: { id: target.id, role: target.role },
      patch: { assigneeId: target.id, claimedBy: target.id, claimedAt: nowIso, assignedManually: true },
      traceNote: '治理待办 ' + ev.id + ' 已转交给 ' + target.name
    }
    const res = await executeAction(id, action,
      buildGovEntry('transfer', userId, '转交给 ' + target.name + (note ? '：' + note : ''), nowIso))
    await syncAll()
    return res
  }

  // 重试：重放回写失败时挂起的动作（pendingAction 携带原补丁）；源流程已分叉则取消待办
  async function retryEvent(id, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (userId === GUEST_ID) return { status: 'guest' }
    const ev = await db.govEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (ev.syncState !== SYNC_STATE.FAILED || !ev.pendingAction) return { status: 'no-pending' }
    if (!canRetryEvent(ev, { id: userId, role: currentUser?.role })) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    const action = { ...ev.pendingAction }
    // 重放前以最新用户档案还原操作者/目标角色（挂起期间角色可能已被调整）
    for (const key of ['actor', 'fromActor', 'targetActor']) {
      if (action[key]?.id) {
        const u = await db.users.get(action[key].id)
        if (u) action[key] = { id: u.id, role: u.role }
      }
    }
    const res = await executeAction(id, action, buildGovEntry('retry', userId, '重试成功，已恢复回写', nowIso))
    await syncAll()
    return res
  }

  // 取消待办（仅管理员）：待办中心不再跟踪，源流程在对应中心继续流转；源单据尽力留痕
  async function cancelEvent(id, note, currentUser) {
    await loadAll()
    const userId = currentUser?.id || GUEST_ID
    if (userId === GUEST_ID) return { status: 'guest' }
    const ev = await db.govEvents.get(id)
    if (!ev) return { status: 'missing' }
    if (!canCancelEvent(ev, currentUser)) return { status: 'denied' }
    const nowIso = new Date().toISOString()
    try {
      await appendSourceTrace(ev, '治理待办 ' + ev.id + ' 已取消（流程仍在对应中心继续流转）', userId, nowIso)
    } catch { /* 留痕失败不阻塞取消 */ }
    await db.transaction('rw', db.govEvents, async () => {
      const cur = await db.govEvents.get(id)
      if (!cur || !isGovEventOpen(cur)) return
      await db.govEvents.update(id, {
        status: GOV_STATUS.CANCELLED,
        syncState: SYNC_STATE.NONE,
        pendingAction: null,
        lastError: '',
        updatedAt: nowIso,
        doneAt: nowIso,
        doneReason: '管理员取消',
        timeline: [...(cur.timeline || []), buildGovEntry('cancel', userId, note || '', nowIso)]
      })
    })
    await reload()
    await reloadSourceStore(ev.kind)
    return { status: 'ok' }
  }

  // ---- 内部：动作执行与回写 ----

  // 执行待办动作：先回写原流程，再按结果落待办状态。
  // action: { type, actor, patch（成功时应用的待办补丁）, traceNote, ... }
  // 回写 ok → 应用补丁并记 sync-ok；暂时失败 → 挂起 pendingAction 待重试；源流程分叉 → 取消待办。
  async function executeAction(eventId, action, successEntry) {
    const nowIso = new Date().toISOString()
    const ev = await db.govEvents.get(eventId)
    if (!ev) return { status: 'missing' }
    const wb = await runWriteback(ev, action, nowIso)

    if (wb === 'diverged') {
      await db.transaction('rw', db.govEvents, async () => {
        const cur = await db.govEvents.get(eventId)
        if (!cur || !isGovEventOpen(cur)) return
        await db.govEvents.update(eventId, {
          status: GOV_STATUS.CANCELLED,
          syncState: SYNC_STATE.NONE,
          pendingAction: null,
          lastError: '',
          updatedAt: nowIso,
          doneAt: nowIso,
          doneReason: '源流程状态已变化，待办失效',
          timeline: [...(cur.timeline || []), buildGovEntry('cancel', 'system', '源流程状态已变化，待办失效', nowIso)]
        })
      })
      await reload()
      return { status: 'diverged' }
    }

    if (wb === 'failed') {
      await db.transaction('rw', db.govEvents, async () => {
        const cur = await db.govEvents.get(eventId)
        if (!cur || !isGovEventOpen(cur)) return
        await db.govEvents.update(eventId, {
          syncState: SYNC_STATE.FAILED,
          pendingAction: action,
          attempts: (cur.attempts || 0) + 1,
          lastError: '回写原流程失败，可在待办中心重试',
          updatedAt: nowIso,
          timeline: [...(cur.timeline || []), buildGovEntry('sync-fail', 'system', '回写原流程失败，可在待办中心重试', nowIso)]
        })
      })
      await reload()
      return { status: 'sync-failed' }
    }

    // 回写成功：应用动作补丁
    await db.transaction('rw', db.govEvents, async () => {
      const cur = await db.govEvents.get(eventId)
      if (!cur || !isGovEventOpen(cur)) return
      await db.govEvents.update(eventId, {
        ...action.patch,
        syncState: SYNC_STATE.SYNCED,
        pendingAction: null,
        lastError: '',
        attempts: (cur.attempts || 0) + 1,
        updatedAt: nowIso,
        timeline: [...(cur.timeline || []), successEntry, buildGovEntry('sync-ok', 'system', '已回写原流程', nowIso)]
      })
    })
    await reload()
    await reloadSourceStore(ev.kind)
    return { status: 'ok' }
  }

  // 回写原流程：返回 'ok' | 'failed'（暂时失败，可重试） | 'diverged'（源流程已分叉/删除）
  async function runWriteback(ev, action, nowIso) {
    try {
      // 纠错待办：认领/转交直接驱动纠错单状态机（状态写回）
      if (ev.kind === GOV_KIND.CORRECTION && action.type === 'claim' && ev.stage === 'claim') {
        return await writebackCorrectionClaim(ev, action)
      }
      if (ev.kind === GOV_KIND.CORRECTION && action.type === 'transfer' && ev.stage === 'revise') {
        return await writebackCorrectionTransfer(ev, action)
      }
      // 其余来源与动作：向源单据 timeline 追加「治理待办联动」留痕
      return await appendSourceTrace(ev, action.traceNote, action.actor.id, nowIso)
    } catch {
      return 'failed'
    }
  }

  // 纠错「待认领」事件的认领回写：纠错单 submitted → claimed（幂等重放安全）
  async function writebackCorrectionClaim(ev, action) {
    const t = await db.correctionTickets.get(ev.refId)
    if (!t) return 'diverged'
    if (t.status === CORRECTION.CLAIMED && t.claimedBy === action.actor.id) return 'ok' // 幂等：已由本人认领
    if (t.status !== CORRECTION.SUBMITTED) return 'diverged'
    const res = await useCorrectionStore().claimTicket(ev.refId, action.actor)
    if (res.status === 'ok') return 'ok'
    if (res.status === 'changed' || res.status === 'missing') return 'diverged'
    return 'failed'
  }

  // 纠错「待送审」事件的转交回写：原修订人释放 → 新修订人认领（支持上半步已释放的重放续跑）
  async function writebackCorrectionTransfer(ev, action) {
    const t = await db.correctionTickets.get(ev.refId)
    if (!t) return 'diverged'
    if (t.status === CORRECTION.CLAIMED && t.claimedBy === action.targetId) return 'ok' // 幂等：已转交完成
    const correction = useCorrectionStore()
    if (t.status === CORRECTION.CLAIMED && t.claimedBy === action.fromUserId) {
      const rel = await correction.releaseTicket(ev.refId, action.fromActor)
      if (rel.status !== 'ok') return rel.status === 'missing' ? 'diverged' : 'failed'
      const res = await correction.claimTicket(ev.refId, action.targetActor)
      if (res.status === 'ok') return 'ok'
      return res.status === 'missing' || res.status === 'changed' ? 'diverged' : 'failed'
    }
    if (t.status === CORRECTION.SUBMITTED) {
      // 上半步已释放（重放续跑）：直接由目标认领
      const res = await correction.claimTicket(ev.refId, action.targetActor)
      if (res.status === 'ok') return 'ok'
      return res.status === 'missing' || res.status === 'changed' ? 'diverged' : 'failed'
    }
    return 'diverged'
  }

  // 联动留痕：向源单据 timeline 追加一条治理待办动作记录（源单据已删除视为分叉）
  async function appendSourceTrace(ev, note, userId, nowIso) {
    const table = sourceTableOf(ev.kind)
    if (!table) return 'diverged'
    const entity = await table.get(ev.refId)
    if (!entity) return 'diverged'
    await table.update(ev.refId, {
      timeline: [...(entity.timeline || []), { action: 'gov', by: userId, note: note || '', at: nowIso }]
    })
    return 'ok'
  }

  // 源单据是否仍存在（同步事务内判定：回写失败挂起的待办仅在源记录彻底删除时取消）
  async function sourceExistsTx(ev) {
    const table = sourceTableOf(ev.kind)
    if (!table) return false
    return !!(await table.get(ev.refId))
  }

  // 回写后联动刷新源 store 的响应式镜像（已加载才刷新）
  async function reloadSourceStore(kind) {
    const loaders = {
      review: () => import('./review').then((m) => m.useReviewStore()),
      correction: () => import('./correction').then((m) => m.useCorrectionStore()),
      freshness: () => import('./freshness').then((m) => m.useFreshnessStore()),
      handover: () => import('./handover').then((m) => m.useHandoverStore()),
      retirement: () => import('./retirement').then((m) => m.useRetirementStore()),
      release: () => import('./release').then((m) => m.useReleaseStore())
    }
    const store = loaders[kind] ? await loaders[kind]() : null
    if (store?.loaded) await store.reload()
  }

  return {
    events, loaded, now, loadAll, reload, sorted, openEvents,
    actionableFor, pendingCountFor, overdueCount, failedCount, eventById,
    syncAll, sweepOverdue,
    claimEvent, assignEvent, transferEvent, retryEvent, cancelEvent
  }
})

// 各来源对应的源单据表（联动留痕与源记录存在性判定共用）
function sourceTableOf(kind) {
  return {
    [GOV_KIND.REVIEW]: db.reviews,
    [GOV_KIND.CORRECTION]: db.correctionTickets,
    [GOV_KIND.FRESHNESS]: db.freshnessTickets,
    [GOV_KIND.HANDOVER]: db.handovers,
    [GOV_KIND.RETIREMENT]: db.retirements,
    [GOV_KIND.RELEASE]: db.releaseGates
  }[kind] || null
}
