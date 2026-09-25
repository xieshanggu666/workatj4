// 知识变更影响评估与发布门禁：状态常量、统一治理状态机、门禁/发布判定、影响项状态、权限判定与留痕工具（均为纯函数，便于测试）
// 流程：编辑者保存新版本后发起门禁 →
// 统一治理状态机先对四个维度做准入检查（评审结论 / 知识保鲜 / 未解决缺口 / 退役关系）：
//   全部通过 → 待负责人确认影响（pending_confirm）；存在阻断 → blocked，阻断原因回写门禁单与关联实体，
//   责任人可在外部处置后「重新评估」（硬阻断须消除），或对可豁免维度由对应角色跨角色「豁免放行」；
// 负责人（文档拥有者）逐项确认影响并整体确认 → 管理员审批放行（released：版本发布、引用与链接状态回写）
// / 驳回（rejected：退回编辑者）→ 已放行版本可由管理员回退（rolled_back：版本回退、引用/链接状态还原）。
// 门禁流转中（blocked / pending_confirm / pending_approval）候选版本不对问答/搜索/共享访问暴露，
// 对外内容一律为门禁发起时锁定的「已发布版」（doc.release.publishedSnapshot）。
// 驳回/撤回/回退后重新发起门禁时，上一轮已逐项确认的影响自动恢复确认态（状态恢复）。
import { ROLE, isGuestUser } from './permission'
import { buildTimelineEntry } from './review'
import { FRESH, isFreshDue, isFreshnessEnabled, isFreshTicketOpen } from './freshness'
import { GAP } from './gap'
import { RETIRE, isRetirementActive, isRetirementOpen } from './retirement'

// 门禁单状态
export const GATE = {
  BLOCKED: 'blocked', // 准入阻断：统一治理检查存在未消除的阻断维度，需外部处置后重新评估或由责任人豁免
  PENDING_CONFIRM: 'pending_confirm', // 待负责人确认影响：编辑者已提交并关联影响项，治理检查全部通过
  PENDING_APPROVAL: 'pending_approval', // 待管理员审批：负责人已确认影响
  RELEASED: 'released', // 已放行：版本已发布，问答引用切换、链接状态同步
  REJECTED: 'rejected', // 已驳回：管理员审批不通过，版本不发布，编辑者可修改后重新发起
  WITHDRAWN: 'withdrawn', // 已撤回：编辑者在审批完成前主动撤回
  ROLLED_BACK: 'rolled_back' // 已回退：放行后被管理员回退，版本下线
}

// 文档发布状态（挂在 doc.release.state 上）
export const RELEASE_STATE = {
  NORMAL: 'published', // 正常（最新版本即对外版本；无在途门禁）
  GATED: 'gated' // 门禁中：存在阻断/待确认/待审批门禁，对外仍展示门禁前已发布版
}

// ---- 统一治理状态机：四个准入维度 ----
// review  评审结论：存在流转中评审单（硬阻断，管理员在评审通道处置）
// fresh   知识保鲜：周期到点 / 存在流转中复核单（可由文档负责人或管理员豁免）
// gap     未解决缺口：存在待认领/处理中/送审中工单（可由编辑者或管理员豁免）
// retire  退役关系：本文档已退役/退役审批中，或正作为在途退役的替代文档（硬阻断）
export const CHECK_KEY = {
  REVIEW: 'review',
  FRESH: 'fresh',
  GAP: 'gap',
  RETIRE: 'retire'
}

export const CHECK_SEVERITY = { HARD: 'hard', SOFT: 'soft' }

// 检查维度状态：pass 通过（无阻断） / blocked 存在阻断（阻断原因在 blockers 中）
export const CHECK_STATUS = { PASS: 'pass', BLOCKED: 'blocked' }

