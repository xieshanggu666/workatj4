// 知识纠错处置闭环：状态常量、权限判定与文案（均为纯函数，便于复用与测试）
// 工单流转：submitted 待处理 → claimed 修订中 → in_review 送审中 → resolved 已解决
// 成员在文档详情/问答引用处提交错误并关联文档 → 编辑者认领并修订送审（复用评审锁定/审批通道）→
// 管理员审批通过后回写新版本、工单回填修订版本（问答引用自动指向新版）→ 原提交人可全程追踪状态；
// 评审驳回/撤回时退回修订中；异常时提交人可撤回、修订人可退回未受理；关联文档被删除时退回待处理并清空关联。
import { ROLE, canEditContent, isGuestUser } from './permission'

// 纠错单状态
export const CORRECTION = {
  SUBMITTED: 'submitted', // 待处理：成员已提交错误并关联文档
  CLAIMED: 'claimed', // 修订中：编辑者已认领，修订/关联评审中
  IN_REVIEW: 'in_review', // 送审中：已发起修订评审，等待管理员审批
  RESOLVED: 'resolved', // 已解决：审批通过，新版本已回写并恢复问答引用
  WITHDRAWN: 'withdrawn' // 已撤回：提交人异常撤单（终态，记录保留）
}

// 错误类型
export const CORRECTION_TYPES = [
  { key: 'factual', label: '事实错误' },
  { key: 'outdated', label: '内容过时' },
  { key: 'typo', label: '错别字/表述' },
  { key: 'broken', label: '链接/代码失效' },
  { key: 'other', label: '其他' }
]

export function correctionTypeLabel(type) {
  return (CORRECTION_TYPES.find((t) => t.key === type) || {}).label || type || '其他'
}

export function correctionStatusLabel(status) {
  return {
    submitted: '待处理',
    claimed: '修订中',
    in_review: '送审中',
    resolved: '已解决',
    withdrawn: '已撤回'
  }[status] || status
}

export function correctionStatusCls(status) {
  return {
    submitted: 'st-submitted',
    claimed: 'st-claimed',
    in_review: 'st-review',
    resolved: 'st-resolved',
    withdrawn: 'st-withdrawn'
  }[status] || ''
}

// 纠错单是否仍在处置流转中（撤回/已解决为终态）
export function isCorrectionOpen(ticket) {
  return !!ticket && ticket.status !== CORRECTION.RESOLVED && ticket.status !== CORRECTION.WITHDRAWN
}

// 提交纠错：任何登录成员（含只读）均可，访客不可——纠错单会进入认领/审批流程，必须有明确责任人
export function canCreateCorrection(user) {
  return !!user && !isGuestUser(user?.id) && !!user?.role
}

// 认领：编辑者/管理员，且纠错单处于待处理
export function canClaimCorrection(role, ticket) {
  return !!ticket && ticket.status === CORRECTION.SUBMITTED && canEditContent(role)
}

// 是否为当前修订人（认领人本人或管理员）
export function isCorrectionOwner(ticket, userId, role) {
  return !!ticket && (ticket.claimedBy === userId || role === ROLE.ADMIN)
}

// 取消认领（退回待处理）：修订中、且为修订人
export function canReleaseCorrection(role, ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.CLAIMED && isCorrectionOwner(ticket, userId, role)
}

// 修订送审：修订中且为修订人
export function canSubmitCorrectionReview(role, ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.CLAIMED && isCorrectionOwner(ticket, userId, role)
}

// 提交人撤回纠错单（异常撤单）：
// - 待处理：提交人本人可直接撤回（尚未有人投入修订）；
// - 修订中：仅修订人尚未实际送审，允许提交人撤回，避免错误举报长时间挂起；
// - 送审中：评审单已在管理员审批通道，需先由修订人撤回评审再撤单（这里不放行，由 UI 引导）。
// 管理员可代为撤回任意在途纠错单（治理兜底）。
export function canWithdrawCorrection(ticket, user) {
  if (!ticket || !user || isGuestUser(user.id)) return false
  if (user.role === ROLE.ADMIN) return isCorrectionOpen(ticket)
  if (ticket.createdBy !== user.id) return false
  return ticket.status === CORRECTION.SUBMITTED || ticket.status === CORRECTION.CLAIMED
}

// 修订人把纠错单退回提交人补充信息（修订中 → 待处理，解除认领关系）：
// 错误描述不清、无法复现等异常情况下使用，提交人补充后可再被认领
export function canReturnCorrection(role, ticket, userId) {
  return !!ticket && ticket.status === CORRECTION.CLAIMED &&
    (ticket.claimedBy === userId || role === ROLE.ADMIN) && canEditContent(role)
}

// 纠错单处理记录的动作文案（timeline 全程保留）
export function correctionTimelineLabel(action) {
  return {
    create: '提交错误',
    claim: '认领修订',
    release: '取消认领',
    return: '退回补充信息',
    submit: '修订送审',
    resolve: '审批通过 · 回写新版本',
    reject: '评审驳回 · 退回修订',
    withdraw: '撤回纠错',
    'review-withdraw': '撤回复审 · 退回修订',
    reset: '关联文档已删除'
  }[action] || action
}
