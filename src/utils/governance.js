// 知识治理事件与统一待办中心：状态常量、事件派生、权限判定与留痕工具（均为纯函数，便于复用与测试）
// 统一待办是六个治理流程（评审/纠错/保鲜/交接/退役/发布门禁）的投影：
// 治理引擎周期性从源单据派生「期望待办」，按 dedupeKey 去重建档、源流程推进后自动办结；
// 待办上的认领/转交/分派动作回写原流程（纠错单状态机直写 + 各源单据 timeline 追加联动留痕），
// 回写失败挂起为 failed 可重试；超出处置时限（SLA）扫描升级标记（幂等）。
import { ROLE, canEditContent, isGuestUser } from './permission'
import { REVIEW } from './review'
import { CORRECTION } from './correction'
import { FRESH } from './freshness'
import { HO_ITEM } from './handover'
import { RETIRE } from './retirement'
import { GATE } from './release'

// 治理事件来源类型
export const GOV_KIND = {
  REVIEW: 'review', // 内容评审（含保鲜/纠错/缺口/恢复送审）
  CORRECTION: 'correction', // 知识纠错
  FRESHNESS: 'freshness', // 知识保鲜复核
  HANDOVER: 'handover', // 责任交接
  RETIREMENT: 'retirement', // 知识退役
  RELEASE: 'release' // 发布门禁
}

// 待办状态
export const GOV_STATUS = {
  OPEN: 'open', // 待处理：已按角色/成员分派，等待认领或直达处理
  CLAIMED: 'claimed', // 已认领：处理人跟进中
  DONE: 'done', // 已办结：源流程已推进/完结，待办被源流程吸收
  CANCELLED: 'cancelled' // 已取消：管理员取消，或源记录已删除/源流程已分叉
}

// 回写原流程状态（syncState）
export const SYNC_STATE = {
  NONE: 'none', // 无需回写
  SYNCED: 'synced', // 已回写原流程
  FAILED: 'failed' // 回写失败（挂起待重试）
}

// 各来源的处置时限（SLA，小时）：在途待办超过该时限未办结即升级标记
export const SLA_HOURS = {
  [GOV_KIND.REVIEW]: 48,
  [GOV_KIND.CORRECTION]: 72,
  [GOV_KIND.FRESHNESS]: 168,
  [GOV_KIND.HANDOVER]: 72,
  [GOV_KIND.RETIREMENT]: 48,
  [GOV_KIND.RELEASE]: 24
}

// 待办是否仍在流转中
export function isGovEventOpen(ev) {
  return !!ev && (ev.status === GOV_STATUS.OPEN || ev.status === GOV_STATUS.CLAIMED)
}

// 待办是否已超时（在途且越过 SLA 到期点）
export function isGovOverdue(ev, now = new Date()) {
  return isGovEventOpen(ev) && !!ev.dueAt && new Date(ev.dueAt) <= now
}

// 认领：待处理且当前用户命中分派（指定成员 / 角色池；管理员作为治理兜底可认领任意待办）
export function canClaimEvent(ev, user) {
  if (!ev || ev.status !== GOV_STATUS.OPEN || !user || isGuestUser(user.id)) return false
  if (user.role === ROLE.ADMIN) return true
  if (ev.assigneeId) return ev.assigneeId === user.id
  return !!ev.assigneeRole && user.role === ev.assigneeRole
}

// 分派：仅管理员，且待办仍在待处理（已认领的请用转交）
export function canAssignEvent(ev, user) {
  return !!ev && ev.status === GOV_STATUS.OPEN && !!user && user.role === ROLE.ADMIN
}

// 转交：已认领待办，当前认领人或管理员可转交给其他成员
export function canTransferEvent(ev, user) {
  if (!ev || ev.status !== GOV_STATUS.CLAIMED || !user || isGuestUser(user.id)) return false
  return ev.claimedBy === user.id || user.role === ROLE.ADMIN
}