// 维度 → 责任角色（谁能处置/豁免）与豁免级别
export const CHECK_DEF = {
  [CHECK_KEY.REVIEW]: { label: '评审结论', severity: CHECK_SEVERITY.HARD, roles: [ROLE.ADMIN] },
  [CHECK_KEY.FRESH]: { label: '知识保鲜', severity: CHECK_SEVERITY.SOFT, roles: [ROLE.ADMIN, 'owner'] },
  [CHECK_KEY.GAP]: { label: '未解决缺口', severity: CHECK_SEVERITY.SOFT, roles: [ROLE.ADMIN, ROLE.EDITOR] },
  [CHECK_KEY.RETIRE]: { label: '退役关系', severity: CHECK_SEVERITY.HARD, roles: [ROLE.ADMIN, 'owner'] }
}

// 影响项类型
export const IMPACT_TYPE = {
  CITATION: 'citation', // 问答引用：本问题的检索结果将受本次版本变更影响
  TICKET: 'ticket', // 缺口工单：以该文档为答案来源/关联文档
  SHARE: 'share' // 共享链接：访客/成员凭链接访问本文档
}

// 影响项状态（随门禁流转回写；rejected/withdrawn/rollback 后影响项回到门禁前状态）
export const IMPACT = {
  PENDING: 'pending', // 待负责人确认
  CONFIRMED: 'confirmed', // 负责人已确认该影响可接受
  RELEASED: 'released', // 门禁放行后已生效（引用切新版 / 链接同步 / 工单来源已指向新版）
  REVERTED: 'reverted' // 门禁回退后已还原到门禁前状态
}

export function gateStatusLabel(status) {
  return {
    blocked: '准入阻断',
    pending_confirm: '待负责人确认',
    pending_approval: '待管理员审批',
    released: '已放行发布',
    rejected: '已驳回',
    withdrawn: '已撤回',
    rolled_back: '已回退'
  }[status] || status
}

export function gateStatusCls(status) {
  return {
    blocked: 'st-blocked',
    pending_confirm: 'st-confirm',
    pending_approval: 'st-pending',
    released: 'st-ok',
    rejected: 'st-no',
    withdrawn: 'st-off',
    rolled_back: 'st-rollback'
  }[status] || ''
}

export function checkKeyLabel(key) {
  return CHECK_DEF[key]?.label || key
}

export function checkStatusLabel(status) {
  return { pass: '已通过', blocked: '阻断中' }[status] || status
}

export function checkRoleLabel(role) {
  if (role === 'owner') return '文档负责人'
  return { admin: '管理员', editor: '编辑者', viewer: '只读' }[role] || role
}

export function checkSeverityLabel(severity) {
  return severity === CHECK_SEVERITY.SOFT ? '可豁免' : '须消除'
}

export function impactTypeLabel(type) {
  return { citation: '问答引用', ticket: '缺口工单', share: '共享链接' }[type] || type
}

export function impactStatusLabel(status) {
  return { pending: '待确认', confirmed: '已确认', released: '已随版本发布', reverted: '已随回退还原' }[status] || status
}

// ---- 门禁流转判定 ----

// 状态字符串是否属于「流转中」（含准入阻断态）
export function isGateStatusOpen(status) {
  return status === GATE.BLOCKED || status === GATE.PENDING_CONFIRM || status === GATE.PENDING_APPROVAL
}

// 门禁是否在流转中（候选版本尚未发布，编辑锁定）
export function isGateOpen(gate) {
  return !!gate && isGateStatusOpen(gate.status)
}

// 门禁是否处于准入阻断态
export function isGateBlocked(gate) {
  return !!gate && gate.status === GATE.BLOCKED
}

// 门禁是否等待指定阶段：准入阻断 / 负责人确认 / 管理员审批
export function isGatePendingConfirm(gate) {
  return !!gate && gate.status === GATE.PENDING_CONFIRM
}
export function isGatePendingApproval(gate) {
  return !!gate && gate.status === GATE.PENDING_APPROVAL
}

// 门禁已放行（候选版本已发布；可回退）
export function isGateReleased(gate) {
  return !!gate && gate.status === GATE.RELEASED
}

