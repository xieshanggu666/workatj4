// 知识治理事件与统一待办中心：状态常量、角色分派判定、SLA 与文案（均为纯函数，便于复用与测试）
// 汇聚六类治理流程的待办事件：评审审批 / 纠错认领与修订 / 保鲜整改 / 交接确认与批准 / 退役审批 / 发布门禁确认与审批。
// 事件按「类型 + 源单 + 阶段」去重（dedupeKey），按角色（admin/editor/any）或精确到人分派；
// 支持认领、释放、转交、超时升级（SLA 到期升级管理员）、失败重试、源回退重开；
// 可回写事件在待办中心一键执行原流程动作（审批/认领/确认/放行），原流程状态同步回写。
import { ROLE, canEditContent, isGuestUser } from './permission'

// 事件类型（六类治理流程）
export const GOV_TYPE = {
  REVIEW: 'review', // 评审审批
  CORRECTION: 'correction', // 知识纠错
  FRESHNESS: 'freshness', // 知识保鲜
  HANDOVER: 'handover', // 责任交接
  RETIREMENT: 'retirement', // 知识退役
  RELEASE: 'release' // 发布门禁
}

// 事件状态
export const GOV = {
  OPEN: 'open', // 待处理：已按角色/人员分派，等待认领或直接处理
  CLAIMED: 'claimed', // 处理中：已被认领（或转交指派到人）
  DONE: 'done', // 已完成：已回写原流程 / 源流程已推进（result 记录结论）
  CANCELLED: 'cancelled', // 已关闭：源流程撤销/退回，待办不再需要
  FAILED: 'failed' // 回写失败：执行原流程动作被源流程拒绝（并发变化/权限收回等），可重试
}

// 事件阶段（每类流程拆出的待办动作；dedupeKey 的组成部分）
export const GOV_STAGE = {
  APPROVE: 'approve', // 待审批（评审/交接批准/退役/门禁放行）
  CLAIM: 'claim', // 待认领（纠错）
  REVISE: 'revise', // 修订中（纠错，跳转处理）
  FIX: 'fix', // 待整改（保鲜，跳转处理）
  CONFIRM: 'confirm' // 待确认（交接接任者确认 / 门禁负责人确认影响）
}

// 分派角色：admin 仅管理员 / editor 编辑者及以上 / any 任何登录成员
// （assigneeId 非空时为精确到人分派，优先于角色门槛）
export const ASSIGN_ROLE = { ADMIN: 'admin', EDITOR: 'editor', ANY: 'any' }

// 各类事件的处理时限（小时）：createdAt + SLA = dueAt，超时升级管理员并标红
export const SLA_HOURS = {
  [GOV_TYPE.REVIEW]: 72,
  [GOV_TYPE.CORRECTION]: 48,
  [GOV_TYPE.FRESHNESS]: 96,
  [GOV_TYPE.HANDOVER]: 72,
  [GOV_TYPE.RETIREMENT]: 72,
  [GOV_TYPE.RELEASE]: 48
}

export function slaOf(type) {
  return SLA_HOURS[type] || 72
}

// 计算事件截止点
export function calcDueAt(type, fromIso) {
  return new Date(new Date(fromIso).getTime() + slaOf(type) * 3600 * 1000).toISOString()
}

// 去重键：同一源单的同一阶段（交接确认精确到接任者）只存在一条事件
export function dedupeKeyOf(type, refId, stage, assigneeId) {
  return type + ':' + refId + ':' + stage + (assigneeId ? ':' + assigneeId : '')
}

// 事件是否仍在待办流转中（open/claimed/failed 都需要人处理）
export function isEventOpen(ev) {
  return !!ev && (ev.status === GOV.OPEN || ev.status === GOV.CLAIMED || ev.status === GOV.FAILED)
}

// 事件是否已超时（open/claimed 且过 dueAt）
export function isEventOverdue(ev, nowIso) {
  if (!ev || !ev.dueAt) return false
  if (ev.status !== GOV.OPEN && ev.status !== GOV.CLAIMED) return false
  return new Date(ev.dueAt).getTime() <= new Date(nowIso || new Date().toISOString()).getTime()
}

// 当前用户是否满足事件的分派门槛（认领/直接处理的前置校验；store 事务内复核同源逻辑）：
// - 精确到人（assigneeId）：仅本人可处理（交接接任者/门禁负责人/纠错修订人由源流程强约束，管理员也不代办）；
// - admin：仅管理员；editor：编辑者及以上；any：任何登录成员。
export function canActOnEvent(ev, user) {
  if (!ev || !user || isGuestUser(user.id)) return false
  if (ev.assigneeId) return ev.assigneeId === user.id
  if (ev.assigneeRole === ASSIGN_ROLE.ADMIN) return user.role === ROLE.ADMIN
  if (ev.assigneeRole === ASSIGN_ROLE.EDITOR) return canEditContent(user.role)
  return true
}