// 重试：回写失败挂起的待办，认领人/分派对象或管理员可重放回写动作
export function canRetryEvent(ev, user) {
  if (!ev || ev.syncState !== SYNC_STATE.FAILED || !ev.pendingAction || !user || isGuestUser(user.id)) return false
  if (user.role === ROLE.ADMIN) return true
  return ev.claimedBy === user.id || ev.assigneeId === user.id
}

// 取消：在途待办仅管理员可取消（源流程仍在对应中心继续流转，待办不再跟踪）
export function canCancelEvent(ev, user) {
  return isGovEventOpen(ev) && !!user && user.role === ROLE.ADMIN
}

// 转交目标校验：必须是已注册成员，且不能转交给自己；
// 纠错「待送审」事件的转交会回写纠错单认领关系，目标必须具备内容编辑角色
export function canTransferTarget(ev, target, selfId) {
  if (!target || !target.id || target.id === selfId || isGuestUser(target.id)) return false
  if (ev?.kind === GOV_KIND.CORRECTION && ev?.stage === 'revise') return canEditContent(target.role)
  return true
}

// ---- 派生：从源单据快照计算「期望待办」清单（纯函数，治理引擎据此去重建档/办结）----
// source: { reviews, corrections, freshnessTickets, handovers, retirements, gates, gapTickets, docs }
// 返回 [{ dedupeKey, kind, stage, refId, refKey, docId, docTitle, title, summary, assigneeRole, assigneeId }]
export function deriveGovEvents(source, nowIso = new Date().toISOString()) {
  const {
    reviews = [], corrections = [], freshnessTickets = [],
    handovers = [], retirements = [], gates = [], gapTickets = [], docs = []
  } = source || {}
  const docMap = Object.fromEntries(docs.map((d) => [d.id, d]))
  const docTitle = (id) => docMap[id]?.title || '（文档已删除）'
  const out = []
  const push = (ev) => out.push(ev)

  // ① 评审：待审批评审单 → 管理员角色池（保鲜/纠错/缺口/恢复送审共用评审审批通道，标注类型）
  for (const r of reviews) {
    if (r.status !== REVIEW.PENDING) continue
    let label = '内容评审'
    if (r.freshTicketId) label = '保鲜复核送审（第 ' + (r.freshRound || '?') + ' 轮）'
    else if (r.correctionTicketId) label = '纠错修订送审'
    else if (r.restoreFrom) label = '版本恢复送审（恢复至 v' + r.restoreFrom.version + '）'
    else if (gapTickets.some((t) => t.reviewId === r.id)) label = '缺口补写送审'
    push({
      dedupeKey: 'review:' + r.id + ':approve',
      kind: GOV_KIND.REVIEW,
      stage: 'approve',
      refId: r.id,
      refKey: null,
      docId: r.docId,
      docTitle: docTitle(r.docId),
      title: '待审批 · 《' + docTitle(r.docId) + '》' + label,
      summary: '提交人 ' + r.submittedBy + ' · ' + (r.submittedAt || '').slice(0, 10),
      assigneeRole: ROLE.ADMIN,
      assigneeId: null
    })
  }

  // ② 纠错：待处理 → 编辑者角色池认领；修订中 → 指定修订人送审（送审中由评审待办覆盖，不重复建档）
  for (const t of corrections) {
    if (t.status === CORRECTION.SUBMITTED) {
      push({
        dedupeKey: 'correction:' + t.id + ':claim',
        kind: GOV_KIND.CORRECTION,
        stage: 'claim',
        refId: t.id,
        refKey: null,
        docId: t.docId,
        docTitle: docTitle(t.docId),
        title: '待认领 · 《' + docTitle(t.docId) + '》错误纠错',
        summary: String(t.description || '').slice(0, 80),
        assigneeRole: ROLE.EDITOR,
        assigneeId: null
      })
    } else if (t.status === CORRECTION.CLAIMED) {
      push({
        dedupeKey: 'correction:' + t.id + ':revise',
        kind: GOV_KIND.CORRECTION,
        stage: 'revise',
        refId: t.id,
        refKey: null,
        docId: t.docId,
        docTitle: docTitle(t.docId),
        title: '待送审 · 《' + docTitle(t.docId) + '》纠错修订',
        summary: String(t.description || '').slice(0, 80),
        assigneeRole: null,
        assigneeId: t.claimedBy || null
      })
    }
  }

  // ③ 保鲜：待整改/已驳回待整改 → 文档负责人（送审中由评审待办覆盖）
  for (const t of freshnessTickets) {
    if (t.status !== FRESH.OPEN && t.status !== FRESH.REJECTED) continue
    const doc = docMap[t.docId]
    if (!doc) continue
    push({
      dedupeKey: 'freshness:' + t.id + ':revise',
      kind: GOV_KIND.FRESHNESS,
      stage: 'revise',
      refId: t.id,
      refKey: null,
      docId: t.docId,
      docTitle: doc.title,
      title: '待整改 · 《' + doc.title + '》第 ' + (t.round || '?') + ' 轮保鲜复核' + (t.status === FRESH.REJECTED ? '（已驳回）' : ''),
      summary: '复核到期 ' + (t.dueAt || '').slice(0, 10) + ' · 周期 ' + (t.cycleDays || '?') + ' 天',
      assigneeRole: null,
      assigneeId: doc.ownerId || null
    })
  }

  // ④ 交接：逐篇 —— 待接任者确认 → 指定接任者；已确认待批准 → 管理员角色池
  for (const h of handovers) {
    for (const it of h.items || []) {
      if (it.status === HO_ITEM.PENDING_CONFIRM) {
        push({
          dedupeKey: 'handover:' + h.id + ':' + it.docId + ':confirm',
          kind: GOV_KIND.HANDOVER,
          stage: 'confirm',
          refId: h.id,
          refKey: it.docId,
          docId: it.docId,
          docTitle: it.title || docTitle(it.docId),
          title: '待确认 · 《' + (it.title || docTitle(it.docId)) + '》责任交接',
          summary: '原负责人 ' + h.fromUserId + ' 发起，等待接任者确认',
          assigneeRole: null,
          assigneeId: it.toUserId || null
        })
      } else if (it.status === HO_ITEM.CONFIRMED) {
        push({
          dedupeKey: 'handover:' + h.id + ':' + it.docId + ':approve',
          kind: GOV_KIND.HANDOVER,
          stage: 'approve',
          refId: h.id,
          refKey: it.docId,
          docId: it.docId,
          docTitle: it.title || docTitle(it.docId),
          title: '待批准 · 《' + (it.title || docTitle(it.docId)) + '》责任交接转移',
          summary: '接任者 ' + (it.toUserId || '?') + ' 已确认，等待管理员批准执行',
          assigneeRole: ROLE.ADMIN,
          assigneeId: null
        })
      }
    }
  }

  // ⑤ 退役：待审批 → 管理员角色池
  for (const r of retirements) {
    if (r.status !== RETIRE.PENDING) continue
    push({
      dedupeKey: 'retirement:' + r.id + ':approve',
      kind: GOV_KIND.RETIREMENT,
      stage: 'approve',
      refId: r.id,
      refKey: null,
      docId: r.docId,
      docTitle: r.docTitle || docTitle(r.docId),
      title: '待审批 · 《' + (r.docTitle || docTitle(r.docId)) + '》退役替代',
      summary: '替代文档《' + (r.replacementTitle || '？') + '》' + (r.reason ? ' · ' + String(r.reason).slice(0, 60) : ''),
      assigneeRole: ROLE.ADMIN,
      assigneeId: null
    })
  }

  // ⑥ 发布门禁：阻断待处置/待确认影响 → 文档负责人；待审批放行 → 管理员角色池
  for (const g of gates) {
    if (g.status === GATE.BLOCKED) {
      push({
        dedupeKey: 'release:' + g.id + ':unblock',
        kind: GOV_KIND.RELEASE,
        stage: 'unblock',
        refId: g.id,
        refKey: null,
        docId: g.docId,
        docTitle: g.docTitle || docTitle(g.docId),
        title: '待处置 · 《' + (g.docTitle || docTitle(g.docId)) + '》v' + g.version + ' 发布门禁准入阻断',
        summary: '存在未消除的准入阻断维度，需处置后重新评估或豁免',
        assigneeRole: null,
        assigneeId: g.ownerId || null
      })
    } else if (g.status === GATE.PENDING_CONFIRM) {
      push({
        dedupeKey: 'release:' + g.id + ':confirm',
        kind: GOV_KIND.RELEASE,
        stage: 'confirm',
        refId: g.id,
        refKey: null,
        docId: g.docId,
        docTitle: g.docTitle || docTitle(g.docId),
        title: '待确认 · 《' + (g.docTitle || docTitle(g.docId)) + '》v' + g.version + ' 发布影响确认',
        summary: '影响项 ' + ((g.impacts || []).length) + ' 条，待负责人逐项确认',
        assigneeRole: null,
        assigneeId: g.ownerId || null
      })
    } else if (g.status === GATE.PENDING_APPROVAL) {
      push({
        dedupeKey: 'release:' + g.id + ':approve',
        kind: GOV_KIND.RELEASE,
        stage: 'approve',
        refId: g.id,
        refKey: null,
        docId: g.docId,
        docTitle: g.docTitle || docTitle(g.docId),
        title: '待审批 · 《' + (g.docTitle || docTitle(g.docId)) + '》v' + g.version + ' 发布放行',
        summary: '负责人已确认全部影响，等待管理员审批放行',
        assigneeRole: ROLE.ADMIN,
        assigneeId: null
      })
    }
  }

  return out
}