// 门禁是否终态（不可再流转）
export function isGateTerminal(gate) {
  return !!gate && [GATE.RELEASED, GATE.REJECTED, GATE.WITHDRAWN, GATE.ROLLED_BACK].includes(gate.status)
}

// ---- 统一治理检查：纯函数评估 ----

export function isCheckBlocked(check) {
  return !!check && check.status === CHECK_STATUS.BLOCKED
}
export function isCheckHard(check) {
  return !!check && check.severity === CHECK_SEVERITY.HARD
}

// 维度是否可被该用户豁免：仅软阻断；管理员始终可豁免；其余按维度责任角色
// roleCtx: { userId, role, isOwner }
export function canSignOffCheck(check, roleCtx = {}) {
  if (!check || !isCheckBlocked(check)) return false
  if (!roleCtx.userId || isGuestUser(roleCtx.userId)) return false
  if (check.severity !== CHECK_SEVERITY.SOFT) return false
  if (roleCtx.role === ROLE.ADMIN) return true
  const roles = CHECK_DEF[check.key]?.roles || check.roles || []
  return roles.some((r) => (r === 'owner' ? roleCtx.isOwner : r === roleCtx.role))
}

// 是否可对门禁触发「重新评估」：发起人、文档负责人、管理员均可；
// 编辑者仅在存在缺口维度阻断时可触发（处置完自己认领的工单后复检）。
// 仅阻断态门禁可重新评估。
export function canRecheckGate(gate, roleCtx = {}) {
  if (!isGateBlocked(gate) || !roleCtx.userId || isGuestUser(roleCtx.userId)) return false
  if (gate.submittedBy === roleCtx.userId || roleCtx.role === ROLE.ADMIN || roleCtx.isOwner) return true
  if (roleCtx.role === ROLE.EDITOR && (gate.checks || []).some((c) => c.key === CHECK_KEY.GAP && isCheckBlocked(c))) return true
  return false
}

function passCheck(key, now) {
  return { key, label: CHECK_DEF[key].label, severity: CHECK_DEF[key].severity, status: CHECK_STATUS.PASS, reason: '', blockers: [], checkedAt: now, waiver: null }
}

function blockedCheck(key, blockers, now, prev) {
  return {
    key,
    label: CHECK_DEF[key].label,
    severity: CHECK_DEF[key].severity,
    status: CHECK_STATUS.BLOCKED,
    reason: blockers[0]?.reason || '',
    blockers,
    checkedAt: now,
    // 重新评估时保留责任人的未失效豁免（由 mergeChecks 决定保留/清除）
    waiver: prev?.waiver || null
  }
}

// 评审结论检查：存在流转中评审单 → 硬阻断（评审与门禁互斥，先在评审通道批准/驳回/撤回）
export function evaluateReviewCheck(openReview, now) {
  if (openReview) {
    const kindLabel = openReview.freshTicketId
      ? '保鲜复核'
      : openReview.correctionTicketId
        ? '纠错修订'
        : openReview.restoreFrom
          ? '版本恢复'
          : '内容'
    return blockedCheck(
      CHECK_KEY.REVIEW,
      [{ id: openReview.id, kind: 'review', title: kindLabel + '评审单', reason: '存在流转中的' + kindLabel + '评审单，须先由管理员审批完成或撤回评审' }],
      now
    )
  }
  return passCheck(CHECK_KEY.REVIEW, now)
}

