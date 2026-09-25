import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { db } from '@/db'
import { uid } from '@/utils/format'
import { ensureVersions, docSnapshot } from '@/utils/version'
import {
  GATE, RELEASE_STATE, IMPACT, IMPACT_TYPE, CHECK_KEY, CHECK_STATUS,
  isGateOpen, isGateBlocked,
  canSubmitGate, canConfirmGate, canWithdrawGate, canDecideGate, canRollbackGate,
  canRecheckGate, canSignOffCheck,
  normalizeImpacts, markImpactConfirmed, allImpactsConfirmed,
  markImpactsReleased, markImpactsReset, impactCounts,
  restoreConfirmedImpacts, evaluateGateChecks, mergeChecks, signOffGateCheck,
  allChecksCleared, blockingReasons, buildGateEntry
} from '@/utils/release'
import { canEditDoc, GUEST_ID, ROLE } from '@/utils/permission'
import { isGrantActive, ACCESS_PERM } from '@/utils/access'
import { shareStatus } from '@/utils/share'
import { isItemOpen } from '@/utils/handover'
import { isFreshTicketOpen } from '@/utils/freshness'
import { GAP } from '@/utils/gap'
import { isRetirementOpen, isRetirementActive } from '@/utils/retirement'
import { useKbStore } from './kb'