// ---- 文案 ----

export function govKindLabel(kind) {
  return {
    review: '内容评审',
    correction: '知识纠错',
    freshness: '知识保鲜',
    handover: '责任交接',
    retirement: '知识退役',
    release: '发布门禁'
  }[kind] || kind
}

export function govKindIcon(kind) {
  return {
    review: '🧾',
    correction: '🐞',
    freshness: '🧊',
    handover: '🤝',
    retirement: '🗄',
    release: '🚦'
  }[kind] || '📋'
}

export function govStageLabel(stage) {
  return {
    approve: '审批',
    claim: '认领',
    revise: '整改/送审',
    confirm: '确认',
    unblock: '处置阻断'
  }[stage] || stage
}

export function govStatusLabel(status) {
  return { open: '待处理', claimed: '已认领', done: '已办结', cancelled: '已取消' }[status] || status
}

export function govStatusCls(status) {
  return { open: 'st-open', claimed: 'st-claimed', done: 'st-done', cancelled: 'st-off' }[status] || ''
}

export function syncStateLabel(state) {
  return { none: '无需回写', synced: '已回写原流程', failed: '回写失败' }[state] || state
}

// 待办留痕动作文案（事件 timeline 全程保留）
export function govTimelineLabel(action) {
  return {
    create: '汇聚建档',
    claim: '认领待办',
    transfer: '转交待办',
    assign: '管理员分派',
    retry: '重试回写',
    'sync-ok': '已回写原流程',
    'sync-fail': '回写原流程失败',
    overdue: '超时升级（SLA）',
    done: '源流程已推进 · 自动办结',
    cancel: '取消待办'
  }[action] || action
}

// 生成一条待办留痕
export function buildGovEntry(action, userId, note, now = new Date().toISOString()) {
  return { action, by: userId, note: note || '', at: now }
}

// 各来源对应的处置中心路由（「去处理」跳转）
export function govKindRoute(kind) {
  return {
    review: '/reviews',
    correction: '/corrections',
    freshness: '/freshness',
    handover: '/handover',
    retirement: '/retirements',
    release: '/releases'
  }[kind] || '/'
}