// 知识保鲜检查：启用保鲜且周期到点，或存在流转中复核单（open/submitted/rejected）→ 软阻断
export function evaluateFreshCheck(doc, activeTicket, now, atDate) {
  const at = atDate || new Date(now)
  if (isFreshTicketOpen(activeTicket)) {
    const t = activeTicket
    const reasonMap = {
      [FRESH.OPEN]: '保鲜复核单待整改，问答引用已暂停；请完成修订送审或由负责人/管理员豁免',
      [FRESH.SUBMITTED]: '保鲜修订已送审，等待管理员复核通过；通过后本阻断自动消除，或由负责人/管理员豁免',
      [FRESH.REJECTED]: '保鲜修订被驳回待整改；请修订后重新送审，或由负责人/管理员豁免'
    }
    return blockedCheck(
      CHECK_KEY.FRESH,
      [{ id: t.id, kind: 'fresh', title: '第 ' + (t.round || 1) + ' 轮保鲜复核', reason: reasonMap[t.status] || reasonMap[FRESH.OPEN] }],
      now
    )
  }
  if (isFreshnessEnabled(doc) && isFreshDue(doc, at)) {
    return blockedCheck(
      CHECK_KEY.FRESH,
      [{ id: 'due', kind: 'fresh', title: '复核周期已到点', reason: '保鲜复核周期已到点（尚未生成复核单），请先完成保鲜复核，或由文档负责人/管理员豁免' }],
      now
    )
  }
  return passCheck(CHECK_KEY.FRESH, now)
}

// 未解决缺口检查：本文档关联的非已解决工单（open/claimed/in_review）→ 软阻断
export function evaluateGapCheck(openTickets, now) {
  const list = openTickets || []
  if (list.length) {
    const reasonOf = {
      [GAP.OPEN]: '工单待认领，发布后答案来源可能与新版内容不一致；请认领解决或由编辑者/管理员豁免',
      [GAP.CLAIMED]: '工单处理中；请完成补写并解决工单，或由编辑者/管理员豁免',
      [GAP.IN_REVIEW]: '工单关联修订正在评审中，评审通过后自动解决，或由编辑者/管理员豁免'
    }
    return blockedCheck(
      CHECK_KEY.GAP,
      list.slice(0, 20).map((t) => ({
        id: t.id,
        kind: 'gap',
        title: t.question,
        reason: reasonOf[t.status] || '工单尚未解决'
      })),
      now
    )
  }
  return passCheck(CHECK_KEY.GAP, now)
}

// 退役关系检查：
// - 本文档已生效退役 / 退役审批中 → 硬阻断（归档文档不可发布；须先撤销退役/等待审批结案）
// - 本文档正作为他人在途退役单的替代文档 → 硬阻断（替代链在审批变动中，放行会造成指向不一致）
export function evaluateRetireCheck({ activeRetirement, openRetirement, usedAsReplacementOpen }, now) {
  if (isRetirementActive(activeRetirement)) {
    return blockedCheck(
      CHECK_KEY.RETIRE,
      [{
        id: activeRetirement.id,
        kind: 'retire',
        title: '本文档已退役',
        reason: '文档处于已退役归档态，须先由发起人/管理员撤销退役、恢复文档后再发布'
      }],
      now
    )
  }
  if (isRetirementOpen(openRetirement)) {
    return blockedCheck(
      CHECK_KEY.RETIRE,
      [{
        id: openRetirement.id,
        kind: 'retire',
        title: '退役申请审批中',
        reason: '本文档的退役申请正在等待管理员审批，须待审批结案（驳回/撤销）后再发布'
      }],
      now
    )
  }
  if (isRetirementOpen(usedAsReplacementOpen)) {
    return blockedCheck(
      CHECK_KEY.RETIRE,
      [{
        id: usedAsReplacementOpen.id,
        kind: 'retire',
        title: '替代关系审批中',
        reason: '本文档正作为《' + (usedAsReplacementOpen.docTitle || '另一文档') + '》退役的替代文档且该退役在审批中，须待其结案后再发布'
      }],
      now
    )
  }
  return passCheck(CHECK_KEY.RETIRE, now)
}

// 全维度评估（纯函数）。ctx:
// { openReview, doc, activeFreshTicket, openGapTickets, activeRetirement, openRetirement, usedAsReplacementOpen, at }
export function evaluateGateChecks(ctx = {}, now = new Date().toISOString()) {
  return [
    evaluateReviewCheck(ctx.openReview, now),
    evaluateFreshCheck(ctx.doc, ctx.activeFreshTicket, now, ctx.at),
    evaluateGapCheck(ctx.openGapTickets, now),
    evaluateRetireCheck(ctx, now)
  ]
}