// 知识变更影响评估与发布门禁 store（统一治理状态机）：
// 编辑者保存新版本后「提交发布门禁」（submitGate）：
//   同事务锁定候选版本、把文档对外内容回退到门禁前已发布快照、自动关联受影响的
//   问答引用（qaCitations 命中记录）、缺口工单（gapTickets 关联/来源为本文档）与共享链接（shares），
//   并对四个治理维度做准入检查（评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）：
//   全部通过 → pending_confirm；存在阻断 → blocked，阻断原因回写门禁单与关联实体时间线；
// 责任人在外部处置阻断后「重新评估」（recheckGate：硬阻断须消除），或对软阻断维度
//   由对应责任角色「豁免」（signOffCheck：保鲜→负责人/管理员，缺口→编辑者/管理员）；
//   全部维度通过后进入 pending_confirm（负责人逐项确认影响）→ pending_approval；
// 管理员审批放行（decideGate approve；放行前再次复检，阻断若复现则退回 blocked）：候选快照回写文档、
//   追加发布版本标记、问答引用切换到新版、共享链接状态同步；
//   驳回（reject）/编辑者撤回（withdraw）：版本不发布，文档保持已发布版；
// 已放行版本管理员可回退（rollbackGate）：正文与问答引用恢复到发布前版本、链接状态还原。
// 驳回/撤回/回退后重新发起门禁：上一轮已逐项确认的影响自动恢复确认态（状态恢复）。
// 全程在门禁单 timeline、版本记录门禁标记与各影响实体上留痕。
export const useReleaseStore = defineStore('release', () => {
  const gates = ref([])
  const loaded = ref(false)

  async function loadAll() {
    if (loaded.value) return
    await reload()
    loaded.value = true
  }

  async function reload() {
    gates.value = await db.releaseGates.toArray()
  }

  const sorted = computed(() =>
    [...gates.value].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  )

  // 某文档当前在途门禁（同一文档同时只允许一个，含阻断态）
  const openByDoc = computed(() => {
    const m = {}
    for (const g of gates.value) {
      if (isGateOpen(g)) m[g.docId] = g
    }
    return m
  })
  function openGateOfDoc(docId) {
    return openByDoc.value[docId] || null
  }

  function gateById(id) {
    return gates.value.find((g) => g.id === id) || null
  }

  function gatesOfDoc(docId) {
    return gates.value
      .filter((g) => g.docId === docId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
  }

  // 准入阻断中、当前用户可处置（重新评估/豁免）的门禁
  function blockedFor(userId, role, isOwnerOf = () => false) {
    if (!userId || userId === GUEST_ID) return []
    return sorted.value.filter((g) => {
      if (!isGateBlocked(g)) return false
      const ctx = { userId, role, isOwner: isOwnerOf(g) || g.ownerId === userId }
      if (canRecheckGate(g, ctx)) return true
      return (g.checks || []).some((c) => canSignOffCheck(c, ctx))
    })
  }

  // 待我确认影响（文档拥有者视角；管理员也可确认）
  function pendingConfirmFor(userId, role) {
    return sorted.value.filter((g) => {
      if (g.status !== GATE.PENDING_CONFIRM) return false
      return role === ROLE.ADMIN || g.ownerId === userId
    })
  }

  // 待我审批放行（管理员视角）
  function pendingApprovalFor(role) {
    if (role !== ROLE.ADMIN) return []
    return sorted.value.filter((g) => g.status === GATE.PENDING_APPROVAL)
  }

  function submittedBy(userId) {
    return sorted.value.filter((g) => g.submittedBy === userId)
  }

  // 侧栏角标：准入阻断待处置 + 负责人待确认数 + （管理员）待审批数
  function pendingCountFor(userId, role) {
    return blockedFor(userId, role).length
      + pendingConfirmFor(userId, role).length
      + (role === ROLE.ADMIN ? pendingApprovalFor(role).length : 0)
  }

  // 问答产生引用时记录（QAAssistant 提问后调用）：每条命中一条，便于门禁关联受影响引用。
  // question/snippet 为冗余快照；docVersion 为提问时该文档对外版本（门禁中即旧发布版）。
  async function recordCitations({ question, keywords, cites, askedBy }) {
    if (!cites || !cites.length) return
    const now = new Date().toISOString()
    const rows = cites.slice(0, 10).map((c, i) => ({
      id: uid('cit'),
      docId: c.id,
      question: String(question || '').slice(0, 200),
      keywords: [...(keywords || [])].slice(0, 20),
      snippet: String(c.snippet || '').slice(0, 500),
      docVersion: c.citeVersion ?? null,
      askedBy: askedBy || GUEST_ID,
      score: c.score ?? 0,
      gateId: null,
      createdAt: now,
      ordinal: i
    }))
    if (rows.length) await db.qaCitations.bulkAdd(rows)
  }

  // 事务内收集门禁影响项（问答引用 / 缺口工单 / 共享链接）
  async function collectImpactsTx(docId, doc) {
    // ① 问答引用：本文档最近被引用的记录（去重到问题级：同一问题只保留最新一条）
    const citeRows = await db.qaCitations.where('docId').equals(docId).toArray()
    citeRows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    const seenQ = new Set()
    const citations = []
    for (const c of citeRows) {
      const qkey = String(c.question || '').trim()
      if (!qkey || seenQ.has(qkey)) continue
      seenQ.add(qkey)
      citations.push({
        type: IMPACT_TYPE.CITATION,
        refId: c.id,
        title: qkey,
        subtitle: '引用版本 v' + (c.docVersion ?? '?') + ' · ' + new Date(c.createdAt).toLocaleDateString('zh-CN'),
        before: { docVersion: c.docVersion ?? null }
      })
      if (citations.length >= 20) break
    }

    // ② 缺口工单：仅已解决（答案来源已回填本文档）的工单作为发布影响项；
    //    未解决工单（open/claimed/in_review）归「未解决缺口」准入检查维度，不在影响项中重复
    const ticketRows = await db.gapTickets.where('docId').equals(docId).toArray()
    const tickets = ticketRows
      .filter((t) => t.status === GAP.RESOLVED)
      .map((t) => ({
        type: IMPACT_TYPE.TICKET,
        refId: t.id,
        title: t.question,
        subtitle: '已解决 · 答案来源为本文档',
        before: { status: t.status }
      }))

    // ③ 共享链接：当前仍有效（未撤销/未过期）的链接随门禁纳入评估；记录撤销前状态供回退还原
    const shareRows = await db.shares.where('docId').equals(docId).toArray()
    const now = new Date()
    const shares = shareRows
      .filter((s) => shareStatus(s, now) === 'active')
      .map((s) => ({
        type: IMPACT_TYPE.SHARE,
        refId: s.id,
        title: s.permission === 'edit' ? '可编辑共享链接' : '只读共享链接',
        subtitle: (s.expiresAt ? '限期链接' : '永久链接'),
        before: { revokedAt: s.revokedAt || null, revokeReason: s.revokeReason || null }
      }))

    return normalizeImpacts([...citations, ...tickets, ...shares])
  }

  // 事务内收集四个治理维度的准入检查上下文
  async function collectChecksCtxTx(docId, doc) {
    const openReview = await db.reviews
      .where('docId').equals(docId)
      .filter((rv) => rv.status === 'pending').first()

    let activeFreshTicket = null
    const activeRef = doc?.freshness?.activeTicket
    if (activeRef && typeof activeRef === 'object') {
      activeFreshTicket = isFreshTicketOpen(activeRef) ? activeRef : null
    }
    if (!activeFreshTicket) {
      activeFreshTicket = await db.freshnessTickets
        .where('docId').equals(docId)
        .filter((t) => isFreshTicketOpen(t))
        .last() || null
    }

    const openGapTickets = (await db.gapTickets.where('docId').equals(docId).toArray())
      .filter((t) => t.status !== GAP.RESOLVED)

    const retireRows = await db.retirements.where('docId').equals(docId).toArray()
    const activeRetirement = retireRows.find((r) => isRetirementActive(r)) || null
    const openRetirement = retireRows.find((r) => isRetirementOpen(r)) || null
    // 本文档正作为他人在途退役的替代文档（替代链审批变动中；replacementDocId 无索引，全表过滤）
    const usedAsReplacementOpen = (await db.retirements.toArray())
      .find((r) => isRetirementOpen(r) && r.replacementDocId === docId && r.docId !== docId) || null

    return { openReview, activeFreshTicket, openGapTickets, activeRetirement, openRetirement, usedAsReplacementOpen }
  }

  // 提交发布门禁。
  // payload: { docId, note, citationIds?（额外勾选的引用，默认自动收集）, ticketIds?, shareIds? }
  // 返回 { status:'ok'|'blocked', gate } | 'guest' | 'denied' | 'missing' | 'no-change' | 'duplicate' | 'in-handover'
  async function submitGate(payload, currentUser) {
    const kb = useKbStore()
    await kb.loadAll()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.docs, db.releaseGates, db.reviews, db.accessRequests, db.shares, db.gapTickets, db.qaCitations,
      db.handovers, db.freshnessTickets, db.retirements,
      async () => {
        const doc = await db.docs.get(payload.docId)
        if (!doc) { result = { status: 'missing' }; return }
        const versions = ensureVersions(doc, now)
        const candidateVersion = versions.length
        // 责任交接流转中：批准交接会按快照校验并发变更，门禁先完成/撤回再发起
        const openHandover = await db.handovers
          .filter((h) => (h.items || []).some((i) => i.docId === doc.id && isItemOpen(i))).first()
        const dupGate = await db.releaseGates
          .where('docId').equals(doc.id)
          .filter((g) => isGateOpen(g)).first()

        // 事务内复核写入资格（与 canEditDoc 同源：拥有者/协作者/管理员/限时协作授权）
        let grant = null
        if (userId !== GUEST_ID) {
          const reqs = await db.accessRequests
            .where('docId').equals(doc.id)
            .filter((r) => r.applicantId === userId).toArray()
          grant = reqs.find((r) => isGrantActive(r) && r.grant?.permission === ACCESS_PERM.COLLAB) || null
        }
        // 评审结论不再前置拒绝：评审中由管理员发起的门禁允许建档，统一状态机以「评审结论」维度阻断
        const openReviewForLock = await db.reviews
          .where('docId').equals(doc.id)
          .filter((rv) => rv.status === 'pending').first()
        const canEdit = canEditDoc(doc, { userId, role, grant, pendingReview: openReviewForLock })
        if (!canSubmitGate(doc, { userId, role, canEditDoc: canEdit, pendingReview: openReviewForLock, openGate: dupGate })) {
          if (userId === GUEST_ID) { result = { status: 'guest' }; return }
          if (openReviewForLock) { result = { status: 'in-review' }; return }
          if (openHandover) { result = { status: 'in-handover' }; return }
          if (dupGate) { result = { status: 'duplicate', gate: dupGate }; return }
          result = { status: 'denied' }
          return
        }
        if (candidateVersion <= 1) { result = { status: 'no-change' }; return }

        // 已发布基线：门禁机制下取 doc.release.publishedSnapshot（连续门禁场景），
        // 否则取候选版本的上一个版本快照——编辑者直接保存后文档当前字段即候选内容，
        // 真正对外的「已发布版」是上一个版本的内容快照
        const prevVersion = versions[candidateVersion - 2]
        const published = doc.release?.publishedSnapshot
          ? { ...doc.release.publishedSnapshot, tagIds: [...(doc.release.publishedSnapshot.tagIds || [])] }
          : (prevVersion?.snapshot ? { ...prevVersion.snapshot, tagIds: [...(prevVersion.snapshot.tagIds || [])] } : docSnapshot(doc))
        const candidateSnap = versions[candidateVersion - 1].snapshot
        if (!candidateSnap || JSON.stringify(sortSnap(candidateSnap)) === JSON.stringify(sortSnap(published))) {
          result = { status: 'no-change' }
          return
        }

        // 自动收集影响项（问答引用 / 缺口工单 / 共享链接）
        const auto = await collectImpactsTx(doc.id, doc)
        // 调用方显式勾选/取消时按类型 refId 过滤；未传则全部采用自动结果
        let impacts = auto
        const picks = {
          [IMPACT_TYPE.CITATION]: payload.citationIds,
          [IMPACT_TYPE.TICKET]: payload.ticketIds,
          [IMPACT_TYPE.SHARE]: payload.shareIds
        }
        const hasPicks = Object.values(picks).some((arr) => Array.isArray(arr))
        if (hasPicks) {
          impacts = auto.filter((it) => {
            const arr = picks[it.type]
            return Array.isArray(arr) ? arr.includes(it.refId) : true
          })
        }

        // 四个治理维度准入检查（评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）
        const checkCtx = await collectChecksCtxTx(doc.id, doc)
        const checks = evaluateGateChecks({ ...checkCtx, doc }, now).map((c) => (c.status === CHECK_STATUS.BLOCKED
          ? { ...c, firstBlockedAt: now, blockers: (c.blockers || []).map((b) => ({ ...b, firstMarkedAt: now })) }
          : c))
        const blocked = !allChecksCleared(checks)

        // 状态恢复：上一轮门禁（驳回/撤回/回退）中已逐项确认的影响自动恢复确认态
        const prevGate = (await db.releaseGates.where('docId').equals(doc.id).toArray())
          .filter((g) => [GATE.REJECTED, GATE.WITHDRAWN, GATE.ROLLED_BACK].includes(g.status))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
        let restoredCount = 0
        if (prevGate) {
          impacts = restoreConfirmedImpacts(impacts, prevGate.impacts, prevGate.id)
          restoredCount = impacts.filter((it) => it.restoredFromGateId === prevGate.id).length
        }

        const publishedVersion = doc.release?.publishedVersion ?? (candidateVersion - 1)
        const timeline = [buildGateEntry('submit', userId, payload.note || ('v' + candidateVersion + ' 提交发布门禁，待准入检查与影响确认'), now)]
        if (restoredCount > 0) {
          timeline.push(buildGateEntry('impact-restore', 'system', '恢复上轮门禁中已确认的 ' + restoredCount + ' 项影响（沿用上轮确认结论）', now))
        }
        if (blocked) {
          const reasons = checks.filter((c) => c.status === CHECK_STATUS.BLOCKED)
            .map((c) => c.label + '：' + (c.blockers[0]?.reason || '存在阻断'))
          timeline.push(buildGateEntry('check-blocked', 'system', reasons.join('；'), now))
        }
        const gate = {
          id: uid('gate'),
          docId: doc.id,
          docTitle: doc.title,
          status: blocked ? GATE.BLOCKED : GATE.PENDING_CONFIRM,
          version: candidateVersion,
          publishedVersion,
          submittedBy: userId,
          ownerId: doc.ownerId,
          note: String(payload.note || '').trim(),
          checks,
          impacts,
          candidateSnapshot: { ...candidateSnap, tagIds: [...(candidateSnap.tagIds || [])] },
          publishedSnapshot: published,
          restoredFromGateId: restoredCount > 0 ? prevGate.id : null,
          confirmedBy: null,
          confirmedAt: null,
          decidedBy: null,
          decidedAt: null,
          decisionNote: '',
          rolledBackBy: null,
          rolledBackAt: null,
          rollbackNote: '',
          releasedAt: null,
          createdAt: now,
          timeline
        }
        await db.releaseGates.add(gate)

        // 阻断原因回写到关联实体时间线（仅新增标记，幂等由重新评估侧的新增集合控制）
        await writeBlockerMarksTx(checks, gate, now, true)

        // 文档进入门禁中（含阻断态）：对外内容锁定为已发布快照，候选版本不提前泄露
        const releaseInfo = {
          state: RELEASE_STATE.GATED,
          activeGateId: gate.id,
          publishedVersion,
          publishedSnapshot: published,
          updatedAt: now
        }
        await db.docs.update(doc.id, { release: releaseInfo })

        // 候选版本记录打上门禁标记（版本历史中可见「准入阻断」/「待影响确认」）
        const newVersions = versions.map((v) =>
          v.version === candidateVersion
            ? { ...v, gate: { gateId: gate.id, version: candidateVersion, status: gate.status, at: now } }
            : v
        )
        await db.docs.update(doc.id, { versions: newVersions })

        result = { status: blocked ? 'blocked' : 'ok', gate }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 责任人重新评估准入状态：重新读取四个维度最新状态，硬阻断须已消除；
  // 软阻断若仍存在保持阻断（可另行豁免）；全部通过后 blocked → pending_confirm。
  async function recheckGate(gateId, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.releaseGates, db.docs, db.reviews, db.gapTickets, db.freshnessTickets, db.retirements,
      async () => {
        const gate = await db.releaseGates.get(gateId)
        if (!gate) { result = { status: 'missing' }; return }
        const doc = await db.docs.get(gate.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }
        const roleCtx = { userId, role, isOwner: doc.ownerId === userId }
        if (!canRecheckGate(gate, roleCtx)) {
          result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
          return
        }

        const ctx = await collectChecksCtxTx(gate.docId, doc)
        const nextChecks = evaluateGateChecks({ ...ctx, doc }, now)
        const { checks, newlyBlocked, clearedKeys } = mergeChecks(gate.checks, nextChecks, now)

        const timeline = [...(gate.timeline || [])]
        for (const key of clearedKeys) {
          const label = { [CHECK_KEY.REVIEW]: '评审结论', [CHECK_KEY.FRESH]: '知识保鲜', [CHECK_KEY.GAP]: '未解决缺口', [CHECK_KEY.RETIRE]: '退役关系' }[key]
          timeline.push(buildGateEntry('check-recheck', 'system', label + '维度阻断已消除', now))
        }
        for (const [key, blockers] of Object.entries(newlyBlocked)) {
          const label = { [CHECK_KEY.REVIEW]: '评审结论', [CHECK_KEY.FRESH]: '知识保鲜', [CHECK_KEY.GAP]: '未解决缺口', [CHECK_KEY.RETIRE]: '退役关系' }[key]
          timeline.push(buildGateEntry('check-blocked', 'system', label + '维度新增阻断：' + blockers.map((b) => b.reason).join('；'), now))
        }
        if (!clearedKeys.length && !Object.keys(newlyBlocked).length) {
          timeline.push(buildGateEntry('check-recheck', userId, '重新评估：仍有阻断维度未消除', now))
        }

        // 关联实体侧的阻断/消除留痕
        await writeBlockerMarksTx(checks, gate, now, true)
        await writeClearMarksTx(gate.checks, checks, gate, now)

        const cleared = allChecksCleared(checks)
        let status = gate.status
        if (cleared) {
          status = GATE.PENDING_CONFIRM
          timeline.push(buildGateEntry('check-clear', 'system', '全部准入维度通过，进入影响确认环节', now))
        }
        const updated = { ...gate, checks, status, timeline }
        await db.releaseGates.put(updated)

        // 版本门禁标记同步
        if (doc) {
          const versions = (doc.versions || []).map((v) =>
            v.gate?.gateId === gateId ? { ...v, gate: { ...v.gate, status, at: now } } : v
          )
          await db.docs.update(doc.id, { versions })
        }
        result = { status: 'ok', gate: updated, cleared, blocking: blockingReasons(updated) }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 责任人对软阻断维度做跨角色豁免（保鲜→文档负责人/管理员；缺口→编辑者/管理员）。
  // 豁免后该维度记为通过；全部维度通过则 blocked → pending_confirm。
  async function signOffCheck(gateId, checkKey, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      const doc = await db.docs.get(gate.docId)
      const roleCtx = { userId, role, isOwner: !!doc && doc.ownerId === userId }
      if (userId === GUEST_ID) { result = { status: 'guest' }; return }
      const target = (gate.checks || []).find((c) => c.key === checkKey)
      if (!canSignOffCheck(target, roleCtx)) { result = { status: 'denied' }; return }

      const checks = signOffGateCheck(gate.checks, checkKey, roleCtx, note, now)
      const timeline = [...(gate.timeline || []),
        buildGateEntry('check-signoff', userId, (target.label || checkKey) + '维度豁免放行' + (note ? '：' + String(note).trim() : ''), now)]

      const cleared = allChecksCleared(checks)
      let status = gate.status
      if (cleared) {
        status = GATE.PENDING_CONFIRM
        timeline.push(buildGateEntry('check-clear', 'system', '全部准入维度通过（含责任人豁免），进入影响确认环节', now))
      }
      const updated = { ...gate, checks, status, timeline }
      await db.releaseGates.put(updated)

      if (doc) {
        const versions = (doc.versions || []).map((v) =>
          v.gate?.gateId === gateId ? { ...v, gate: { ...v.gate, status, at: now } } : v
        )
        await db.docs.update(doc.id, { versions })
      }
      result = { status: 'ok', gate: updated, cleared }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 负责人逐项确认影响
  async function confirmImpact(gateId, impactKey, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!canConfirmGate(gate, doc, userId, role)) { result = { status: 'denied' }; return }
      const item = (gate.impacts || []).find((it) => it.key === impactKey)
      if (!item) { result = { status: 'no-impact' }; return }
      if (item.status !== IMPACT.PENDING) { result = { status: 'changed' }; return }
      const impacts = markImpactConfirmed(gate.impacts, impactKey, userId, now)
      await db.releaseGates.put({
        ...gate,
        impacts,
        timeline: [...(gate.timeline || []), buildGateEntry('impact-confirm-item', userId, '确认影响：' + item.title, now)]
      })
      result = { status: 'ok' }
    })

    await reload()
    return result
  }

  // 负责人整体确认影响 → 待管理员审批（要求全部影响项已逐项确认；无影响项可直接确认）
  async function confirmGate(gateId, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      const doc = await db.docs.get(gate.docId)
      if (!canConfirmGate(gate, doc, userId, role)) { result = { status: 'denied' }; return }
      if (!allImpactsConfirmed(gate.impacts)) { result = { status: 'unconfirmed' }; return }
      const confirmed = {
        ...gate,
        status: GATE.PENDING_APPROVAL,
        confirmedBy: userId,
        confirmedAt: now,
        timeline: [...(gate.timeline || []), buildGateEntry('impact-confirm-all', userId, note || '负责人已确认全部影响，提交管理员审批', now)]
      }
      await db.releaseGates.put(confirmed)
      // 版本门禁标记推进到待审批
      if (doc) {
        const versions = (doc.versions || []).map((v) =>
          v.gate?.gateId === gateId ? { ...v, gate: { ...v.gate, status: GATE.PENDING_APPROVAL, at: now } } : v
        )
        await db.docs.update(doc.id, { versions })
      }
      result = { status: 'ok', gate: confirmed }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 编辑者撤回门禁（阻断态 / 确认前 / 待审批均可）
  async function withdrawGate(gateId, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    const role = currentUser?.role || null
    let result = { status: 'error' }

    await db.transaction('rw', db.releaseGates, db.docs, async () => {
      const gate = await db.releaseGates.get(gateId)
      if (!gate) { result = { status: 'missing' }; return }
      if (!canWithdrawGate(gate, userId, role)) { result = { status: 'denied' }; return }
      const withdrawn = {
        ...gate,
        status: GATE.WITHDRAWN,
        impacts: markImpactsReset(gate.impacts, false),
        timeline: [...(gate.timeline || []), buildGateEntry('withdraw', userId, '', now)]
      }
      await db.releaseGates.put(withdrawn)
      await clearDocGateTx(gate, now)
      result = { status: 'ok', gate: withdrawn }
    })

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 管理员审批：approve 放行发布 / reject 驳回
  async function decideGate(gateId, decision, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.releaseGates, db.docs, db.shares, db.gapTickets, db.qaCitations,
      db.reviews, db.freshnessTickets, db.retirements,
      async () => {
        const gate = await db.releaseGates.get(gateId)
        if (!gate) { result = { status: 'missing' }; return }
        if (!canDecideGate(gate, userId, currentUser?.role)) {
          result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
          return
        }
        const doc = await db.docs.get(gate.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }

        if (decision === 'reject') {
          const rejected = {
            ...gate,
            status: GATE.REJECTED,
            decidedBy: userId,
            decidedAt: now,
            decisionNote: String(note || '').trim(),
            impacts: markImpactsReset(gate.impacts, false),
            timeline: [...(gate.timeline || []), buildGateEntry('reject', userId, note, now)]
          }
          await db.releaseGates.put(rejected)
          await clearDocGateTx(gate, now, GATE.REJECTED)
          result = { status: 'ok', gate: rejected, approved: false }
          return
        }

        // ---- 放行前最终复检：流转期间可能新出现阻断（如保鲜到点、被纳入他人退役替代链）----
        const ctx = await collectChecksCtxTx(gate.docId, doc)
        const nextChecks = evaluateGateChecks({ ...ctx, doc }, now)
        const { checks, newlyBlocked } = mergeChecks(gate.checks, nextChecks, now)
        if (!allChecksCleared(checks)) {
          const timeline = [...(gate.timeline || [])]
          for (const [key, blockers] of Object.entries(newlyBlocked)) {
            const label = { [CHECK_KEY.REVIEW]: '评审结论', [CHECK_KEY.FRESH]: '知识保鲜', [CHECK_KEY.GAP]: '未解决缺口', [CHECK_KEY.RETIRE]: '退役关系' }[key]
            timeline.push(buildGateEntry('check-blocked', 'system', '放行前复检发现新阻断（' + label + '）：' + blockers.map((b) => b.reason).join('；'), now))
          }
          if (!Object.keys(newlyBlocked).length) {
            timeline.push(buildGateEntry('check-blocked', 'system', '放行前复检未通过：仍有准入阻断维度', now))
          }
          const bounced = { ...gate, status: GATE.BLOCKED, checks, timeline }
          await db.releaseGates.put(bounced)
          await writeBlockerMarksTx(checks, gate, now, true)
          const versions = (doc.versions || []).map((v) =>
            v.gate?.gateId === gateId ? { ...v, gate: { ...v.gate, status: GATE.BLOCKED, at: now } } : v
          )
          await db.docs.update(doc.id, { versions })
          result = { status: 'blocked', gate: bounced, blocking: blockingReasons(bounced) }
          return
        }

        // ---- 放行发布：回写候选快照 → 文档对外可见；问答引用切新版；共享链接状态同步 ----
        const snap = gate.candidateSnapshot
        // ① 文档字段回写候选版本，解除门禁；已发布快照即候选内容
        const releaseInfo = {
          state: RELEASE_STATE.NORMAL,
          activeGateId: null,
          publishedVersion: gate.version,
          publishedSnapshot: { ...snap, tagIds: [...(snap.tagIds || [])] },
          updatedAt: now
        }
        // ② 问答引用：门禁发起时关联的引用记录 docVersion 切换到新版本，打上放行标记
        const releasedCitationIds = []
        for (const it of gate.impacts || []) {
          if (it.type !== IMPACT_TYPE.CITATION) continue
          const c = await db.qaCitations.get(it.refId)
          if (!c) continue
          await db.qaCitations.update(c.id, {
            docVersion: gate.version,
            gateId: gate.id,
            gateReleasedAt: now
          })
          releasedCitationIds.push(c.id)
        }
        // 门禁期间新产生的引用（指向旧发布版）也一并切到新版，保证放行后问答一致
        const otherCites = await db.qaCitations
          .where('docId').equals(doc.id)
          .filter((c) => (c.docVersion ?? 0) < gate.version).toArray()
        for (const c of otherCites) {
          if (releasedCitationIds.includes(c.id)) continue
          await db.qaCitations.update(c.id, { docVersion: gate.version, gateId: gate.id, gateReleasedAt: now })
          releasedCitationIds.push(c.id)
        }

        // ③ 缺口工单：门禁放行不改工单状态，仅记录其答案来源已随新版发布（timeline 留痕）
        const releasedTicketIds = []
        for (const it of gate.impacts || []) {
          if (it.type !== IMPACT_TYPE.TICKET) continue
          const t = await db.gapTickets.get(it.refId)
          if (!t) continue
          await db.gapTickets.update(t.id, {
            timeline: [...(t.timeline || []), buildGateEntry('version-publish', userId, '关联文档《' + gate.docTitle + '》v' + gate.version + ' 经发布门禁放行，答案来源已指向新版', now)]
          })
          releasedTicketIds.push(t.id)
        }

        // ④ 共享链接：门禁期间链接对访客呈现已发布旧版；放行后链接自然指向新版（链接本身保持有效），
        //    逐条标记已同步发布版本，便于门禁单回写链接状态并留痕
        const syncedShareIds = []
        for (const it of gate.impacts || []) {
          if (it.type !== IMPACT_TYPE.SHARE) continue
          const s = await db.shares.get(it.refId)
          if (!s) continue
          await db.shares.update(s.id, { gateId: gate.id, gateVersion: gate.version, gateSyncedAt: now })
          syncedShareIds.push(s.id)
        }

        const updatedDoc = {
          ...doc,
          ...snap,
          visibility: snap.visibility,
          updatedAt: now,
          release: releaseInfo,
          lastReleaseGate: { gateId: gate.id, status: GATE.RELEASED, version: gate.version, by: userId, at: now }
        }
        // ⑤ 版本记录门禁标记 → 已放行
        updatedDoc.versions = ensureVersions(updatedDoc, now).map((v) =>
          v.version === gate.version
            ? { ...v, gate: { gateId: gate.id, version: gate.version, status: GATE.RELEASED, at: now, releasedBy: userId } }
            : v
        )
        await db.docs.put(updatedDoc)

        const counts = impactCounts(gate.impacts)
        const released = {
          ...gate,
          checks,
          status: GATE.RELEASED,
          decidedBy: userId,
          decidedAt: now,
          decisionNote: String(note || '').trim(),
          releasedAt: now,
          impacts: markImpactsReleased(gate.impacts, (it) => {
            if (it.type === IMPACT_TYPE.CITATION) return { releasedAt: now, docVersion: gate.version }
            if (it.type === IMPACT_TYPE.SHARE) return { syncedAt: now }
            return { releasedAt: now }
          }),
          effects: { releasedCitationIds, releasedTicketIds, syncedShareIds },
          timeline: [
            ...(gate.timeline || []),
            buildGateEntry('approve', userId, note, now),
            buildGateEntry('version-publish', userId, 'v' + gate.version + ' 发布，问答引用 ' + releasedCitationIds.length + ' 条切换至新版', now),
            buildGateEntry('share-sync', userId, '共享链接 ' + syncedShareIds.length + ' 条状态已同步（' + counts.share + ' 条纳入评估）', now)
          ]
        }
        await db.releaseGates.put(released)
        result = { status: 'ok', gate: released, approved: true }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 回退已放行版本：正文/问答引用恢复到门禁前发布版，链接状态还原
  async function rollbackGate(gateId, note, currentUser) {
    const kb = useKbStore()
    await loadAll()
    const now = new Date().toISOString()
    const userId = currentUser?.id || GUEST_ID
    let result = { status: 'error' }

    await db.transaction(
      'rw',
      db.releaseGates, db.docs, db.shares, db.gapTickets, db.qaCitations,
      async () => {
        const gate = await db.releaseGates.get(gateId)
        if (!gate) { result = { status: 'missing' }; return }
        if (!canRollbackGate(gate, userId, currentUser?.role)) {
          result = userId === GUEST_ID ? { status: 'guest' } : { status: 'denied' }
          return
        }
        const doc = await db.docs.get(gate.docId)
        if (!doc) { result = { status: 'doc-missing' }; return }

        const snap = gate.publishedSnapshot
        // ① 文档正文回退到门禁前发布版（保留版本历史，被回退版本打标）
        const restoredInfo = {
          state: RELEASE_STATE.NORMAL,
          activeGateId: null,
          publishedVersion: gate.publishedVersion,
          publishedSnapshot: { ...snap, tagIds: [...(snap.tagIds || [])] },
          updatedAt: now
        }
        // ② 问答引用恢复旧版本号（仅还原本门禁切换过、且当前仍指向新版本的记录）
        const restoredCitationIds = []
        for (const cid of gate.effects?.releasedCitationIds || []) {
          const c = await db.qaCitations.get(cid)
          if (!c || c.gateId !== gate.id || c.docVersion !== gate.version) continue
          await db.qaCitations.update(c.id, { docVersion: gate.publishedVersion, gateRolledBackAt: now })
          restoredCitationIds.push(c.id)
        }
        // ③ 缺口工单留痕（不改状态/来源）
        const restoredTicketIds = []
        for (const tid of gate.effects?.releasedTicketIds || []) {
          const t = await db.gapTickets.get(tid)
          if (!t) continue
          await db.gapTickets.update(t.id, {
            timeline: [...(t.timeline || []), buildGateEntry('version-revert', userId, '关联文档《' + gate.docTitle + '》v' + gate.version + ' 已被管理员回退，问答引用恢复 v' + gate.publishedVersion, now)]
          })
          restoredTicketIds.push(t.id)
        }
        // ④ 共享链接：清除本次发布同步标记（链接仍有效，访问内容随文档回退自动恢复旧版）
        const restoredShareIds = []
        for (const sid of gate.effects?.syncedShareIds || []) {
          const s = await db.shares.get(sid)
          if (!s || s.gateId !== gate.id) continue
          await db.shares.update(s.id, { gateId: null, gateVersion: null, gateSyncedAt: null, gateRolledBackAt: now })
          restoredShareIds.push(s.id)
        }

        const updatedDoc = {
          ...doc,
          ...snap,
          visibility: snap.visibility,
          updatedAt: now,
          release: restoredInfo,
          lastReleaseGate: { gateId: gate.id, status: GATE.ROLLED_BACK, version: gate.version, by: userId, at: now }
        }
        updatedDoc.versions = ensureVersions(updatedDoc, now).map((v) =>
          v.version === gate.version
            ? { ...v, gate: { ...(v.gate || {}), gateId: gate.id, version: gate.version, status: GATE.ROLLED_BACK, at: now, rolledBackBy: userId } }
            : v
        )
        await db.docs.put(updatedDoc)

        const rolledBack = {
          ...gate,
          status: GATE.ROLLED_BACK,
          rolledBackBy: userId,
          rolledBackAt: now,
          rollbackNote: String(note || '').trim(),
          impacts: markImpactsReset(gate.impacts, true),
          effects: { ...(gate.effects || {}), restoredCitationIds, restoredTicketIds, restoredShareIds },
          timeline: [
            ...(gate.timeline || []),
            buildGateEntry('rollback', userId, note, now),
            buildGateEntry('version-revert', userId, '问答引用 ' + restoredCitationIds.length + ' 条恢复至 v' + gate.publishedVersion, now),
            buildGateEntry('share-restore', userId, '共享链接 ' + restoredShareIds.length + ' 条状态已还原', now)
          ]
        }
        await db.releaseGates.put(rolledBack)
        result = { status: 'ok', gate: rolledBack, restoredCitationIds, restoredShareIds }
      }
    )

    await Promise.all([reload(), kb.reloadDocs()])
    return result
  }

  // 文档删除时清理其全部门禁（由 kb.deleteDoc 在同事务内调用）
  async function resetGatesOfDocTx(docId, now) {
    const list = await db.releaseGates.where('docId').equals(docId).toArray()
    for (const g of list) {
      if (isGateOpen(g)) {
        await db.releaseGates.update(g.id, {
          status: GATE.WITHDRAWN,
          timeline: [...(g.timeline || []), buildGateEntry('doc-delete', 'system', '关联文档已删除，门禁关闭', now)]
        })
      }
    }
  }

  return {
    gates, loaded, loadAll, reload, sorted,
    openGateOfDoc, gateById, gatesOfDoc,
    blockedFor, pendingConfirmFor, pendingApprovalFor, submittedBy, pendingCountFor,
    recordCitations, collectImpactsTx,
    submitGate, recheckGate, signOffCheck,
    confirmImpact, confirmGate, withdrawGate, decideGate, rollbackGate,
    resetGatesOfDocTx
  }
})

// ---- 事务内工具 ----

function sortSnap(s) {
  return {
    title: s?.title || '',
    body: s?.body || '',
    categoryId: s?.categoryId ?? null,
    tagIds: [...(s?.tagIds || [])].sort(),
    visibility: s?.visibility || 'public'
  }
}

// 阻断原因回写到关联实体时间线（保鲜复核单 / 缺口工单 / 退役单）。
// 同一门禁同一 blocker 只写一次（gateBlockerMarks 记录已写集合）；评审维度不回写评审单
// （评审单有独立的审批时间线，阻断原因在门禁单内可见即可）。
// 调用方须已在写事务内。
async function writeBlockerMarksTx(checks, gate, now, _isNew) {
  const tableOf = {
    [CHECK_KEY.FRESH]: db.freshnessTickets,
    [CHECK_KEY.GAP]: db.gapTickets,
    [CHECK_KEY.RETIRE]: db.retirements
  }
  for (const check of checks || []) {
    if (check.status !== CHECK_STATUS.BLOCKED) continue
    const table = tableOf[check.key]
    if (!table) continue
    for (const b of check.blockers || []) {
      if (!b || b.id === 'due') continue
      const entity = await table.get(b.id)
      if (!entity) continue
      const already = (entity.timeline || []).some(
        (t) => t.action === 'gate-blocked' && t.gateId === gate.id
      )
      if (already) continue
      await table.update(b.id, {
        timeline: [...(entity.timeline || []), {
          action: 'gate-blocked',
          by: 'system',
          note: '《' + (gate.docTitle || '文档') + '》v' + gate.version + ' 发布门禁被「' + check.label + '」维度阻断：' + b.reason,
          at: now,
          gateId: gate.id
        }]
      })
    }
  }
}

// 阻断消除时在关联实体侧补一条消除留痕（与 writeBlockerMarksTx 配对，幂等）。
async function writeClearMarksTx(prevChecks, nextChecks, gate, now) {
  const tableOf = {
    [CHECK_KEY.FRESH]: db.freshnessTickets,
    [CHECK_KEY.GAP]: db.gapTickets,
    [CHECK_KEY.RETIRE]: db.retirements
  }
  const nextByKey = Object.fromEntries((nextChecks || []).map((c) => [c.key, c]))
  for (const prev of prevChecks || []) {
    if (prev.status !== CHECK_STATUS.BLOCKED) continue
    const next = nextByKey[prev.key]
    if (!next || next.status !== CHECK_STATUS.PASS || next.waiver) continue
    const table = tableOf[prev.key]
    if (!table) continue
    for (const b of prev.blockers || []) {
      if (!b || b.id === 'due') continue
      const entity = await table.get(b.id)
      if (!entity) continue
      const already = (entity.timeline || []).some(
        (t) => t.action === 'gate-blocked' && t.gateId === gate.id && /已消除/.test(t.note || '')
      )
      if (already) continue
      const hasMark = (entity.timeline || []).some((t) => t.action === 'gate-blocked' && t.gateId === gate.id)
      if (!hasMark) continue
      await table.update(b.id, {
        timeline: [...(entity.timeline || []), {
          action: 'gate-blocked',
          by: 'system',
          note: '《' + (gate.docTitle || '文档') + '》v' + gate.version + ' 发布门禁「' + prev.label + '」阻断已消除',
          at: now,
          gateId: gate.id,
          cleared: true
        }]
      })
    }
  }
}

// 门禁结束（驳回/撤回）时清除文档门禁标记：正文保持当前已发布版（门禁期间文档字段未回写候选，
// 这里需要把对外字段恢复为门禁前快照——候选编辑内容随驳回/撤回作废）。
// 调用方须已在写事务内。
async function clearDocGateTx(gate, now, endStatus) {
  const doc = await db.docs.get(gate.docId)
  if (!doc) return
  const versions = ensureVersions(doc, now)
  const newVersions = versions.map((v) => {
    if (v.version !== gate.version || v.gate?.gateId !== gate.id) return v
    const status = endStatus || GATE.WITHDRAWN
    const { gate: _g, ...rest } = v
    return { ...rest, gate: { gateId: gate.id, version: gate.version, status, at: now } }
  })
  // 驳回/撤回：候选内容作废，文档字段恢复到已发布快照（问答/搜索/共享访问无需再回退判断）
  const snap = gate.publishedSnapshot
  await db.docs.update(doc.id, {
    ...snap,
    visibility: snap.visibility,
    updatedAt: now,
    release: {
      state: RELEASE_STATE.NORMAL,
      activeGateId: null,
      publishedVersion: gate.publishedVersion,
      publishedSnapshot: { ...snap, tagIds: [...(snap.tagIds || [])] },
      updatedAt: now
    },
    versions: newVersions
  })
}