// 事件是否允许转交：精确到人的事件（接任者/负责人/修订人由源流程决定）不可转交；
// 角色分派类事件可由当前处理人/管理员转交给满足角色门槛的成员
export function canTransferEvent(ev, user) {
  if (!ev || !user || isGuestUser(user.id)) return false
  if (ev.assigneeId) return false
  if (ev.status !== GOV.OPEN && ev.status !== GOV.CLAIMED) return false
  if (user.role === ROLE.ADMIN) return true
  if (ev.status === GOV.CLAIMED) return ev.claimedBy === user.id
  return canActOnEvent(ev, user)
}

// 转交目标是否满足事件角色门槛
export function canReceiveTransfer(ev, target) {
  if (!ev || !target || isGuestUser(target.id)) return false
  if (ev.assigneeRole === ASSIGN_ROLE.ADMIN) return target.role === ROLE.ADMIN
  if (ev.assigneeRole === ASSIGN_ROLE.EDITOR) return canEditContent(target.role)
  return true
}

// 事件是否为「可一键回写」型（在待办中心直接执行原流程动作）；
// 否则为「跳转处理」型（修订/整改/逐项确认需到原流程页面完成，源状态推进后事件自动闭环）
export function isActionable(ev) {
  if (!ev) return false
  return (
    (ev.type === GOV_TYPE.REVIEW && ev.stage === GOV_STAGE.APPROVE) ||
    (ev.type === GOV_TYPE.CORRECTION && ev.stage === GOV_STAGE.CLAIM) ||
    (ev.type === GOV_TYPE.HANDOVER && (ev.stage === GOV_STAGE.CONFIRM || ev.stage === GOV_STAGE.APPROVE)) ||
    (ev.type === GOV_TYPE.RETIREMENT && ev.stage === GOV_STAGE.APPROVE) ||
    (ev.type === GOV_TYPE.RELEASE && ev.stage === GOV_STAGE.APPROVE)
  )
}

// 跳转处理型事件的目标路由（前往原流程页面处理）
export function routeOf(ev) {
  if (!ev) return '/todos'
  switch (ev.type) {
    case GOV_TYPE.REVIEW: return '/reviews'
    case GOV_TYPE.CORRECTION: return '/corrections'
    case GOV_TYPE.FRESHNESS: return '/freshness'
    case GOV_TYPE.HANDOVER: return '/handover'
    case GOV_TYPE.RETIREMENT: return '/retirements'
    case GOV_TYPE.RELEASE: return '/releases'
    default: return '/todos'
  }
}

export function govTypeLabel(type) {
  return {
    review: '评审',
    correction: '纠错',
    freshness: '保鲜',
    handover: '交接',
    retirement: '退役',
    release: '发布门禁'
  }[type] || type
}

export function govTypeIcon(type) {
  return {
    review: '🧾',
    correction: '🐞',
    freshness: '🧊',
    handover: '🤝',
    retirement: '🗄',
    release: '🚦'
  }[type] || '📌'
}

export function govStageLabel(stage) {
  return {
    approve: '待审批',
    claim: '待认领',
    revise: '修订中',
    fix: '待整改',
    confirm: '待确认'
  }[stage] || stage
}

export function govStatusLabel(status) {
  return {
    open: '待处理',
    claimed: '处理中',
    done: '已完成',
    cancelled: '已关闭',
    failed: '回写失败'
  }[status] || status
}

export function govStatusCls(status) {
  return {
    open: 'st-open',
    claimed: 'st-claimed',
    done: 'st-done',
    cancelled: 'st-off',
    failed: 'st-failed'
  }[status] || ''
}

export function assignRoleLabel(ev) {
  if (!ev) return ''
  if (ev.assigneeId) return '指定到人'
  return { admin: '管理员', editor: '编辑者', any: '全员' }[ev.assigneeRole] || ev.assigneeRole
}

// 回写失败原因文案（源流程返回的 status）
export function failReasonLabel(reason) {
  return {
    changed: '源流程状态已变化（他人已处理），请刷新后确认',
    closed: '源单据已关闭',
    denied: '权限不足或处理资格已被收回',
    guest: '未登录',
    missing: '源单据不存在',
    'doc-missing': '关联文档不存在',
    'not-actionable': '该事件需前往原流程页面处理',
    unconfirmed: '仍有未确认的影响项',
    blocked: '门禁复检发现新阻断',
    error: '执行异常'
  }[reason] || reason || '未知原因'
}

// 事件 timeline 动作文案（全程留痕）
export function govTimelineLabel(action) {
  return {
    create: '汇聚生成待办',
    reopen: '源流程回退 · 待办重开',
    claim: '认领',
    release: '释放认领',
    transfer: '转交',
    complete: '一键回写完成',
    fail: '回写失败',
    retry: '失败重试',
    timeout: '超时升级管理员',
    'sync-done': '源流程已推进 · 自动闭环',
    'sync-cancel': '源流程已撤销 · 自动关闭'
  }[action] || action
}