// 重新评估：以新一轮检查结果为准合并旧检查——
// 阻断消除 → pass（清除豁免与首次阻断时间）；仍阻断 → 保留豁免（仅当 blocker 集合仍覆盖豁免对象）与首次阻断时间；
// 返回 { checks, newlyBlocked: { [key]: blocker[] }, clearedKeys: string[] }
export function mergeChecks(prevChecks, nextChecks, now) {
  const prevByKey = Object.fromEntries((prevChecks || []).map((c) => [c.key, c]))
  const newlyBlocked = {}
  const clearedKeys = []
  const checks = nextChecks.map((nc) => {
    const prev = prevByKey[nc.key]
    if (nc.status === CHECK_STATUS.PASS) {
      if (prev && isCheckBlocked(prev)) clearedKeys.push(nc.key)
      return { ...nc, checkedAt: now }
    }
    const prevIds = new Set((prev?.blockers || []).map((b) => b.id))
    const fresh = nc.blockers.filter((b) => !prevIds.has(b.id))
    if (fresh.length || !prev || !isCheckBlocked(prev)) newlyBlocked[nc.key] = fresh.length ? fresh : nc.blockers
    // 豁免对象（单条）已不在最新阻断集合中 → 豁免随对象解除而失效；否则保留
    let waiver = prev?.waiver || null
    if (waiver && !nc.blockers.some((b) => b.id === waiver.blockerId)) waiver = null
    const firstBlockedAt = prev?.firstBlockedAt && isCheckBlocked(prev) ? prev.firstBlockedAt : now
    return {
      ...nc,
      waiver,
      firstBlockedAt,
      blockers: nc.blockers.map((b) => (prevIds.has(b.id) && prev.blockers.find((x) => x.id === b.id)?.firstMarkedAt
        ? { ...b, firstMarkedAt: prev.blockers.find((x) => x.id === b.id).firstMarkedAt }
        : { ...b, firstMarkedAt: now }))
    }
  })
  return { checks, newlyBlocked, clearedKeys }
}

// 责任人对某个软阻断维度做豁免：直接把该维度记为豁免通过（其余维度仍须通过/豁免才能整体解除阻断）。
// 返回新的 checks（不修改入参）；无权限/非软阻断/非阻断态时返回 null。
export function signOffGateCheck(checks, key, roleCtx, note, now = new Date().toISOString()) {
  const target = (checks || []).find((c) => c.key === key)
  if (!target || !canSignOffCheck(target, roleCtx)) return null
  return (checks || []).map((c) => c.key === key
    ? {
        ...c,
        status: CHECK_STATUS.PASS,
        reason: '',
        waiver: {
          by: roleCtx.userId,
          role: roleCtx.role === ROLE.ADMIN ? ROLE.ADMIN : (roleCtx.isOwner && CHECK_DEF[key].roles.includes('owner') ? 'owner' : roleCtx.role),
          blockerId: c.blockers[0]?.id || null,
          blockerTitle: c.blockers[0]?.title || '',
          note: String(note || '').trim(),
          at: now
        },
        checkedAt: now
      }
    : c)
}

// 全部维度是否均已通过（含豁免通过）
export function allChecksCleared(checks) {
  return (checks || []).every((c) => c.status === CHECK_STATUS.PASS)
}

// 当前仍阻断的维度
export function blockingChecks(gate) {
  return (gate?.checks || []).filter(isCheckBlocked)
}

// 阻断原因汇总（门禁单头部展示/回写）
export function blockingReasons(gate) {
  const out = []
  for (const c of blockingChecks(gate)) {
    for (const b of c.blockers || []) out.push({ key: c.key, ...b })
  }
  return out
}

// ---- 文档发布闸门 ----

// 文档当前是否处于发布门禁中（存在在途门禁；问答/搜索/共享访问只认已发布版）
export function isDocGated(doc, openGate) {
  if (openGate) return true
  return doc?.release?.state === RELEASE_STATE.GATED && !!doc.release?.activeGateId
}

// 文档对外（问答/搜索/共享）可见的内容快照：
// - 门禁中（含阻断态）：门禁发起时锁定的已发布快照（候选版本不提前泄露）
// - 正常：文档当前字段
// 返回 { title, body, categoryId, tagIds, visibility }（与 docSnapshot 同构）
export function publishedSnapshot(doc, openGate) {
  if (isDocGated(doc, openGate)) {
    const snap = openGate?.publishedSnapshot || doc?.release?.publishedSnapshot
    if (snap) return { title: snap.title || '', body: snap.body || '', categoryId: snap.categoryId ?? null, tagIds: [...(snap.tagIds || [])], visibility: snap.visibility || 'public' }
  }
  return {
    title: doc?.title || '',
    body: doc?.body || '',
    categoryId: doc?.categoryId ?? null,
    tagIds: [...(doc?.tagIds || [])],
    visibility: doc?.visibility || 'public'
  }
}

// 文档是否可被问答引用：门禁中的候选版本不额外阻断文档（已发布版仍可被引用），
// 这里仅表达「门禁本身不改变引用资格」；问答页仍需叠加保鲜/退役闸门。
// 引用到的具体内容版本由 citationGateVersion 决定。
export function isDocGateCitable(doc, openGate) {
  return !!doc && !!publishedSnapshot(doc, openGate)
}

// 问答引用当前应指向的版本号：
// - 存在在途门禁（含阻断态）且引用创建于门禁发起前 → 门禁基线版本（publishedVersion，旧版）
// - 门禁已放行且未回退 → 新版本（gate.version）
// - 无门禁 → null（调用方按文档最新版处理）
// citeAt: 引用产生时刻（ISO），不传时视为当前引用，门禁中一律给旧版
export function citationGateVersion(doc, gate, citeAt) {
  if (!gate) return null
  if (isGateOpen(gate)) return gate.publishedVersion
  if (isGateReleased(gate)) return gate.version
  // rejected/withdrawn/rolled_back：引用保持发布版（回退时发布版即旧版）
  return gate.publishedVersion
}

// ---- 发起 / 确认 / 审批 / 撤回 / 回退资格 ----

// 发起门禁：登录的内容编辑角色（编辑者/管理员），且对文档具备直接写入资格；
// 文档存在在途门禁、流转中评审单或责任交接时不可发起（评审结论作为准入维度仍会在
// 门禁流转期间/放行前复检，捕捉门禁过程中新发起的评审）；候选版本必须新于当前已发布版本。
// ctx: { userId, role, canEditDoc（布尔，已按拥有者/协作者/授权/共享链接/评审锁定判定）, pendingReview, openGate }
export function canSubmitGate(doc, ctx = {}) {
  if (!doc || isGuestUser(ctx.userId)) return false
  if (ctx.role !== ROLE.ADMIN && ctx.role !== ROLE.EDITOR) return false
  if (ctx.pendingReview) return false
  if (isDocGated(doc, ctx.openGate)) return false
  return ctx.canEditDoc === true
}

// 负责人确认影响：文档拥有者本人或管理员；门禁须处于「待负责人确认」（阻断态不可确认）
export function canConfirmGate(gate, doc, userId, role) {
  if (!isGatePendingConfirm(gate) || isGuestUser(userId)) return false
  if (role === ROLE.ADMIN) return true
  return !!doc && doc.ownerId === userId
}

// 编辑者撤回门禁：发起人本人（或管理员）；门禁仍在流转中（阻断/确认前/待审批均可撤回）
export function canWithdrawGate(gate, userId, role) {
  if (!isGateOpen(gate) || isGuestUser(userId)) return false
  return gate.submittedBy === userId || role === ROLE.ADMIN
}

// 管理员审批（放行/驳回）：仅管理员；门禁须处于「待管理员审批」
export function canDecideGate(gate, userId, role) {
  return isGatePendingApproval(gate) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// 回退已放行版本：仅管理员；门禁须已放行
export function canRollbackGate(gate, userId, role) {
  return isGateReleased(gate) && !isGuestUser(userId) && role === ROLE.ADMIN
}

// ---- 影响项 ----

// 去重生成影响项键（同类型同实体只保留一条）
export function impactKey(type, refId) {
  return type + ':' + refId
}

// 归一化影响项：补齐状态/快照字段，按类型去重（先入为主）
export function normalizeImpacts(items = []) {
  const map = new Map()
  for (const it of items) {
    if (!it || !it.type || !it.refId) continue
    const key = impactKey(it.type, it.refId)
    if (map.has(key)) continue
    map.set(key, {
      key,
      type: it.type,
      refId: it.refId,
      title: String(it.title || ''),
      subtitle: String(it.subtitle || ''),
      // 门禁发起时的实体状态快照，回退时据此还原（如共享链接 revokedAt/revokeReason）
      before: it.before && typeof it.before === 'object' ? it.before : null,
      status: IMPACT.PENDING,
      confirmedBy: null,
      confirmedAt: null,
      result: null
    })
  }
  return [...map.values()]
}

// 负责人逐项确认：返回新的影响项数组（不修改入参）
export function markImpactConfirmed(impacts, key, userId, now) {
  return (impacts || []).map((it) =>
    it.key === key && it.status === IMPACT.PENDING
      ? { ...it, status: IMPACT.CONFIRMED, confirmedBy: userId, confirmedAt: now }
      : it
  )
}

// 是否全部影响项均已确认（无影响项时视为确认就绪——允许「无关联影响」的门禁直接确认）
export function allImpactsConfirmed(impacts) {
  return (impacts || []).every((it) => it.status === IMPACT.CONFIRMED || it.status === IMPACT.RELEASED)
}

// 放行时影响项批量置为已生效
export function markImpactsReleased(impacts, resultOf = () => null) {
  return (impacts || []).map((it) => ({ ...it, status: IMPACT.RELEASED, result: resultOf(it) || it.result }))
}

// 回退/驳回/撤回时影响项批量还原：
// - 回退（released=true）：标记 reverted，保留确认与生效痕迹（历史门禁只读存档）；
// - 驳回/撤回（released=false）：状态回到待确认，但保留上轮确认人/时间，
//   供重新发起门禁时做「影响确认状态恢复」（restoreConfirmedImpacts）。
export function markImpactsReset(impacts, released) {
  return (impacts || []).map((it) => ({
    ...it,
    status: released ? IMPACT.REVERTED : IMPACT.PENDING
  }))
}

// 重新发起门禁时的影响状态恢复：上一轮已逐项确认（留有 confirmedBy 痕迹：confirmed/released，
// 或驳回/撤回后重置为 pending 但保留确认人，或回退后 reverted）且本轮仍收集到的
// 同键影响项自动恢复为已确认（恢复确认人/时间并标注恢复来源）；其余回到待确认。
// prevImpacts 为上一轮门禁影响项；返回新的数组（不修改入参）。
export function restoreConfirmedImpacts(impacts, prevImpacts, fromGateId) {
  const prevByKey = Object.fromEntries((prevImpacts || []).map((it) => [it.key, it]))
  return (impacts || []).map((it) => {
    const prev = prevByKey[it.key]
    if (prev && prev.confirmedBy) {
      return { ...it, status: IMPACT.CONFIRMED, confirmedBy: prev.confirmedBy, confirmedAt: prev.confirmedAt, restoredFromGateId: fromGateId }
    }
    return it
  })
}

// 影响项计数
export function impactCounts(impacts) {
  const c = { total: (impacts || []).length, citation: 0, ticket: 0, share: 0, confirmed: 0 }
  for (const it of impacts || []) {
    if (it.type === IMPACT_TYPE.CITATION) c.citation++
    if (it.type === IMPACT_TYPE.TICKET) c.ticket++
    if (it.type === IMPACT_TYPE.SHARE) c.share++
    if (it.status === IMPACT.CONFIRMED || it.status === IMPACT.RELEASED) c.confirmed++
  }
  return c
}

// ---- 问答引用影响推荐（提交门禁时自动勾选）----
// 以问题关键词对目标文档打分，命中（score>0）即视为「本次版本变更可能影响到的问答引用」。
// scoreDoc 由调用方注入（复用 utils/qa.scoreDoc），避免本模块依赖检索实现
export function suggestCitationImpacts({ questions, doc, bodyText, tagNames, scoreDoc }) {
  const out = []
  for (const q of questions || []) {
    const text = String(q.question || '').trim()
    if (!text) continue
    const kws = String(q.keywords || '')
      ? q.keywords
      : text.replace(/[？?！!。，,、；;：:]/g, ' ').trim().split(/\s+/).filter(Boolean)
    const score = scoreDoc(doc, kws, tagNames || [], bodyText || '')
    if (score > 0) {
      out.push({
        type: IMPACT_TYPE.CITATION,
        refId: q.id,
        title: text,
        subtitle: q.subtitle || ('最近提问：' + (q.askedBy || '团队成员'))
      })
    }
  }
  return out
}

// ---- 版本记录上的门禁标记 ----
export function versionGateBadge(v) {
  if (!v?.gate) return null
  const g = v.gate
  if (g.status === GATE.RELEASED) return { text: '门禁放行 v' + g.version, cls: 'ok', gateId: g.gateId }
  if (g.status === GATE.BLOCKED) return { text: '准入阻断', cls: 'blocked', gateId: g.gateId }
  if (g.status === GATE.PENDING_CONFIRM) return { text: '待影响确认', cls: 'confirm', gateId: g.gateId }
  if (g.status === GATE.PENDING_APPROVAL) return { text: '待审批放行', cls: 'wait', gateId: g.gateId }
  if (g.status === GATE.REJECTED) return { text: '门禁驳回', cls: 'no', gateId: g.gateId }
  if (g.status === GATE.WITHDRAWN) return { text: '门禁撤回', cls: 'off', gateId: g.gateId }
  if (g.status === GATE.ROLLED_BACK) return { text: '已回退', cls: 'rollback', gateId: g.gateId }
  return null
}

// 门禁留痕动作文案（门禁单 timeline 全程保留）
export function gateTimelineLabel(action) {
  return {
    submit: '提交发布门禁',
    'check-blocked': '准入检查阻断',
    'check-recheck': '重新评估准入状态',
    'check-clear': '阻断消除 · 进入影响确认',
    'check-signoff': '责任人豁免阻断维度',
    'impact-restore': '重新发起 · 恢复上轮已确认影响',
    'impact-confirm-item': '逐项确认影响',
    'impact-confirm-all': '整体确认影响',
    approve: '管理员审批放行',
    reject: '管理员审批驳回',
    withdraw: '撤回升版门禁',
    rollback: '管理员回退版本',
    // 放行时的联动结果
    'version-publish': '版本发布 · 问答引用切换至新版',
    'share-sync': '共享链接状态随发布同步',
    // 回退时的联动结果
    'version-revert': '版本回退 · 问答引用恢复旧版',
    'share-restore': '共享链接状态随回退还原',
    // 阻断原因回写到关联实体
    'gate-blocked': '发布门禁阻断（关联实体侧留痕）',
    'doc-delete': '关联文档已删除，门禁关闭'
  }[action] || action
}

// 构造一条门禁留痕
export function buildGateEntry(action, userId, note, now = new Date().toISOString()) {
  return buildTimelineEntry(action, userId, note, now)
}
